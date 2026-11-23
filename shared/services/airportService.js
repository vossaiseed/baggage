/**
 * airportService — everything the Airport Coordinator does at the airport, the last Rabel stage
 * before the bags belong to the airline:
 *
 *   incoming airport trucks → seal check at the gate → offload (one internal-label scan per bag,
 *   count match against the truck's load) → SGS handover (the airline-tag manifest reconciled to
 *   what is physically there; only disputed bags are scanned again) → the voucher SGS issues,
 *   whose acceptance is the bags' "SGS Voucher Accepted" step.
 *
 * Every bag status change goes through bagService, every scan through scanService.recordScan,
 * every permission through rbac, and fleet (driver/truck) state only ever changes in
 * transportService — this service calls `releaseTripResources` rather than touching it.
 */
import { assertCan, scopeFilter } from '../rbac.js';
import { SIDE_STATUSES } from '../constants.js';
import { forecast, computeAlerts } from '../time/window.js';
import { advanceBag, holdForCancelledFlight } from './bagService.js';
import { releaseTripResources } from './transportService.js';
import { audit, nextCounter, nowIso } from './audit.js';
import { notify } from './notify.js';
import { raiseException } from './exceptionService.js';
import { recordScan } from './scanService.js';
import { integrations } from '../integrations/index.js';
import { makeHandover, makeSgsVoucher } from '../models.js';
import { ServiceError } from './errors.js';

const norm = (s) => String(s ?? '').trim().toUpperCase();
const ms = (d) => new Date(d).getTime();

/** Airport trips that have not finished their offload yet. */
const INBOUND_STATUSES = ['Dispatched', 'Loaded', 'En Route', 'Arrived'];

/* ───────────────────────── scope helpers ───────────────────────── */

const myAirportId = (user) => user?.airport_id ?? null;
const myBags = (state, user) => scopeFilter(user, 'bags', state.bags);
const myTrips = (state, user) => scopeFilter(user, 'trips', state.trips).filter((t) => t.type === 'Airport');

function findTrip(state, id, user, permission = 'trip:read') {
  const t = (state.trips || []).find((x) => x.id === id);
  if (!t) throw new ServiceError('NOT_FOUND', `Trip ${id} not found.`);
  if (t.type !== 'Airport') throw new ServiceError('INVALID_STATE', 'Only an airport truck is handled here.');
  assertCan(user, permission, t);
  return t;
}

const flightOf = (state, bag) => state.flights.find((f) => f.id === bag.flight_id) || null;
const isCancelled = (state, bag) => flightOf(state, bag)?.status === 'Cancelled';

/** The tag SGS reconciles a bag by: its airline tag, or the Rabel label when the flight has no airline list. */
const manifestTag = (bag) => bag.airline_tag_no || bag.tag_no;

/** flight id → priority rank (1 = most urgent) for the next 24 h. */
function ranks(state, now) {
  return new Map(forecast(state.flights, state.bags, now).map((f) => [f.id, f.priority_rank]));
}

/** Group bags by flight, most urgent flight first. */
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

/** Worst time-rule alert across the flights these bags belong to. @returns {'red'|'amber'|null} */
function worstAlert(state, bags, now) {
  /** @type {'red'|'amber'|null} */
  let level = null;
  for (const fid of new Set(bags.map((b) => b.flight_id))) {
    for (const a of computeAlerts(now, state.flights.find((f) => f.id === fid), state.bags)) {
      if (a.level === 'red') level = 'red';
      else if (a.level === 'amber' && level !== 'red') level = 'amber';
    }
  }
  return level;
}

/* ───────────────────────── Incoming ───────────────────────── */

/**
 * Airport trucks heading to my airport (and those at the gate that are not emptied yet), most
 * urgent flight first. Read-only.
 * @returns {{ trip: object, warehouse: object|null, driver: object|null, truck: object|null, bags: object[],
 *             flights: string[], priority: number, alertLevel: string|null, sealChecked: boolean, offloaded: boolean }[]}
 */
