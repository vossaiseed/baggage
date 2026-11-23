/**
 * transportService — Transport Manager (drivers, trucks, dispatch, reroute, window board) and
 * Transport Staff (run a Collection trip: pickup count match -> load -> depart -> arrive).
 *
 * Collection trips move checked-in bags from a residence pickup point (CollectionArea) to the
 * warehouse. There is no per-bag scan at the pickup point (checkinService.handToTransport already
 * counted the bags) — only a count match against that log, enforced before any bag status moves.
 *
 * Airport trips (warehouse -> airport) are dispatched to ONE named Transport Staff member (the run
 * starts at the warehouse, so it has no collection area to scope it by): the warehouse loads and
 * closes the truck, that staff member seals it, drives it ("In Transit to Airport") and hands it to
 * the Airport Coordinator, who offloads it (shared/services/airportService.js).
 */
import { assertCan, scopeFilter } from '../rbac.js';
import { makeDriver, makeTruck, makeTrip } from '../models.js';
import { advanceBag } from './bagService.js';
import { audit, nextCounter, nowIso } from './audit.js';
import { notify } from './notify.js';
import { raiseException } from './exceptionService.js';
import { forecast, computeAlerts } from '../time/window.js';
import { ServiceError } from './errors.js';

const ACTIVE_TRIP_STATUSES = ['Dispatched', 'Loaded', 'En Route'];

function findArea(state, id) {
  const a = (state.collectionAreas || []).find((x) => x.id === id);
  if (!a) throw new ServiceError('NOT_FOUND', `Collection area ${id} not found.`);
  return a;
}
function findDriver(state, id) {
  const d = (state.drivers || []).find((x) => x.id === id);
  if (!d) throw new ServiceError('NOT_FOUND', `Driver ${id} not found.`);
  return d;
}
function findTruck(state, id) {
  const t = (state.trucks || []).find((x) => x.id === id);
  if (!t) throw new ServiceError('NOT_FOUND', `Truck ${id} not found.`);
  return t;
}
function findTrip(state, id, user) {
  const t = (state.trips || []).find((x) => x.id === id);
  if (!t) throw new ServiceError('NOT_FOUND', `Trip ${id} not found.`);
  assertCan(user, 'trip:read', t);
  return t;
}

/** Next free id for a prefix, based on existing rows — safe even when some were seeded directly (not via a counter). */
function nextId(rows, prefix, pad = 3) {
  const used = rows.map((r) => r.id).filter((id) => id?.startsWith(`${prefix}-`)).map((id) => Number(id.slice(prefix.length + 1))).filter(Number.isFinite);
  return `${prefix}-${String(Math.max(0, ...used) + 1).padStart(pad, '0')}`;
}

/* ───────────────────────── drivers ───────────────────────── */

export function listDrivers(state, user) {
  assertCan(user, 'driver:read');
  return [...state.drivers].sort((a, b) => a.id.localeCompare(b.id));
}

export function createDriver(state, input, ctx) {
  assertCan(ctx.user, 'driver:create');
  const name = String(input?.name || '').trim();
  if (name.length < 2) throw new ServiceError('INVALID', "The driver's name is required.");
  const id = nextId(state.drivers, 'DRV');
  const driver = makeDriver({ id, name, phone: input.phone || null, license_no: input.license_no || null, area_id: input.area_id || null });
  state.drivers.push(driver);
  audit(state, ctx, { action: 'driver.create', entity: 'Driver', entityId: driver.id, after: { name: driver.name } });
  return driver;
}

/** @param {'Available'|'Off duty'} status a Busy driver must finish or be rerouted off their trip first */
export function setDriverStatus(state, id, status, ctx) {
  assertCan(ctx.user, 'driver:update');
  const d = findDriver(state, id);
  if (!['Available', 'Off duty'].includes(status)) throw new ServiceError('INVALID', 'Status must be Available or Off duty.');
  if (d.status === 'Busy') throw new ServiceError('BUSY', `${d.name} is on an active trip — reroute the trip first.`);
  const before = { status: d.status };
  d.status = status;
  audit(state, ctx, { action: 'driver.status', entity: 'Driver', entityId: d.id, before, after: { status } });
  return d;
}

/* ───────────────────────── trucks ───────────────────────── */

export function listTrucks(state, user) {
  assertCan(user, 'truck:read');
  return [...state.trucks].sort((a, b) => a.id.localeCompare(b.id));
}

