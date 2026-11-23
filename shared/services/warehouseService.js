/**
 * warehouseService — everything the Warehouse Manager does at the Rabel warehouse, between the
 * collection truck and the airport truck:
 *
 *   upcoming trucks → receiving (truck QR once + every internal label once, count match)
 *   → screening → loading onto the airport truck (internal label once) → close the load
 *   and, for cancelled flights only, the holding area (hold / return to traveler / release a
 *   rebooked bag back to loading).
 *
 * Every bag status change goes through bagService; every scan through scanService.recordScan;
 * every permission through rbac. The 2-hour warehouse stage is timed per flight (amber 90 min,
 * red 120 min) on the Monitor screen.
 */
import { assertCan, scopeFilter } from '../rbac.js';
import { WINDOW, SIDE_STATUSES } from '../constants.js';
import { forecast, computeAlerts } from '../time/window.js';
import { advanceBag, holdForCancelledFlight, returnToTraveler, releaseRebookedToLoading, statusIndex } from './bagService.js';
import { audit, nowIso } from './audit.js';
import { notify } from './notify.js';
import { raiseException } from './exceptionService.js';
import { recordScan } from './scanService.js';
import { ServiceError } from './errors.js';

const norm = (s) => String(s ?? '').trim().toUpperCase();
const ms = (d) => new Date(d).getTime();
const MIN = 60e3;

/** Trip statuses that still occupy a driver/truck. */
const OPEN_TRIP = ['Dispatched', 'Loaded', 'En Route'];

/* ───────────────────────── scope helpers ───────────────────────── */

/** The warehouse this user runs. Scoped roles without one see nothing (rbac enforces it too). */
function myWarehouseId(user) { return user?.warehouse_id ?? null; }

/** @returns {object[]} bags in my warehouse (scope: warehouse) */
function myBags(state, user) { return scopeFilter(user, 'bags', state.bags); }

/** @returns {object[]} trips to/from my warehouse (scope: warehouse) */
function myTrips(state, user) { return scopeFilter(user, 'trips', state.trips); }

function findTrip(state, id, user, permission = 'trip:read') {
  const t = (state.trips || []).find((x) => x.id === id);
  if (!t) throw new ServiceError('NOT_FOUND', `Trip ${id} not found.`);
  assertCan(user, permission, t);
  return t;
}

/**
 * When a bag arrived at the warehouse. Normally stamped by completeReceiving; bags put here by the
 * seed or a migration only have their status history, so fall back to that rather than show no timer.
 * @returns {number|null} epoch ms
 */
function receivedAtMs(bag) {
  if (bag.received_at_warehouse_at) return ms(bag.received_at_warehouse_at);
  const entry = (bag.status_history || []).filter((h) => h.to === 'Received at Warehouse').pop();
  return entry?.at ? ms(entry.at) : null;
}

const flightOf = (state, bag) => state.flights.find((f) => f.id === bag.flight_id) || null;
const isCancelled = (state, bag) => flightOf(state, bag)?.status === 'Cancelled';

/** flight id → priority rank (1 = most urgent) for the next 24 h. */
function ranks(state, now) {
  return new Map(forecast(state.flights, state.bags, now).map((f) => [f.id, f.priority_rank]));
}

/**
 * Group bags by flight, most urgent flight first.
 * @returns {{ flight: object|null, priority: number, bags: object[] }[]}
 */