export function incomingTrips(state, user, { now = Date.now() } = {}) {
  assertCan(user, 'trip:read');
  const r = ranks(state, now);
  return myTrips(state, user)
    .filter((t) => INBOUND_STATUSES.includes(t.status) && !t.offload?.completed_at)
    .map((trip) => {
      const bags = state.bags.filter((b) => trip.bag_ids.includes(b.id));
      const flightIds = [...new Set(bags.map((b) => b.flight_id))];
      return {
        trip,
        warehouse: state.warehouses.find((w) => w.id === trip.warehouse_id) || null,
        driver: state.drivers.find((d) => d.id === trip.driver_id) || null,
        truck: state.trucks.find((t) => t.id === trip.truck_id) || null,
        bags,
        flights: flightIds.map((id) => state.flights.find((f) => f.id === id)?.code).filter(Boolean),
        priority: flightIds.length ? Math.min(...flightIds.map((id) => r.get(id) ?? 99)) : 99,
        alertLevel: worstAlert(state, bags, now),
        sealChecked: !!trip.seal_check,
        offloaded: !!trip.offload?.completed_at,
      };
    })
    .sort((a, b) => a.priority - b.priority || ms(a.trip.dispatched_at) - ms(b.trip.dispatched_at));
}

/* ───────────────────────── Seal check ───────────────────────── */

/** Trucks at the gate whose seal has not been checked yet. */
export function sealQueue(state, user, opts = {}) {
  return incomingTrips(state, user, opts).filter((r) => r.trip.status === 'Arrived' && !r.sealChecked);
}

/**
 * Check the seal fitted at the warehouse against what is on the door. A broken or wrong seal raises
 * a High "Seal Broken" exception and tells Ops — it does NOT block the offload: leaving bags on a
 * truck past the cut-off is worse than unloading them under an open exception. The trip stays
 * flagged (`seal_check.intact === false`) so every later screen shows it.
 * @param {object} state @param {string} tripId
 * @param {{ sealNo?: string, intact?: boolean, note?: string }} input @param {object} ctx
 * @returns {{ ok: boolean, matched: boolean, message: string, trip: object }}
 */
export function checkSeal(state, tripId, input, ctx) {
  assertCan(ctx.user, 'seal:check');
  const trip = findTrip(state, tripId, ctx.user, 'trip:update');
  if (trip.status !== 'Arrived') throw new ServiceError('INVALID_STATE', `This truck is "${trip.status}" — it is not at the gate yet.`);
  if (trip.seal_check) throw new ServiceError('ALREADY_CHECKED', 'This truck\'s seal has already been checked.');
  const seen = String(input?.sealNo || '').trim();
  if (!seen) throw new ServiceError('SEAL_REQUIRED', 'Enter the seal number on the truck door.');
  const intact = input?.intact !== false;
  const matched = norm(seen) === norm(trip.seal_no);
  const ok = intact && matched;

  trip.seal_check = {
    at: nowIso(ctx), by: ctx.user?.id ?? null, expected: trip.seal_no ?? null, seen,
    intact: ok, note: String(input?.note || '').trim() || null,
  };
  if (!ok) {
    const why = !intact ? 'the seal was reported broken' : `the seal reads ${seen} but ${trip.truck_id} left sealed ${trip.seal_no || '—'}`;
    const exc = raiseException(state, {
      type: 'Seal Broken', severity: 'High', flight_id: state.bags.find((b) => trip.bag_ids.includes(b.id))?.flight_id ?? null,
      value: seen, notes: `${trip.truck_id} at ${trip.airport_id}: ${why}. ${trip.bag_ids.length} bag(s) on board.`,
    }, ctx);
    trip.seal_check.exception_id = exc.id;
    notify(state, {
      role_list: ['ops_manager', 'transport_manager'], severity: 'critical',
      title: `Seal problem on ${trip.truck_id}`, body: `${why}. Offloading continues under exception ${exc.id}.`, link: '#/exceptions',
    }, ctx);
  }
  audit(state, ctx, { action: 'airport.seal_check', entity: 'Trip', entityId: trip.id, after: { ...trip.seal_check } });
  return {
    ok, matched, trip,
    message: ok ? `Seal ${seen} matches — start the offload.` : `Seal problem recorded. Ops has been told; offload the truck and keep the bags together.`,
  };
}

/* ───────────────────────── Offload ───────────────────────── */

/** Trucks whose seal has been checked and whose bags are not all off yet. */
export function offloadQueue(state, user, opts = {}) {
  return incomingTrips(state, user, opts).filter((r) => r.trip.status === 'Arrived' && r.sealChecked && !r.offloaded);
}