export function createTruck(state, input, ctx) {
  assertCan(ctx.user, 'truck:create');
  const plate = String(input?.plate_no || '').trim();
  if (plate.length < 2) throw new ServiceError('INVALID', 'A plate number is required.');
  const id = nextId(state.trucks, 'TRK');
  const truck = makeTruck({ id, plate_no: plate, capacity_bags: Number(input.capacity_bags) || 80 });
  state.trucks.push(truck);
  audit(state, ctx, { action: 'truck.create', entity: 'Truck', entityId: truck.id, after: { plate_no: truck.plate_no } });
  return truck;
}

/** @param {'Available'|'Off duty'} status a Busy truck must finish or be rerouted off its trip first */
export function setTruckStatus(state, id, status, ctx) {
  assertCan(ctx.user, 'truck:update');
  const t = findTruck(state, id);
  if (!['Available', 'Off duty'].includes(status)) throw new ServiceError('INVALID', 'Status must be Available or Off duty.');
  if (t.status === 'Busy') throw new ServiceError('BUSY', `${t.id} is on an active trip — reroute the trip first.`);
  const before = { status: t.status };
  t.status = status;
  audit(state, ctx, { action: 'truck.status', entity: 'Truck', entityId: t.id, before, after: { status } });
  return t;
}

/* ───────────────────────── window board (read-only) ───────────────────────── */

/**
 * One row per collection area: bags waiting for pickup, the most urgent flight behind them, and
 * the worst time-rule alert among the flights those bags belong to.
 * @returns {{ area: object, pendingPickups: number, priorityRank: number, alertLevel: string|null, openTrips: object[] }[]}
 */
export function windowBoard(state, user, { now = Date.now() } = {}) {
  assertCan(user, 'collectionArea:read');
  const ranks = new Map(forecast(state.flights, state.bags, now).map((f) => [f.id, f.priority_rank]));
  return state.collectionAreas.map((area) => {
    const waiting = eligibleBags(state, area.id);
    const flightIds = [...new Set(waiting.map((b) => b.flight_id))];
    const priorityRank = flightIds.length ? Math.min(...flightIds.map((id) => ranks.get(id) ?? 99)) : 99;
    let alertLevel = null;
    for (const fid of flightIds) {
      const flight = state.flights.find((f) => f.id === fid);
      for (const a of computeAlerts(now, flight, state.bags)) {
        if (a.level === 'red') alertLevel = 'red';
        else if (a.level === 'amber' && alertLevel !== 'red') alertLevel = 'amber';
      }
    }
    const openTrips = state.trips.filter((t) => t.area_from === area.id && ACTIVE_TRIP_STATUSES.includes(t.status));
    return { area, pendingPickups: area.pending_pickups || 0, priorityRank, alertLevel, openTrips };
  }).sort((a, b) => a.priorityRank - b.priorityRank || a.area.id.localeCompare(b.area.id));
}

/* ───────────────────────── dispatch (Manager) ───────────────────────── */

/**
 * Bags actually handed to Transport at this pickup point (checkinService.handToTransport's log)
 * that no trip has claimed yet. This is "the check-in log" the pickup count is matched against —
 * not just any "Checked-in" bag, which may still be with check-in staff mid-flow.
 */
function eligibleBags(state, areaId) {
  const handed = new Set(
    state.collectionAssignments.filter((a) => a.collection_area_id === areaId && a.status === 'Handed to Transport').flatMap((a) => a.handed_bag_ids || []),
  );
  return state.bags.filter((b) => handed.has(b.id) && b.status === 'Checked-in' && !b.collection_trip_id);
}

/**
 * Assign an available driver + truck to an area's waiting bags — creates a Collection trip.
 * @param {object} state @param {string} areaId @param {{driverId:string, truckId:string}} input @param {object} ctx
 */