function byFlight(state, bags, now) {
  const r = ranks(state, now);
  const groups = new Map();
  for (const b of bags) {
    if (!groups.has(b.flight_id)) groups.set(b.flight_id, []);
    groups.get(b.flight_id).push(b);
  }
  return [...groups.entries()]
    .map(([flightId, rows]) => ({
      flight: state.flights.find((f) => f.id === flightId) || null,
      priority: r.get(flightId) ?? 99,
      bags: rows.sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.priority - b.priority || String(a.flight?.code).localeCompare(String(b.flight?.code)));
}

/* ───────────────────────── Upcoming trucks ───────────────────────── */

/**
 * Collection trucks on their way to my warehouse, plus any that have arrived and are not received
 * yet. Read-only; sorted by the most urgent flight on board.
 * @returns {{ trip: object, area: object|null, driver: object|null, truck: object|null, bags: number, priority: number, alertLevel: string|null, received: boolean }[]}
 */
export function upcomingTrucks(state, user, { now = Date.now() } = {}) {
  assertCan(user, 'trip:read');
  const r = ranks(state, now);
  return myTrips(state, user)
    .filter((t) => t.type === 'Collection' && (OPEN_TRIP.includes(t.status) || (t.status === 'Arrived' && !t.receiving?.completed_at)))
    .map((trip) => {
      const bags = trip.bag_ids.length ? state.bags.filter((b) => trip.bag_ids.includes(b.id)) : [];
      const flightIds = [...new Set(bags.map((b) => b.flight_id))];
      let alertLevel = null;
      for (const fid of flightIds) {
        for (const a of computeAlerts(now, state.flights.find((f) => f.id === fid), state.bags)) {
          if (a.level === 'red') alertLevel = 'red';
          else if (a.level === 'amber' && alertLevel !== 'red') alertLevel = 'amber';
        }
      }
      return {
        trip,
        area: state.collectionAreas.find((a) => a.id === trip.area_from) || null,
        driver: state.drivers.find((d) => d.id === trip.driver_id) || null,
        truck: state.trucks.find((t) => t.id === trip.truck_id) || null,
        bags: trip.bag_ids.length || trip.expected_count || 0,
        priority: flightIds.length ? Math.min(...flightIds.map((f) => r.get(f) ?? 99)) : 99,
        alertLevel,
        received: !!trip.receiving?.completed_at,
      };
    })
    .sort((a, b) => a.priority - b.priority || ms(a.trip.dispatched_at) - ms(b.trip.dispatched_at));
}

/* ───────────────────────── Receiving ───────────────────────── */

/** Trucks parked at the gate waiting to be received (arrived, not yet counted in). */
export function receivingQueue(state, user, opts = {}) {
  return upcomingTrucks(state, user, opts).filter((r) => r.trip.status === 'Arrived' && !r.received);
}

function receivableTrip(state, tripId, user) {
  // `trip:update` alone is not enough — Transport Staff have it for their own area's trips. Receiving
  // is the Warehouse Manager's step, so require the status they alone may set.
  assertCan(user, 'bag:advance:Received at Warehouse');
  const trip = findTrip(state, tripId, user, 'trip:update');
  if (trip.type !== 'Collection') throw new ServiceError('INVALID_STATE', 'Only a collection truck is received here.');
  if (trip.status !== 'Arrived') throw new ServiceError('INVALID_STATE', `This truck is "${trip.status}" — it has not arrived at the warehouse yet.`);
  if (trip.receiving?.completed_at) throw new ServiceError('ALREADY_RECEIVED', 'This truck has already been received.');
  return trip;
}

/**
 * One truck-QR scan opens the receiving session. The QR carries the truck id or its plate; anything
 * else is refused so bags are never counted against the wrong truck.
 * @param {{ value:string, method:string, symbology?:string, device_id?:string }} scan
 * @returns {{ ok: boolean, result: string, message: string, trip?: object }}
 */
export function startReceiving(state, tripId, scan, ctx) {
  const trip = receivableTrip(state, tripId, ctx.user);
  const truck = state.trucks.find((t) => t.id === trip.truck_id);
  const base = { step: 'WAREHOUSE_TRUCK_QR', method: scan.method, symbology: scan.symbology || 'QR', device_id: scan.device_id, raw_value: scan.value };
  const value = norm(scan.value);
  if (value !== norm(truck?.id) && value !== norm(truck?.plate_no)) {
    recordScan(state, { ...base, result: 'UNKNOWN', note: `Expected ${truck?.id || 'the arriving truck'}` }, ctx);
    return { ok: false, result: 'UNKNOWN', message: `That is not ${truck?.id || 'this truck'}'s QR code. Scan the truck parked at this bay.` };
  }
  recordScan(state, { ...base, result: 'OK' }, ctx);
  trip.receiving = trip.receiving || { started_at: nowIso(ctx), truck_scan_at: null, scanned_bag_ids: [], completed_at: null };
  trip.receiving.truck_scan_at = nowIso(ctx);
  audit(state, ctx, { action: 'warehouse.receiving_start', entity: 'Trip', entityId: trip.id, after: { truck_id: trip.truck_id, expected: trip.bag_ids.length } });
  return { ok: true, result: 'OK', message: `${truck.id} confirmed — scan each Rabel label as it comes off.`, trip };
}

/**
 * One internal-label scan per bag as it comes off the truck. Builds the received list; nothing moves
 * status until the count matches (see completeReceiving).
 * @returns {{ ok: boolean, result: string, message: string, bag?: object, scanned: number, expected: number }}
 */
export function scanBagAtWarehouse(state, tripId, scan, ctx) {
  const trip = receivableTrip(state, tripId, ctx.user);
  if (!trip.receiving?.truck_scan_at) throw new ServiceError('SCAN_TRUCK_FIRST', 'Scan the truck QR code before the bags.');
  const expected = trip.bag_ids.length;
  const value = norm(scan.value);
  const bag = state.bags.find((b) => norm(b.tag_no) === value);
  const base = {
    step: 'WAREHOUSE_INTERNAL_LABEL', method: scan.method, symbology: scan.symbology || 'CODE128', device_id: scan.device_id,
    raw_value: scan.value, bag_id: bag?.id ?? null, flight_id: bag?.flight_id ?? null, traveler_id: bag?.traveler_id ?? null,
  };
  const fail = (result, message, exception) => {
    recordScan(state, { ...base, result, note: message }, ctx);
    if (exception) {
      raiseException(state, { type: exception, severity: 'Medium', bag_id: bag?.id ?? null, flight_id: bag?.flight_id ?? null, traveler_id: bag?.traveler_id ?? null, value: String(scan.value), notes: message }, ctx);
    }
    return { ok: false, result, message, bag, scanned: trip.receiving.scanned_bag_ids.length, expected };
  };

  if (!bag) return fail('UNKNOWN', `"${scan.value}" is not a Rabel label.`, null);
  if (!trip.bag_ids.includes(bag.id)) {
    return fail('WRONG_STEP', `${bag.tag_no} was not loaded onto ${trip.truck_id} — it belongs to another truck.`, 'Count Mismatch');
  }
  if (trip.receiving.scanned_bag_ids.includes(bag.id)) return fail('DUPLICATE', `${bag.tag_no} has already been scanned off this truck.`, null);
  if (bag.status !== 'Loaded to Collection Truck') return fail('WRONG_STEP', `${bag.tag_no} is "${bag.status}" — it cannot be received here.`, null);

  trip.receiving.scanned_bag_ids.push(bag.id);
  recordScan(state, { ...base, result: 'OK' }, ctx);
  const scanned = trip.receiving.scanned_bag_ids.length;
  return { ok: true, result: 'OK', message: `${bag.tag_no} received (${scanned}/${expected}).`, bag, scanned, expected };
}

/** Expected vs scanned for the open receiving session. @returns {{ expected: object[], scanned: object[], missing: object[], ok: boolean }} */
export function receivingProgress(state, tripId, user) {
  const trip = findTrip(state, tripId, user);
  const scannedIds = trip.receiving?.scanned_bag_ids || [];
  const expected = state.bags.filter((b) => trip.bag_ids.includes(b.id));
  const scanned = expected.filter((b) => scannedIds.includes(b.id));
  const missing = expected.filter((b) => !scannedIds.includes(b.id));
  return { expected, scanned, missing, ok: expected.length > 0 && missing.length === 0 };
}

/**
 * Count match against the truck's load, then receive every bag in one step
 * (Loaded to Collection Truck → Received at Warehouse). A mismatch raises a Count Mismatch
 * exception naming the missing labels and blocks the receipt.
 * @returns {{ ok: boolean, expected: number, scanned: number, received?: number, missing?: string[], message?: string }}
 */
export function completeReceiving(state, tripId, ctx) {
  const trip = receivableTrip(state, tripId, ctx.user);
  if (!trip.receiving?.truck_scan_at) throw new ServiceError('SCAN_TRUCK_FIRST', 'Scan the truck QR code before receiving.');
  const { expected, scanned, missing } = receivingProgress(state, tripId, ctx.user);
  if (missing.length || !expected.length) {
    const labels = missing.map((b) => b.tag_no || b.id);
    raiseException(state, {
      type: 'Count Mismatch', severity: 'High', flight_id: missing[0]?.flight_id ?? null, bag_id: missing[0]?.id ?? null,
      notes: `Warehouse receiving ${trip.truck_id}: ${expected.length} bag(s) loaded, ${scanned.length} scanned off. Missing: ${labels.join(', ') || 'none — nothing was loaded'}.`,
    }, ctx);
    return {
      ok: false, expected: expected.length, scanned: scanned.length, missing: labels,
      message: `${expected.length} bag(s) came on ${trip.truck_id} but ${scanned.length} were scanned off. Find ${labels.join(', ')} before receiving.`,
    };
  }
  const at = nowIso(ctx);
  const warehouseId = myWarehouseId(ctx.user) || trip.warehouse_id;
  for (const b of scanned) {
    advanceBag(state, b.id, 'Received at Warehouse', { user: ctx.user, now: ctx.now, countMatch: true, note: `Off ${trip.truck_id}` });
    b.warehouse_id = warehouseId;
    b.received_at_warehouse_at = at;
    b.collection_trip_id = trip.id;
  }
  trip.receiving.completed_at = at;
  trip.received_at = at;
  const cancelled = scanned.filter((b) => isCancelled(state, b)).length;
  if (cancelled) {
    notify(state, { role: 'warehouse_manager', title: `${cancelled} bag(s) belong to a cancelled flight`, body: 'Move them to the holding area instead of screening.', severity: 'warning', link: '#/holding' }, ctx);
  }
  audit(state, ctx, { action: 'warehouse.receiving_complete', entity: 'Trip', entityId: trip.id, after: { received: scanned.length, cancelled } });
  return { ok: true, expected: expected.length, scanned: scanned.length, received: scanned.length };
}

/* ───────────────────────── Monitor (the 2 h warehouse stage) ───────────────────────── */

/**
 * One row per flight with bags in my warehouse: how many are at each stage, how long the oldest bag
 * has been here (amber 90 min, red 120 min) and the flight's own window alerts.
 * @returns {{ flight: object|null, priority: number, received: number, screened: number, loaded: number, held: number, inWarehouse: number, dwellMinutes: number|null, timerLevel: string|null, alerts: object[] }[]}
 */
export function monitorRows(state, user, { now = Date.now() } = {}) {
  assertCan(user, 'bag:read');
  const here = myBags(state, user).filter((b) => ['Received at Warehouse', 'Screened', 'Loaded to Airport Truck'].includes(b.status) || b.status === SIDE_STATUSES.HELD);
  return byFlight(state, here, now).map((g) => {
    const received = g.bags.filter((b) => b.status === 'Received at Warehouse').length;
    const screened = g.bags.filter((b) => b.status === 'Screened').length;
    const loaded = g.bags.filter((b) => b.status === 'Loaded to Airport Truck').length;
    const held = g.bags.filter((b) => b.status === SIDE_STATUSES.HELD).length;
    const stamps = g.bags.filter((b) => ['Received at Warehouse', 'Screened'].includes(b.status)).map(receivedAtMs).filter((t) => t != null);
    const oldest = stamps.length ? Math.min(...stamps) : null;
    const dwellMinutes = oldest == null ? null : Math.max(0, Math.round((now - oldest) / MIN));
    let timerLevel = null;
    if (dwellMinutes != null) {
      if (dwellMinutes >= WINDOW.warehouseRedMin) timerLevel = 'red';
      else if (dwellMinutes >= WINDOW.warehouseAmberMin) timerLevel = 'amber';
    }
    return { ...g, received, screened, loaded, held, inWarehouse: received + screened, dwellMinutes, timerLevel, alerts: computeAlerts(now, g.flight, state.bags) };
  });
}

/* ───────────────────────── Screening ───────────────────────── */

/**
 * Received bags waiting for screening, most urgent flight first. Cancelled-flight bags are not
 * screened — they go to the holding area — so they are excluded here.
 */
export function screeningQueue(state, user, { now = Date.now() } = {}) {
  assertCan(user, 'bag:read');
  const rows = myBags(state, user).filter((b) => b.status === 'Received at Warehouse' && !isCancelled(state, b));
  return byFlight(state, rows, now);
}

/**
 * Screened: Received at Warehouse → Screened, one or many bags at a time (no per-bag scan at this
 * step — the bags were scanned on the way in and are scanned again onto the airport truck).
 * @param {string[]} bagIds @returns {{ screened: number, skipped: {bag_id:string, reason:string}[] }}
 */
export function screenBags(state, bagIds, ctx) {
  assertCan(ctx.user, 'bag:advance:Screened');
  const ids = [...new Set(bagIds || [])];
  if (!ids.length) throw new ServiceError('NOTHING_SELECTED', 'Select the bags that have been screened.');
  const out = { screened: 0, skipped: /** @type {{bag_id:string, reason:string}[]} */ ([]) };
  for (const id of ids) {
    const bag = state.bags.find((b) => b.id === id);
    if (!bag) { out.skipped.push({ bag_id: id, reason: 'Bag not found.' }); continue; }
    if (isCancelled(state, bag)) { out.skipped.push({ bag_id: id, reason: 'Flight is cancelled — move the bag to holding.' }); continue; }
    try {
      advanceBag(state, id, 'Screened', { user: ctx.user, now: ctx.now, note: ctx.note || 'Screened at the warehouse' });
      bag.screened_at = nowIso(ctx);
      out.screened++;
    } catch (err) { out.skipped.push({ bag_id: id, reason: err.message }); }
  }
  audit(state, ctx, { action: 'warehouse.screen', entity: 'Bag', entityId: ids.join(','), after: out });
  return out;
}

/* ───────────────────────── Loading onto the airport truck ───────────────────────── */

/** Ask Transport for a truck for the airport run (the Manager dispatches it). */
export function requestAirportTruck(state, { note = '' } = {}, ctx) {
  assertCan(ctx.user, 'truck:request');
  const waiting = myBags(state, ctx.user).filter((b) => b.status === 'Screened').length;
  if (!waiting) throw new ServiceError('NOTHING_TO_LOAD', 'No screened bags are waiting for the airport.');
  const warehouseId = myWarehouseId(ctx.user);
  notify(state, {
    role: 'transport_manager', title: `Airport truck needed at ${state.warehouses.find((w) => w.id === warehouseId)?.name || 'the warehouse'}`,
    body: `${waiting} screened bag(s) are ready for the airport run.${note ? ` ${String(note).trim()}` : ''}`, severity: 'warning', link: '#/',
  }, ctx);
  audit(state, ctx, { action: 'warehouse.request_truck', entity: 'Warehouse', entityId: warehouseId || 'unknown', after: { bags: waiting }, note: String(note || '').trim() || null });
  return { bags: waiting };
}

/**
 * Screened bags waiting for the airport, plus the airport truck(s) open at my warehouse.
 * @returns {{ groups: ReturnType<typeof byFlight>, trips: object[], waiting: number }}
 */
export function loadingQueue(state, user, { now = Date.now() } = {}) {
  assertCan(user, 'bag:read');
  const rows = myBags(state, user).filter((b) => b.status === 'Screened');
  const trips = myTrips(state, user).filter((t) => t.type === 'Airport' && ['Dispatched', 'Loaded'].includes(t.status))
    .sort((a, b) => ms(a.dispatched_at) - ms(b.dispatched_at));
  return { groups: byFlight(state, rows, now), trips, waiting: rows.length };
}

function loadableTrip(state, tripId, user) {
  assertCan(user, 'bag:advance:Loaded to Airport Truck');
  const trip = findTrip(state, tripId, user, 'trip:update');
  if (trip.type !== 'Airport') throw new ServiceError('INVALID_STATE', 'Bags are loaded onto an airport truck here.');
  if (trip.status !== 'Dispatched') throw new ServiceError('INVALID_STATE', `This truck is "${trip.status}" — its load is already closed.`);
  return trip;
}

/**
 * One internal-label scan per bag as it goes onto the airport truck
 * (Screened → Loaded to Airport Truck).
 * @returns {{ ok: boolean, result: string, message: string, bag?: object, loaded: number }}
 */
export function scanBagToAirportTruck(state, tripId, scan, ctx) {
  const trip = loadableTrip(state, tripId, ctx.user);
  const value = norm(scan.value);
  const bag = state.bags.find((b) => norm(b.tag_no) === value);
  const base = {
    step: 'WAREHOUSE_LOAD_LABEL', method: scan.method, symbology: scan.symbology || 'CODE128', device_id: scan.device_id,
    raw_value: scan.value, bag_id: bag?.id ?? null, flight_id: bag?.flight_id ?? null, traveler_id: bag?.traveler_id ?? null,
  };
  const fail = (result, message, exception) => {
    recordScan(state, { ...base, result, note: message }, ctx);
    if (exception) raiseException(state, { type: exception, severity: 'Medium', bag_id: bag?.id ?? null, flight_id: bag?.flight_id ?? null, value: String(scan.value), notes: message }, ctx);
    return { ok: false, result, message, bag, loaded: trip.bag_ids.length };
  };

  if (!bag) return fail('UNKNOWN', `"${scan.value}" is not a Rabel label.`, null);
  if (trip.bag_ids.includes(bag.id)) return fail('DUPLICATE', `${bag.tag_no} is already on ${trip.truck_id}.`, null);
  if (isCancelled(state, bag)) return fail('WRONG_FLIGHT', `${bag.tag_no} belongs to cancelled flight ${flightOf(state, bag)?.code} — move it to holding.`, null);
  if (bag.status !== 'Screened') return fail('WRONG_STEP', `${bag.tag_no} is "${bag.status}" — only a screened bag goes on the airport truck.`, null);

  advanceBag(state, bag.id, 'Loaded to Airport Truck', { user: ctx.user, now: ctx.now, note: `Airport truck ${trip.truck_id}` });
  bag.airport_trip_id = trip.id;
  // The run leaves the warehouse, so the bag has no collection area to scope it by: record whose
  // truck it is on (the assigned Transport Staff) and where it is going (rbac `area` / `airport`).
  bag.airport_trip_staff_id = trip.staff_id ?? null;
  if (trip.airport_id) bag.airport_id = trip.airport_id;
  trip.bag_ids.push(bag.id);
  recordScan(state, { ...base, result: 'OK' }, ctx);
  return { ok: true, result: 'OK', message: `${bag.tag_no} loaded (${trip.bag_ids.length} on board).`, bag, loaded: trip.bag_ids.length };
}

/**
 * Close the airport truck's load. Transport Staff drive it (Phase 6: "In Transit to Airport") and the
 * Airport Coordinator is told what is coming.
 */
export function closeAirportLoad(state, tripId, ctx) {
  const trip = loadableTrip(state, tripId, ctx.user);
  if (!trip.bag_ids.length) throw new ServiceError('NOTHING_LOADED', 'Scan at least one bag onto the truck first.');
  trip.status = 'Loaded';
  trip.loaded_at = nowIso(ctx);
  const flights = [...new Set(state.bags.filter((b) => trip.bag_ids.includes(b.id)).map((b) => flightOf(state, b)?.code).filter(Boolean))];
  notify(state, { role: 'transport_manager', title: `${trip.truck_id} loaded for the airport`, body: `${trip.bag_ids.length} bag(s) — ${flights.join(', ') || 'mixed'}. Ready to depart.` }, ctx);
  notify(state, { role: 'airport_coordinator', title: `${trip.truck_id} on its way`, body: `${trip.bag_ids.length} bag(s) — ${flights.join(', ') || 'mixed'}.` }, ctx);
  audit(state, ctx, { action: 'warehouse.close_load', entity: 'Trip', entityId: trip.id, after: { bags: trip.bag_ids.length, flights } });
  return trip;
}

/* ───────────────────────── Holding area (cancelled flights only) ───────────────────────── */

/**
 * Only bags of a CANCELLED flight are stored, in a separate holding area.
 *  toHold        — cancelled-flight bags still on the main line here
 *  held          — already in holding (area + rack)
 *  awaitingRetag  — rebooked by Ops, waiting for Backend's new tag
 *  readyToRelease — re-tagged after a rebooking: release them back onto the line where they left it
 * @returns {{ toHold: object[], held: object[], awaitingRetag: object[], readyToRelease: object[] }}
 */
export function holdingQueue(state, user) {
  assertCan(user, 'bag:read');
  const mine = myBags(state, user);
  const inHoldRange = (b) => statusIndex(b.status) >= statusIndex('Checked-in') && statusIndex(b.status) <= statusIndex('Received at Airport');
  return {
    toHold: mine.filter((b) => isCancelled(state, b) && inHoldRange(b)),
    held: mine.filter((b) => b.status === SIDE_STATUSES.HELD).sort((a, b) => String(a.holding_rack).localeCompare(String(b.holding_rack))),
    awaitingRetag: mine.filter((b) => b.status === SIDE_STATUSES.REBOOKED),
    readyToRelease: mine.filter((b) => b.status === 'Tag Assigned' && !b.retag_required && (b.previous_tags || []).length
      && statusIndex(b.held_from_status || '') >= statusIndex('Received at Warehouse')),
  };
}

/**
 * Move cancelled-flight bags into the holding area (rack recorded per bag).
 * @param {string[]} bagIds @param {{ area?: string, rack?: string }} place
 */
export function holdBags(state, bagIds, place, ctx) {
  assertCan(ctx.user, 'bag:hold');
  const ids = [...new Set(bagIds || [])];
  if (!ids.length) throw new ServiceError('NOTHING_SELECTED', 'Select the bags to move to holding.');
  const rack = String(place?.rack || '').trim();
  if (!rack) throw new ServiceError('RACK_REQUIRED', 'Record which rack the bags are stored on.');
  const area = String(place?.area || '').trim() || 'Holding area';
  const out = { held: 0, skipped: /** @type {{bag_id:string, reason:string}[]} */ ([]) };
  for (const id of ids) {
    try {
      holdForCancelledFlight(state, id, { user: ctx.user, now: ctx.now, holdingArea: area, holdingRack: rack, note: `Stored on ${rack}` });
      out.held++;
    } catch (err) { out.skipped.push({ bag_id: id, reason: err.message }); }
  }
  audit(state, ctx, { action: 'warehouse.hold', entity: 'Bag', entityId: ids.join(','), after: { ...out, area, rack } });
  return out;
}

/**
 * Hand a held bag back to its traveler (ID check + signature are required by bagService).
 * @param {object} state @param {string} bagId
 * @param {{ idChecked?: boolean, signature?: string, note?: string }} proof @param {object} ctx
 */
export function returnBag(state, bagId, proof, ctx) {
  const { idChecked, signature, note } = proof || {};
  const bag = returnToTraveler(state, bagId, { user: ctx.user, now: ctx.now, idChecked, signature, note });
  notify(state, { traveler_id: bag.traveler_id, title: 'Bag returned', body: `Bag ${bag.tag_no} was handed back to you at the warehouse.` }, ctx);
  return bag;
}

/** A re-tagged rebooked bag goes back onto the line where it left it — it never left the warehouse. */
export function releaseRebooked(state, bagId, ctx) {
  const bag = releaseRebookedToLoading(state, bagId, { user: ctx.user, now: ctx.now, note: 'Released after rebooking' });
  notify(state, {
    role: 'transport_manager', title: 'Rebooked bag back on the line',
    body: bag.status === 'Screened' ? `${bag.tag_no} is screened and waiting for the next airport truck.` : `${bag.tag_no} is back in the warehouse and needs screening.`,
  }, ctx);
  return bag;
}

/* ───────────────────────── Exceptions (read-only) ───────────────────────── */

/** Open exceptions on bags in my warehouse, plus any I raised myself. Warehouse Manager cannot resolve them (Ops does). */
export function warehouseExceptions(state, user, { includeClosed = false } = {}) {
  assertCan(user, 'exception:read');
  const ids = new Set(myBags(state, user).map((b) => b.id));
  return state.exceptions
    .filter((e) => (includeClosed || e.status === 'Open') && ((e.bag_id && ids.has(e.bag_id)) || e.raised_by === user.id))
    .map((e) => ({ ...e, bag: state.bags.find((b) => b.id === e.bag_id) || null, flight: state.flights.find((f) => f.id === e.flight_id) || null }))
    .sort((a, b) => String(b.time).localeCompare(String(a.time)));
}

/* ───────────────────────── Dashboard summary ───────────────────────── */

/** Tile numbers for the Monitor header. */
export function warehouseSummary(state, user, { now = Date.now() } = {}) {
  assertCan(user, 'bag:read');
  const mine = myBags(state, user);
  const rows = monitorRows(state, user, { now });
  return {
    atGate: receivingQueue(state, user, { now }).length,
    inbound: upcomingTrucks(state, user, { now }).filter((r) => OPEN_TRIP.includes(r.trip.status)).length,
    toScreen: mine.filter((b) => b.status === 'Received at Warehouse' && !isCancelled(state, b)).length,
    toLoad: mine.filter((b) => b.status === 'Screened').length,
    onAirportTruck: mine.filter((b) => b.status === 'Loaded to Airport Truck').length,
    held: mine.filter((b) => b.status === SIDE_STATUSES.HELD).length,
    worstTimer: rows.some((r) => r.timerLevel === 'red') ? 'red' : rows.some((r) => r.timerLevel === 'amber') ? 'amber' : null,
    openExceptions: warehouseExceptions(state, user).length,
  };
}