function offloadableTrip(state, tripId, user) {
  // `trip:update` alone is not enough — Transport Staff hold it for their own run. Offloading is
  // the Coordinator's step, so require the status only they may set.
  assertCan(user, 'bag:advance:Received at Airport');
  const trip = findTrip(state, tripId, user, 'trip:update');
  if (trip.status !== 'Arrived') throw new ServiceError('INVALID_STATE', `This truck is "${trip.status}" — it is not at the gate yet.`);
  if (!trip.seal_check) throw new ServiceError('SEAL_FIRST', 'Check the seal before opening the truck.');
  if (trip.offload?.completed_at) throw new ServiceError('ALREADY_OFFLOADED', 'This truck has already been offloaded.');
  return trip;
}

/**
 * One internal-label scan per bag as it comes off the truck. Nothing moves status until the count
 * matches (see completeOffload).
 * @returns {{ ok: boolean, result: string, message: string, bag?: object, scanned: number, expected: number }}
 */
export function scanBagAtAirport(state, tripId, scan, ctx) {
  const trip = offloadableTrip(state, tripId, ctx.user);
  trip.offload = trip.offload || { started_at: nowIso(ctx), scanned_bag_ids: [], completed_at: null };
  const expected = trip.bag_ids.length;
  const value = norm(scan.value);
  const bag = state.bags.find((b) => norm(b.tag_no) === value);
  const base = {
    step: 'AIRPORT_OFFLOAD_LABEL', method: scan.method, symbology: scan.symbology || 'CODE128', device_id: scan.device_id,
    raw_value: scan.value, bag_id: bag?.id ?? null, flight_id: bag?.flight_id ?? null, traveler_id: bag?.traveler_id ?? null,
  };
  const fail = (result, message, exception) => {
    recordScan(state, { ...base, result, note: message }, ctx);
    if (exception) {
      raiseException(state, { type: exception, severity: 'Medium', bag_id: bag?.id ?? null, flight_id: bag?.flight_id ?? null, value: String(scan.value), notes: message }, ctx);
    }
    return { ok: false, result, message, bag, scanned: trip.offload.scanned_bag_ids.length, expected };
  };

  if (!bag) return fail('UNKNOWN', `"${scan.value}" is not a Rabel label.`, null);
  if (!trip.bag_ids.includes(bag.id)) return fail('WRONG_STEP', `${bag.tag_no} did not travel on ${trip.truck_id} — it belongs to another truck.`, 'Count Mismatch');
  if (trip.offload.scanned_bag_ids.includes(bag.id)) return fail('DUPLICATE', `${bag.tag_no} has already been scanned off this truck.`, null);
  if (bag.status !== 'In Transit to Airport') return fail('WRONG_STEP', `${bag.tag_no} is "${bag.status}" — it cannot be offloaded here.`, null);

  trip.offload.scanned_bag_ids.push(bag.id);
  recordScan(state, { ...base, result: 'OK' }, ctx);
  const scanned = trip.offload.scanned_bag_ids.length;
  return { ok: true, result: 'OK', message: `${bag.tag_no} offloaded (${scanned}/${expected}).`, bag, scanned, expected };
}

/** Loaded vs scanned for the open offload. @returns {{ expected: object[], scanned: object[], missing: object[], ok: boolean }} */
export function offloadProgress(state, tripId, user) {
  const trip = findTrip(state, tripId, user);
  const scannedIds = trip.offload?.scanned_bag_ids || [];
  const expected = state.bags.filter((b) => trip.bag_ids.includes(b.id));
  const scanned = expected.filter((b) => scannedIds.includes(b.id));
  const missing = expected.filter((b) => !scannedIds.includes(b.id));
  return { expected, scanned, missing, ok: expected.length > 0 && missing.length === 0 };
}

/**
 * Count match against what the warehouse loaded, then receive every bag in one step
 * (In Transit to Airport → Received at Airport) and free the driver + truck. A short count raises a
 * High Count Mismatch naming the missing labels and blocks the receipt.
 * @returns {{ ok: boolean, expected: number, scanned: number, received?: number, missing?: string[], message?: string }}
 */