export function dispatchCollectionTrip(state, areaId, input, ctx) {
  assertCan(ctx.user, 'dispatch:assign');
  const area = findArea(state, areaId);
  const n = eligibleBags(state, areaId).length;
  if (n === 0) throw new ServiceError('NOTHING_TO_COLLECT', 'No checked-in bags are waiting for pickup in this area.');
  if (state.trips.some((t) => t.area_from === areaId && ACTIVE_TRIP_STATUSES.includes(t.status))) {
    throw new ServiceError('ALREADY_DISPATCHED', 'An active trip already covers this area.');
  }
  const driver = findDriver(state, input.driverId);
  if (driver.status !== 'Available') throw new ServiceError('DRIVER_BUSY', `${driver.name} is not available.`);
  const truck = findTruck(state, input.truckId);
  if (truck.status !== 'Available') throw new ServiceError('TRUCK_BUSY', `${truck.id} is not available.`);

  const at = nowIso(ctx);
  const trip = makeTrip({
    id: `TRIP-${String(nextCounter(state, 'trip')).padStart(6, '0')}`, type: 'Collection', status: 'Dispatched',
    area_from: areaId, warehouse_id: area.warehouse_id, driver_id: driver.id, truck_id: truck.id,
    expected_count: n, dispatched_at: at,
  });
  state.trips.push(trip);
  driver.status = 'Busy'; driver.truck_id = truck.id;
  truck.status = 'Busy'; truck.driver_id = driver.id;
  const staff = state.users.find((u) => u.role === 'transport_staff' && u.area_id === areaId && u.status !== 'Disabled');
  notify(state, { user_id: staff?.id, role: staff ? undefined : 'transport_staff', title: `Pickup dispatched — ${area.name}`, body: `${truck.id} / ${driver.name} is on the way for ${n} bag(s).`, link: `#/trips/${trip.id}` }, ctx);
  audit(state, ctx, { action: 'trip.dispatch', entity: 'Trip', entityId: trip.id, after: { area_from: areaId, driver_id: driver.id, truck_id: truck.id, expected_count: n } });
  return trip;
}

/**
 * Assign a driver + truck + the Transport Staff member who runs the warehouse → airport leg. The
 * Warehouse Manager asks for a truck (`warehouseService.requestAirportTruck`); the Manager
 * dispatches it here, the warehouse loads screened bags onto it ("Loaded to Airport Truck"), then
 * the assigned staff member seals and drives it (`departForAirport`).
 * @param {object} state @param {{warehouseId:string, driverId:string, truckId:string, staffId:string, airportId?:string}} input @param {object} ctx
 */
export function dispatchAirportTrip(state, input, ctx) {
  assertCan(ctx.user, 'dispatch:assign');
  const warehouseId = input?.warehouseId;
  if (!state.warehouses.some((w) => w.id === warehouseId)) throw new ServiceError('NOT_FOUND', `Warehouse ${warehouseId} not found.`);
  const staff = state.users.find((u) => u.id === input?.staffId && u.role === 'transport_staff' && u.status !== 'Disabled');
  if (!staff) throw new ServiceError('INVALID', 'Choose the Transport Staff member who will run the airport leg.');
  const waiting = state.bags.filter((b) => b.warehouse_id === warehouseId && b.status === 'Screened').length;
  if (waiting === 0) throw new ServiceError('NOTHING_TO_LOAD', 'No screened bags are waiting at this warehouse.');
  if (state.trips.some((t) => t.type === 'Airport' && t.warehouse_id === warehouseId && ACTIVE_TRIP_STATUSES.includes(t.status))) {
    throw new ServiceError('ALREADY_DISPATCHED', 'An airport truck is already open at this warehouse.');
  }
  const driver = findDriver(state, input.driverId);
  if (driver.status !== 'Available') throw new ServiceError('DRIVER_BUSY', `${driver.name} is not available.`);
  const truck = findTruck(state, input.truckId);
  if (truck.status !== 'Available') throw new ServiceError('TRUCK_BUSY', `${truck.id} is not available.`);

  const at = nowIso(ctx);
  const trip = makeTrip({
    id: `TRIP-${String(nextCounter(state, 'trip')).padStart(6, '0')}`, type: 'Airport', status: 'Dispatched',
    warehouse_id: warehouseId, airport_id: input.airportId || state.airports[0]?.id || null,
    driver_id: driver.id, truck_id: truck.id, staff_id: staff.id, expected_count: waiting, dispatched_at: at,
  });
  state.trips.push(trip);
  driver.status = 'Busy'; driver.truck_id = truck.id;
  truck.status = 'Busy'; truck.driver_id = driver.id;
  notify(state, { role: 'warehouse_manager', title: `Airport truck ${truck.id} is at the dock`, body: `${driver.name} is ready to load for the airport run.`, link: '#/loading' }, ctx);
  notify(state, { user_id: staff.id, title: `Airport run — ${truck.id}`, body: `${driver.name} is loading at the warehouse. Seal and drive it once the load is closed.`, link: `#/trips/${trip.id}` }, ctx);
  audit(state, ctx, { action: 'trip.dispatch_airport', entity: 'Trip', entityId: trip.id, after: { warehouse_id: warehouseId, driver_id: driver.id, truck_id: truck.id, staff_id: staff.id, expected_count: waiting } });
  return trip;
}

/* ───────────────────────── Collection trip flow (Transport Staff) ───────────────────────── */

export function listMyTrips(state, user, { includeDone = false } = {}) {
  const mine = scopeFilter(user, 'trips', state.trips).filter((t) => t.type === 'Collection');
  return mine.filter((t) => includeDone || ACTIVE_TRIP_STATUSES.includes(t.status))
    .sort((a, b) => b.dispatched_at.localeCompare(a.dispatched_at));
}

/**
 * Count match at the pickup point, then load every matched bag (Checked-in -> Loaded to Collection
 * Truck) in one step — there is no per-bag scan here. A mismatch raises an exception and blocks the
 * load so the count can be corrected before the truck leaves.
 * @returns {{ ok: boolean, expected: number, presented: number, bagsLoaded?: number, message?: string }}
 */
export function loadCollectionTrip(state, tripId, { presented }, ctx) {
  const trip = findTrip(state, tripId, ctx.user);
  assertCan(ctx.user, 'trip:update', trip);
  if (trip.status !== 'Dispatched') throw new ServiceError('INVALID_STATE', `This trip is "${trip.status}"; it has already been loaded.`);
  const n = Number(presented);
  if (!Number.isInteger(n) || n < 0) throw new ServiceError('INVALID', 'Enter how many bags were handed over at the pickup point.');
  const bags = eligibleBags(state, trip.area_from);
  if (n !== bags.length) {
    const area = findArea(state, trip.area_from);
    raiseException(state, { type: 'Count Mismatch', severity: 'Medium', area_id: area.id, notes: `Pickup at ${area.name}: ${bags.length} bag(s) logged as checked-in, ${n} presented to ${trip.truck_id}.` }, ctx);
    return { ok: false, expected: bags.length, presented: n, message: `${bags.length} bag(s) expected from the check-in log; ${n} were presented. Resolve the mismatch before loading.` };
  }
  const at = nowIso(ctx);
  for (const b of bags) { advanceBag(state, b.id, 'Loaded to Collection Truck', { user: ctx.user, now: ctx.now, countMatch: true, note: `Trip ${trip.id}` }); b.collection_trip_id = trip.id; }
  trip.bag_ids = bags.map((b) => b.id);
  trip.status = 'Loaded';
  trip.loaded_at = at;
  const area = findArea(state, trip.area_from);
  area.pending_pickups = Math.max(0, (area.pending_pickups || 0) - bags.length);
  audit(state, ctx, { action: 'trip.load', entity: 'Trip', entityId: trip.id, after: { bags: bags.length } });
  return { ok: true, expected: bags.length, presented: n, bagsLoaded: bags.length };
}

export function departTrip(state, tripId, ctx) {
  const trip = findTrip(state, tripId, ctx.user);
  assertCan(ctx.user, 'trip:update', trip);
  if (trip.status !== 'Loaded') throw new ServiceError('INVALID_STATE', 'Load the bags before departing.');
  trip.status = 'En Route';
  trip.departed_at = nowIso(ctx);
  notify(state, { role: 'warehouse_manager', title: `${trip.truck_id} en route`, body: `${trip.bag_ids.length} bag(s) from ${findArea(state, trip.area_from).name}, ETA shortly.` }, ctx);
  audit(state, ctx, { action: 'trip.depart', entity: 'Trip', entityId: trip.id });
  return trip;
}

/** Arrival at the warehouse ends Transport's responsibility for this trip; the driver/truck free up. */
export function arriveAtWarehouse(state, tripId, ctx) {
  const trip = findTrip(state, tripId, ctx.user);
  assertCan(ctx.user, 'trip:update', trip);
  if (trip.status !== 'En Route') throw new ServiceError('INVALID_STATE', 'Depart the pickup point before arriving at the warehouse.');
  trip.status = 'Arrived';
  trip.arrived_at = nowIso(ctx);
  const driver = state.drivers.find((d) => d.id === trip.driver_id);
  const truck = state.trucks.find((t) => t.id === trip.truck_id);
  if (driver) { driver.status = 'Available'; }
  if (truck) { truck.status = 'Available'; }
  notify(state, { role: 'warehouse_manager', title: `${trip.truck_id} arrived`, body: `${trip.bag_ids.length} bag(s) from ${findArea(state, trip.area_from).name} are at the gate.` }, ctx);
  audit(state, ctx, { action: 'trip.arrive', entity: 'Trip', entityId: trip.id, after: { bags: trip.bag_ids.length } });
  return trip;
}