export function completeOffload(state, tripId, ctx) {
  const trip = offloadableTrip(state, tripId, ctx.user);
  const { expected, scanned, missing } = offloadProgress(state, tripId, ctx.user);
  if (missing.length || !expected.length) {
    const labels = missing.map((b) => b.tag_no || b.id);
    raiseException(state, {
      type: 'Count Mismatch', severity: 'High', flight_id: missing[0]?.flight_id ?? null, bag_id: missing[0]?.id ?? null,
      notes: `Airport offload ${trip.truck_id}: ${expected.length} bag(s) left the warehouse, ${scanned.length} came off. Missing: ${labels.join(', ') || 'none — nothing was loaded'}.`,
    }, ctx);
    return {
      ok: false, expected: expected.length, scanned: scanned.length, missing: labels,
      message: `${expected.length} bag(s) were loaded but ${scanned.length} came off ${trip.truck_id}. Find ${labels.join(', ')} before closing the offload.`,
    };
  }
  const at = nowIso(ctx);
  const airportId = myAirportId(ctx.user) || trip.airport_id;
  for (const b of scanned) {
    advanceBag(state, b.id, 'Received at Airport', { user: ctx.user, now: ctx.now, countMatch: true, note: `Off ${trip.truck_id}` });
    b.airport_id = airportId;
    b.received_at_airport_at = at;
  }
  trip.offload.completed_at = at;
  releaseTripResources(state, trip);

  const cancelled = scanned.filter((b) => isCancelled(state, b)).length;
  if (cancelled) {
    notify(state, { role: 'airport_coordinator', severity: 'warning', title: `${cancelled} bag(s) belong to a cancelled flight`, body: 'Hold them at the airport instead of handing them to the Authority.', link: '#/dep/offload' }, ctx);
  }
  notify(state, { role: 'transport_manager', title: `${trip.truck_id} emptied at ${airportId}`, body: `${scanned.length} bag(s) received. Driver and truck are free again.` }, ctx);
  audit(state, ctx, { action: 'airport.offload_complete', entity: 'Trip', entityId: trip.id, after: { received: scanned.length, cancelled } });
  return { ok: true, expected: expected.length, scanned: scanned.length, received: scanned.length };
}

/** Ask Transport to take the empty truck back to the warehouse. */
export function requestReturnTrip(state, tripId, { note = '' } = {}, ctx) {
  assertCan(ctx.user, 'return_trip:request');
  const trip = findTrip(state, tripId, ctx.user, 'trip:update');
  if (!trip.offload?.completed_at) throw new ServiceError('INVALID_STATE', 'Finish the offload before sending the truck back.');
  notify(state, {
    role: 'transport_manager', title: `${trip.truck_id} is empty at ${trip.airport_id}`,
    body: `Ready to return to ${state.warehouses.find((w) => w.id === trip.warehouse_id)?.name || 'the warehouse'}.${note ? ` ${String(note).trim()}` : ''}`, link: '#/',
  }, ctx);
  audit(state, ctx, { action: 'airport.return_requested', entity: 'Trip', entityId: trip.id, note: String(note || '').trim() || null });
  return trip;
}

/* ───────────────────────── Holding at the airport (cancelled flights only) ───────────────────────── */

/** Bags of a cancelled flight that reached the airport and must not be handed over. */
export function cancelledAtAirport(state, user) {
  assertCan(user, 'bag:read');
  return myBags(state, user).filter((b) => b.status === 'Received at Airport' && isCancelled(state, b));
}

/**
 * Hold cancelled-flight bags at the airport (they go back to the warehouse holding area with the
 * return trip; the rack is recorded so they can be found).
 * @param {string[]} bagIds @param {{ area?: string, rack?: string }} place
 */
export function holdCancelledBags(state, bagIds, place, ctx) {
  assertCan(ctx.user, 'bag:hold');
  const ids = [...new Set(bagIds || [])];
  if (!ids.length) throw new ServiceError('NOTHING_SELECTED', 'Select the bags to hold.');
  const rack = String(place?.rack || '').trim();
  if (!rack) throw new ServiceError('RACK_REQUIRED', 'Record where the bags are being held.');
  const area = String(place?.area || '').trim() || 'Airport holding';
  const out = { held: 0, skipped: /** @type {{bag_id:string, reason:string}[]} */ ([]) };
  for (const id of ids) {
    try {
      holdForCancelledFlight(state, id, { user: ctx.user, now: ctx.now, holdingArea: area, holdingRack: rack, note: `Held at ${ctx.user?.airport_id || 'the airport'}` });
      out.held++;
    } catch (err) { out.skipped.push({ bag_id: id, reason: err.message }); }
  }
  audit(state, ctx, { action: 'airport.hold', entity: 'Bag', entityId: ids.join(','), after: { ...out, area, rack } });
  return out;
}