/* ───────────────────────── Airport trip flow (Transport Staff) ───────────────────────── */

/** Airport runs assigned to me (scope: the trip's `staff_id`). */
export function listMyAirportTrips(state, user, { includeDone = false } = {}) {
  const mine = scopeFilter(user, 'trips', state.trips).filter((t) => t.type === 'Airport');
  return mine.filter((t) => includeDone || ACTIVE_TRIP_STATUSES.includes(t.status))
    .sort((a, b) => b.dispatched_at.localeCompare(a.dispatched_at));
}

/**
 * Seal the loaded airport truck and drive it. Every bag on board goes
 * "Loaded to Airport Truck" → "In Transit to Airport" (an idempotent status: re-confirming the
 * departure never fails). The seal number is what the Airport Coordinator checks on arrival.
 * @param {object} state @param {string} tripId @param {{sealNo:string}} input @param {object} ctx
 */
export function departForAirport(state, tripId, input, ctx) {
  const trip = findTrip(state, tripId, ctx.user);
  assertCan(ctx.user, 'trip:update', trip);
  if (trip.type !== 'Airport') throw new ServiceError('INVALID_STATE', 'This is not an airport run.');
  if (trip.status !== 'Loaded') throw new ServiceError('INVALID_STATE', `This truck is "${trip.status}" — the warehouse has not closed its load yet.`);
  const sealNo = String(input?.sealNo || '').trim();
  if (!sealNo) throw new ServiceError('SEAL_REQUIRED', 'Record the seal number fitted to the truck door.');
  if (!trip.bag_ids.length) throw new ServiceError('NOTHING_LOADED', 'There are no bags on this truck.');

  for (const id of trip.bag_ids) advanceBag(state, id, 'In Transit to Airport', { user: ctx.user, now: ctx.now, note: `Sealed ${sealNo} on ${trip.truck_id}` });
  trip.seal_no = sealNo;
  trip.status = 'En Route';
  trip.departed_at = nowIso(ctx);
  const airport = state.airports.find((a) => a.id === trip.airport_id);
  notify(state, {
    role: 'airport_coordinator', title: `${trip.truck_id} en route to ${airport?.code || 'the airport'}`,
    body: `${trip.bag_ids.length} bag(s), seal ${sealNo}.`, link: '#/dep/incoming',
  }, ctx);
  audit(state, ctx, { action: 'trip.depart_airport', entity: 'Trip', entityId: trip.id, after: { seal_no: sealNo, bags: trip.bag_ids.length } });
  return trip;
}

/** Arrival at the airport gate. The Coordinator checks the seal and offloads; the truck stays Busy until then. */
export function arriveAtAirport(state, tripId, ctx) {
  const trip = findTrip(state, tripId, ctx.user);
  assertCan(ctx.user, 'trip:update', trip);
  if (trip.type !== 'Airport') throw new ServiceError('INVALID_STATE', 'This is not an airport run.');
  if (trip.status !== 'En Route') throw new ServiceError('INVALID_STATE', 'Depart the warehouse before arriving at the airport.');
  trip.status = 'Arrived';
  trip.arrived_at = nowIso(ctx);
  notify(state, {
    role: 'airport_coordinator', title: `${trip.truck_id} at the gate`,
    body: `${trip.bag_ids.length} bag(s) — check seal ${trip.seal_no || '—'} before offloading.`, severity: 'warning', link: '#/dep/seal',
  }, ctx);
  audit(state, ctx, { action: 'trip.arrive_airport', entity: 'Trip', entityId: trip.id, after: { bags: trip.bag_ids.length } });
  return trip;
}

/**
 * Free the driver and truck a trip is holding. Fleet state only ever changes in this service —
 * the Airport Coordinator calls this once the truck has actually been emptied.
 * @param {object} state @param {object} trip
 */
export function releaseTripResources(state, trip) {
  const driver = state.drivers.find((d) => d.id === trip.driver_id);
  const truck = state.trucks.find((t) => t.id === trip.truck_id);
  if (driver && driver.status === 'Busy') driver.status = 'Available';
  if (truck && truck.status === 'Busy') truck.status = 'Available';
  return { driver, truck };
}

/* ───────────────────────── reroute (Manager) ───────────────────────── */

/**
 * Swap the driver and/or truck on an active trip (breakdown, driver unavailable, …). The
 * replaced resource goes "Off duty"; the new one must already be Available.
 * @param {{ reason: string, newDriverId?: string, newTruckId?: string }} input
 */
export function rerouteTrip(state, tripId, input, ctx) {
  const trip = findTrip(state, tripId, ctx.user);
  assertCan(ctx.user, 'reroute:create');
  if (!ACTIVE_TRIP_STATUSES.includes(trip.status)) throw new ServiceError('INVALID_STATE', `A trip that is "${trip.status}" cannot be rerouted.`);
  if (!String(input?.reason || '').trim()) throw new ServiceError('REASON_REQUIRED', 'A reason is required.');
  const fromDriverId = trip.driver_id;
  const fromTruckId = trip.truck_id;
  let toDriverId = fromDriverId;
  let toTruckId = fromTruckId;

  if (input.newTruckId && input.newTruckId !== fromTruckId) {
    const newTruck = findTruck(state, input.newTruckId);
    if (newTruck.status !== 'Available') throw new ServiceError('TRUCK_BUSY', `${newTruck.id} is not available.`);
    const oldTruck = state.trucks.find((t) => t.id === fromTruckId);
    if (oldTruck) { oldTruck.status = 'Off duty'; oldTruck.driver_id = null; }
    newTruck.status = 'Busy'; newTruck.driver_id = trip.driver_id;
    toTruckId = newTruck.id;
  }
  if (input.newDriverId && input.newDriverId !== fromDriverId) {
    const newDriver = findDriver(state, input.newDriverId);
    if (newDriver.status !== 'Available') throw new ServiceError('DRIVER_BUSY', `${newDriver.name} is not available.`);
    const oldDriver = state.drivers.find((d) => d.id === fromDriverId);
    if (oldDriver) { oldDriver.status = 'Available'; oldDriver.truck_id = null; }
    newDriver.status = 'Busy'; newDriver.truck_id = trip.truck_id;
    toDriverId = newDriver.id;
  }
  if (toDriverId === fromDriverId && toTruckId === fromTruckId) throw new ServiceError('NO_CHANGE', 'Choose a different driver or truck to reroute to.');

  trip.driver_id = toDriverId;
  trip.truck_id = toTruckId;
  const log = {
    id: `RRT-${String(nextCounter(state, 'reroute')).padStart(6, '0')}`, trip_id: trip.id, reason: input.reason.trim(),
    from_driver_id: fromDriverId, to_driver_id: toDriverId, from_truck_id: fromTruckId, to_truck_id: toTruckId,
    at: nowIso(ctx), by: ctx.user?.id ?? null,
  };
  state.rerouteLogs.push(log);
  audit(state, ctx, { action: 'trip.reroute', entity: 'Trip', entityId: trip.id, before: { driver_id: fromDriverId, truck_id: fromTruckId }, after: { driver_id: toDriverId, truck_id: toTruckId }, note: log.reason });
  return { trip, log };
}

/* ───────────────────────── reports ───────────────────────── */

/** Simple trip-history summary for the Transport Manager's Reports screen. */
export function reportSummary(state, { since } = /** @type {{since?:string|number|Date}} */ ({})) {
  const sinceMs = since ? new Date(since).getTime() : 0;
  const trips = state.trips.filter((t) => t.type === 'Collection' && new Date(t.dispatched_at).getTime() >= sinceMs);
  const arrived = trips.filter((t) => t.status === 'Arrived');
  const bagsMoved = arrived.reduce((n, t) => n + t.bag_ids.length, 0);
  const durations = arrived.filter((t) => t.arrived_at).map((t) => new Date(t.arrived_at).getTime() - new Date(t.dispatched_at).getTime());
  const avgMinutes = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 60000) : null;
  const airport = state.trips.filter((t) => t.type === 'Airport' && new Date(t.dispatched_at).getTime() >= sinceMs);
  const airportArrived = airport.filter((t) => t.status === 'Arrived');
  return {
    tripsDispatched: trips.length, tripsArrived: arrived.length, tripsActive: trips.filter((t) => ACTIVE_TRIP_STATUSES.includes(t.status)).length,
    bagsMoved, avgMinutes, reroutes: state.rerouteLogs.filter((r) => trips.some((t) => t.id === r.trip_id)).length,
    airportTrips: airport.length, airportTripsArrived: airportArrived.length,
    airportBagsMoved: airportArrived.reduce((n, t) => n + t.bag_ids.length, 0),
    trips: [...trips, ...airport].sort((a, b) => b.dispatched_at.localeCompare(a.dispatched_at)),
  };
}