/* ───────────────────────── SGS handover ───────────────────────── */

/**
 * Bags standing at the airport waiting to be handed to the Airport Authority, by flight.
 * Cancelled-flight bags are excluded — they are held, not handed over.
 * @returns {{ flight: object|null, priority: number, bags: object[], handover: object|null, noAirlineTag: number, alerts: object[] }[]}
 */
export function handoverQueue(state, user, { now = Date.now() } = {}) {
  assertCan(user, 'bag:read');
  const rows = myBags(state, user).filter((b) => b.status === 'Received at Airport' && !isCancelled(state, b));
  return byFlight(state, rows, now).map((g) => ({
    ...g,
    handover: (state.handovers || []).find((h) => h.flight_id === g.flight?.id && h.status === 'Open') || null,
    noAirlineTag: g.bags.filter((b) => !b.airline_tag_no).length,
    alerts: computeAlerts(now, g.flight, state.bags),
  }));
}

export function listHandovers(state, user, { includeClosed = true } = {}) {
  assertCan(user, 'handover:write');
  const airportId = myAirportId(user);
  return (state.handovers || [])
    .filter((h) => (!airportId || h.airport_id === airportId) && (includeClosed || h.status === 'Open'))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export function getHandover(state, handoverId, user) {
  const h = (state.handovers || []).find((x) => x.id === handoverId);
  if (!h) throw new ServiceError('NOT_FOUND', `Handover ${handoverId} not found.`);
  assertCan(user, 'handover:write');
  if (myAirportId(user) && h.airport_id !== myAirportId(user)) throw new ServiceError('FORBIDDEN', 'That handover belongs to another airport.');
  return h;
}

/**
 * Open the handover manifest for one flight: every bag of that flight standing at my airport, with
 * the airline tag SGS will reconcile it by.
 */
export function startHandover(state, flightId, ctx) {
  assertCan(ctx.user, 'handover:write');
  const flight = state.flights.find((f) => f.id === flightId);
  if (!flight) throw new ServiceError('NOT_FOUND', `Flight ${flightId} not found.`);
  if (flight.status === 'Cancelled') throw new ServiceError('FLIGHT_CANCELLED', `${flight.code} is cancelled — hold its bags instead of handing them over.`);
  if ((state.handovers || []).some((h) => h.flight_id === flightId && h.status === 'Open')) {
    throw new ServiceError('ALREADY_OPEN', `A handover for ${flight.code} is already open.`);
  }
  const bags = myBags(state, ctx.user).filter((b) => b.flight_id === flightId && b.status === 'Received at Airport');
  if (!bags.length) throw new ServiceError('NOTHING_TO_HAND_OVER', `No ${flight.code} bags are standing at the airport.`);

  state.handovers = state.handovers || [];
  const handover = makeHandover({
    id: `HOV-${String(nextCounter(state, 'handover')).padStart(6, '0')}`, flight_id: flightId, airport_id: myAirportId(ctx.user),
    bag_ids: bags.map((b) => b.id), tags: bags.map(manifestTag), created_at: nowIso(ctx), by: ctx.user?.id ?? null,
  });
  state.handovers.push(handover);
  audit(state, ctx, { action: 'airport.handover_start', entity: 'Handover', entityId: handover.id, after: { flight: flight.code, bags: bags.length } });
  return handover;
}

/** Flag a bag the Authority disputes (not on their count, tag unreadable …). It must be scanned to clear. */
export function disputeBag(state, handoverId, bagId, { reason = '' } = {}, ctx) {
  const h = getHandover(state, handoverId, ctx.user);
  if (h.status !== 'Open') throw new ServiceError('INVALID_STATE', 'This handover is closed.');
  if (!h.bag_ids.includes(bagId)) throw new ServiceError('NOT_FOUND', 'That bag is not on this manifest.');
  const why = String(reason || '').trim();
  if (!why) throw new ServiceError('REASON_REQUIRED', 'Say what the Authority disputes about this bag.');
  const open = h.disputed.find((d) => d.bag_id === bagId && !d.resolved_at);
  if (open) { open.reason = why; return open; }
  const row = { bag_id: bagId, reason: why, at: nowIso(ctx), resolved_at: null };
  h.disputed.push(row);
  audit(state, ctx, { action: 'airport.dispute', entity: 'Handover', entityId: h.id, after: { bag_id: bagId }, note: why });
  return row;
}

/**
 * Scan a disputed bag's airline tag (or its Rabel label) to clear the dispute. This is the ONLY
 * per-bag scan at the handover — the rest of the manifest is reconciled as a list.
 * @returns {{ ok: boolean, result: string, message: string, bag?: object }}
 */
export function scanDisputedTag(state, handoverId, scan, ctx) {
  const h = getHandover(state, handoverId, ctx.user);
  if (h.status !== 'Open') throw new ServiceError('INVALID_STATE', 'This handover is closed.');
  const value = norm(scan.value);
  const bag = state.bags.find((b) => norm(b.airline_tag_no) === value || norm(b.tag_no) === value);
  const base = {
    step: 'SGS_AIRLINE_TAG', method: scan.method, symbology: scan.symbology || 'ITF', device_id: scan.device_id,
    raw_value: scan.value, bag_id: bag?.id ?? null, flight_id: bag?.flight_id ?? h.flight_id, traveler_id: bag?.traveler_id ?? null,
  };
  const fail = (result, message) => { recordScan(state, { ...base, result, note: message }, ctx); return { ok: false, result, message, bag }; };

  if (!bag) return fail('UNKNOWN', `"${scan.value}" is not a tag Rabel knows.`);
  if (!h.bag_ids.includes(bag.id)) {
    return fail(bag.flight_id === h.flight_id ? 'WRONG_STEP' : 'WRONG_FLIGHT', `${manifestTag(bag)} is not on this manifest.`);
  }
  const dispute = h.disputed.find((d) => d.bag_id === bag.id && !d.resolved_at);
  if (!dispute) return fail('DUPLICATE', `${manifestTag(bag)} is not disputed — no need to scan it.`);
  dispute.resolved_at = nowIso(ctx);
  recordScan(state, { ...base, result: 'OK' }, ctx);
  audit(state, ctx, { action: 'airport.dispute_resolved', entity: 'Handover', entityId: h.id, after: { bag_id: bag.id } });
  return { ok: true, result: 'OK', message: `${manifestTag(bag)} confirmed — dispute cleared.`, bag };
}

/**
 * Hand the manifest over: every bag on it goes Received at Airport → Handed to Airport Authority,
 * and SGS is given the tag list (the simulated adapter issues the voucher straight away).
 *
 * The manifest as opened (`bag_ids`/`tags`) is left untouched — it is the sheet the officer read.
 * Two kinds of bag can be on it without crossing, and both stay on the record and go to Ops:
 * one with an unresolved dispute (`disputed`), and one that left the line while the manifest was
 * open (`withdrawn` — held for a cancelled flight, returned to its traveler).
 * @param {{ officer?: string, signature?: string }} proof
 * @returns {{ handover: object, voucher: object, handed: number, withheld: string[],
 *             withdrawn: {bag_id:string, tag:string, status:string, at:string}[] }}
 */
export function completeHandover(state, handoverId, proof, ctx) {
  assertCan(ctx.user, 'voucher:create');
  const h = getHandover(state, handoverId, ctx.user);
  if (h.status !== 'Open') throw new ServiceError('INVALID_STATE', 'This handover is already closed.');
  const officer = String(proof?.officer || '').trim();
  const signature = String(proof?.signature || '').trim();
  if (!officer || !signature) throw new ServiceError('SIGNATURE_REQUIRED', 'Record the Authority officer\'s name and signature.');

  const at = nowIso(ctx);
  const unresolved = h.disputed.filter((d) => !d.resolved_at).map((d) => d.bag_id);
  const onManifest = state.bags.filter((b) => h.bag_ids.includes(b.id));
  const notDisputed = onManifest.filter((b) => !unresolved.includes(b.id));
  // A bag can leave the manifest between opening it and signing for it without ever being
  // disputed. Dropping it from the record silently would hide it from everyone, so it is kept as
  // `withdrawn` with the status it left in, and reported with the disputed bags.
  const withdrawn = notDisputed
    .filter((b) => b.status !== 'Received at Airport')
    .map((b) => ({ bag_id: b.id, tag: manifestTag(b), status: b.status, at }));
  const handedBags = notDisputed.filter((b) => b.status === 'Received at Airport');
  if (!handedBags.length) throw new ServiceError('NOTHING_TO_HAND_OVER', 'Every bag on this manifest is disputed or has already moved on.');

  for (const b of handedBags) advanceBag(state, b.id, 'Handed to Airport Authority', { user: ctx.user, now: ctx.now, note: `Handover ${h.id} — ${officer}` });
  h.handed_bag_ids = handedBags.map((b) => b.id);
  h.handed_tags = handedBags.map(manifestTag);
  h.withdrawn = withdrawn;
  h.officer = officer;
  h.signature = signature;
  h.handed_at = at;
  h.status = 'Handed';

  const voucher = makeSgsVoucher({ id: `VCH-${String(nextCounter(state, 'voucher')).padStart(6, '0')}`, handover_id: h.id, flight_id: h.flight_id, airport_id: h.airport_id, bag_ids: h.handed_bag_ids, issued_at: at });
  const sgs = integrations().sgs.submitHandover(state, { id: h.id, flight_id: h.flight_id, tags: h.handed_tags });
  voucher.voucher_no = sgs.voucher_no;
  voucher.counted_tags = sgs.counted_tags;
  state.sgsVouchers.push(voucher);
  h.voucher_id = voucher.id;

  if (unresolved.length || withdrawn.length) {
    const why = [];
    if (unresolved.length) {
      const labels = state.bags.filter((b) => unresolved.includes(b.id)).map((b) => manifestTag(b));
      why.push(`${labels.join(', ')} were disputed by the Authority and withheld`);
    }
    if (withdrawn.length) why.push(`${withdrawn.map((w) => `${w.tag} (${w.status})`).join(', ')} left the manifest before it was signed`);
    raiseException(state, {
      type: 'Count Mismatch', severity: 'High', flight_id: h.flight_id, bag_id: unresolved[0] ?? withdrawn[0].bag_id,
      notes: `Handover ${h.id}: ${why.join('; ')}. ${handedBags.length} of ${h.bag_ids.length} bag(s) on the manifest were handed over.`,
    }, ctx);
  }
  notify(state, { role: 'backend', title: `${state.flights.find((f) => f.id === h.flight_id)?.code || 'Flight'} handed to the Authority`, body: `${handedBags.length} bag(s) on voucher ${voucher.voucher_no}.`, link: '#/manifest' }, ctx);
  audit(state, ctx, { action: 'airport.handover_complete', entity: 'Handover', entityId: h.id, after: { manifest: h.bag_ids.length, handed: handedBags.length, withheld: unresolved.length, withdrawn: withdrawn.length, voucher: voucher.voucher_no } });
  return { handover: h, voucher, handed: handedBags.length, withheld: unresolved, withdrawn };
}

/* ───────────────────────── Voucher ───────────────────────── */

export function listVouchers(state, user) {
  assertCan(user, 'voucher:accept');
  return scopeFilter(user, 'sgsVouchers', state.sgsVouchers)
    .map((v) => ({
      ...v,
      flight: state.flights.find((f) => f.id === v.flight_id) || null,
      handover: (state.handovers || []).find((h) => h.id === v.handover_id) || null,
    }))
    .sort((a, b) => String(b.issued_at).localeCompare(String(a.issued_at)));
}

/**
 * Accept the voucher SGS issued: its count must match what was handed over. A match advances every
 * bag Handed to Airport Authority → SGS Voucher Accepted; a gap raises an "SGS Voucher Mismatch"
 * for Ops and leaves the bags where they are.
 * @returns {{ ok: boolean, accepted?: number, missing?: string[], message: string, voucher: object }}
 */
export function acceptVoucher(state, voucherId, ctx) {
  assertCan(ctx.user, 'voucher:accept');
  const voucher = state.sgsVouchers.find((v) => v.id === voucherId || v.voucher_no === voucherId);
  if (!voucher) throw new ServiceError('NOT_FOUND', `Voucher ${voucherId} not found.`);
  assertCan(ctx.user, 'voucher:accept', voucher);
  if (voucher.status === 'Accepted') throw new ServiceError('ALREADY_ACCEPTED', `Voucher ${voucher.voucher_no} has already been accepted.`);

  const bags = state.bags.filter((b) => voucher.bag_ids.includes(b.id) && b.status === 'Handed to Airport Authority');
  const counted = new Set((voucher.counted_tags || []).map(norm));
  const missing = bags.filter((b) => !counted.has(norm(manifestTag(b))));
  if (missing.length || !bags.length) {
    const labels = missing.map(manifestTag);
    voucher.status = 'Mismatch';
    voucher.missing_tags = labels;
    raiseException(state, {
      type: 'SGS Voucher Mismatch', severity: 'High', flight_id: voucher.flight_id, bag_id: missing[0]?.id ?? null, value: voucher.voucher_no,
      notes: `Voucher ${voucher.voucher_no}: ${bags.length} bag(s) handed over, ${bags.length - missing.length} on the voucher. Not counted: ${labels.join(', ') || 'none — nothing is awaiting this voucher'}.`,
    }, ctx);
    notify(state, { role: 'ops_manager', severity: 'critical', title: `Voucher ${voucher.voucher_no} does not match`, body: `${labels.length} bag(s) handed over but not on the Authority's voucher.`, link: '#/exceptions' }, ctx);
    audit(state, ctx, { action: 'airport.voucher_mismatch', entity: 'SgsVoucher', entityId: voucher.id, after: { missing: labels } });
    return { ok: false, missing: labels, voucher, message: `${labels.length} bag(s) are not on voucher ${voucher.voucher_no}. Ops has been told — do not close the flight yet.` };
  }

  for (const b of bags) advanceBag(state, b.id, 'SGS Voucher Accepted', { user: ctx.user, now: ctx.now, voucherCountMatch: true, note: `Voucher ${voucher.voucher_no}` });
  voucher.status = 'Accepted';
  voucher.accepted_at = nowIso(ctx);
  voucher.missing_tags = [];
  notify(state, { role: 'backend', title: `Voucher ${voucher.voucher_no} accepted`, body: `${bags.length} bag(s) are with the Authority — the airline manifest can be confirmed.`, link: '#/manifest' }, ctx);
  audit(state, ctx, { action: 'airport.voucher_accept', entity: 'SgsVoucher', entityId: voucher.id, after: { bags: bags.length } });
  return { ok: true, accepted: bags.length, voucher, message: `Voucher ${voucher.voucher_no} accepted — ${bags.length} bag(s) cleared.` };
}

/* ───────────────────────── Exceptions + summary (read-only) ───────────────────────── */

/** Open exceptions on bags at my airport, plus any I raised. The Coordinator cannot resolve them (Ops does). */
export function airportExceptions(state, user, { includeClosed = false } = {}) {
  assertCan(user, 'exception:read');
  const ids = new Set(myBags(state, user).map((b) => b.id));
  return state.exceptions
    .filter((e) => (includeClosed || e.status === 'Open') && ((e.bag_id && ids.has(e.bag_id)) || e.raised_by === user.id))
    .map((e) => ({ ...e, bag: state.bags.find((b) => b.id === e.bag_id) || null, flight: state.flights.find((f) => f.id === e.flight_id) || null }))
    .sort((a, b) => String(b.time).localeCompare(String(a.time)));
}

/** Tile numbers for the departure side of the Coordinator's dashboard. */
export function airportSummary(state, user, { now = Date.now() } = {}) {
  assertCan(user, 'bag:read');
  const mine = myBags(state, user);
  const inbound = incomingTrips(state, user, { now });
  const atAirport = mine.filter((b) => b.status === 'Received at Airport');
  return {
    enRoute: inbound.filter((r) => r.trip.status === 'En Route').length,
    atGate: inbound.filter((r) => r.trip.status === 'Arrived' && !r.sealChecked).length,
    toOffload: inbound.filter((r) => r.trip.status === 'Arrived' && r.sealChecked).length,
    atAirport: atAirport.length,
    awaitingVoucher: mine.filter((b) => b.status === 'Handed to Airport Authority').length,
    accepted: mine.filter((b) => b.status === 'SGS Voucher Accepted').length,
    held: mine.filter((b) => b.status === SIDE_STATUSES.HELD).length,
    cancelledHere: cancelledAtAirport(state, user).length,
    openVouchers: scopeFilter(user, 'sgsVouchers', state.sgsVouchers).filter((v) => v.status !== 'Accepted').length,
    worstAlert: worstAlert(state, [...atAirport, ...inbound.flatMap((r) => r.bags)], now),
    openExceptions: airportExceptions(state, user).length,
  };
}
