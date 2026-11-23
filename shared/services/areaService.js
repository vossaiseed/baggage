/**
 * areaService — collection areas and their 2-hour collection slots (Operations Manager).
 *
 *   listAreas / areaDetail        who works an area, what is waiting there, how it is doing
 *   createArea / updateArea       the residence pickup points themselves
 *   listSlots / setSlotCapacity   how many travelers one 2-hour slot can take
 *   generateSlots                 (re-)create a flight's slots for every area
 *
 * Slots are always derived from a flight's 8-hour collection window (shared/time/window.js) —
 * this service never invents a time of its own, it only sets capacity.
 */
import { assertCan, scopeFilter } from '../rbac.js';
import { ROLE, PRE_COLLECTION_ASSIGNMENT_STATUSES } from '../constants.js';
import { ensureSlots } from './travelerService.js';
import { slotInsideCollectionWindow, forecast, computeAlerts } from '../time/window.js';
import { audit } from './audit.js';
import { ServiceError } from './errors.js';

const ms = (d) => new Date(d).getTime();
const ACTIVE_TRIP_STATUSES = ['Dispatched', 'Loaded', 'En Route'];

function findArea(state, id) {
  const a = (state.collectionAreas || []).find((x) => x.id === id);
  if (!a) throw new ServiceError('NOT_FOUND', `Collection area ${id} not found.`);
  return a;
}

/** `Al-Awali` -> `AREA-AL-AWALI` (the id format the seed and the base accounts use). */
function areaId(name) {
  const slug = String(name).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `AREA-${slug}`;
}

/* ───────────────────────── read models ───────────────────────── */

/**
 * One row per collection area: its staff, its residences, the bags waiting for pickup and the
 * worst time-rule alert among the flights those bags belong to.
 * @param {object} state @param {object} user @param {{ now?: number|string|Date }} [opts]
 */
export function listAreas(state, user, { now = Date.now() } = {}) {
  assertCan(user, 'collectionArea:read');
  const ranks = new Map(forecast(state.flights, state.bags, now).map((f) => [f.id, f.priority_rank]));
  return scopeFilter(user, 'collectionAreas', state.collectionAreas).map((area) => {
    const assignments = (state.collectionAssignments || []).filter((a) => a.collection_area_id === area.id);
    const open = assignments.filter((a) => PRE_COLLECTION_ASSIGNMENT_STATUSES.includes(a.status));
    const bags = (state.bags || []).filter((b) => b.collection_area_id === area.id);
    const flightIds = [...new Set(open.map((a) => a.flight_id).filter(Boolean))];
    const alerts = flightIds.flatMap((fid) => computeAlerts(now, (state.flights || []).find((f) => f.id === fid), bags));
    const slots = (state.collectionSlots || []).filter((s) => s.collection_area_id === area.id);
    return {
      area,
      warehouse: (state.warehouses || []).find((w) => w.id === area.warehouse_id) || null,
      staff: (state.users || []).filter((u) => u.area_id === area.id && u.status !== 'Disabled'),
      checkinStaff: (state.users || []).filter((u) => u.role === ROLE.CHECKIN && u.area_id === area.id && u.status !== 'Disabled').length,
      transportStaff: (state.users || []).filter((u) => u.role === ROLE.TRANSPORT_STAFF && u.area_id === area.id && u.status !== 'Disabled').length,
      residences: (state.residences || []).filter((r) => r.collection_area_id === area.id).length,
      assignmentsOpen: open.length,
      assignmentsTotal: assignments.length,
      pendingPickups: area.pending_pickups || 0,
      bags: bags.length,
      activeTrips: (state.trips || []).filter((t) => [t.area_from, t.area_to].includes(area.id) && ACTIVE_TRIP_STATUSES.includes(t.status)).length,
      priorityRank: Math.min(99, ...flightIds.map((fid) => ranks.get(fid) ?? 99)),
      slots: { total: slots.length, capacity: slots.reduce((n, s) => n + (s.capacity_travelers || 0), 0), booked: slots.reduce((n, s) => n + (s.booked_count || 0), 0) },
      alertLevel: alerts.some((a) => a.level === 'red') ? 'red' : (alerts.some((a) => a.level === 'amber') ? 'amber' : null),
    };
  }).sort((a, b) => a.priorityRank - b.priorityRank || String(a.area.name).localeCompare(String(b.area.name)));
}

/** One area with its residences and open assignments listed out. */
export function areaDetail(state, id, user, { now = Date.now() } = {}) {
  const row = listAreas(state, user, { now }).find((r) => r.area.id === id);
  if (!row) throw new ServiceError('NOT_FOUND', `Collection area ${id} not found.`);
  return {
    ...row,
    residenceRows: (state.residences || []).filter((r) => r.collection_area_id === id),
    assignmentRows: (state.collectionAssignments || []).filter((a) => a.collection_area_id === id)
      .map((a) => ({
        assignment: a,
        traveler: (state.travelers || []).find((t) => t.id === a.traveler_id) || null,
        slot: (state.collectionSlots || []).find((s) => s.id === a.slot_id) || null,
        flight: (state.flights || []).find((f) => f.id === a.flight_id) || null,
      })),
  };
}

/* ───────────────────────── areas ───────────────────────── */

/**
 * @param {object} state
 * @param {{ name: string, district?: string, warehouse_id?: string, lat?: number, lng?: number }} input
 * @param {object} ctx
 */
export function createArea(state, input, ctx) {
  assertCan(ctx.user, 'collectionArea:create');
  const name = String(input?.name || '').trim();
  if (name.length < 2) throw new ServiceError('INVALID', 'The area name is required.');
  const id = areaId(name);
  if ((state.collectionAreas || []).some((a) => a.id === id || String(a.name).toLowerCase() === name.toLowerCase())) {
    throw new ServiceError('DUPLICATE', `${name} already exists.`);
  }
  const warehouseId = input?.warehouse_id || (state.warehouses || [])[0]?.id || null;
  if (warehouseId && !(state.warehouses || []).some((w) => w.id === warehouseId)) throw new ServiceError('NOT_FOUND', `Warehouse ${warehouseId} not found.`);
  const area = {
    id, name, district: String(input?.district || name).trim(), warehouse_id: warehouseId,
    lat: input?.lat != null ? Number(input.lat) : null, lng: input?.lng != null ? Number(input.lng) : null,
    pending_pickups: 0, priority_score: 0,
  };
  state.collectionAreas.push(area);
  // A new area needs the slots of every flight that is still collecting.
  const slots = (state.flights || []).filter((f) => f.cut_off_at && !['Cancelled', 'Completed'].includes(f.status))
    .flatMap((f) => ensureSlots(state, area.id, f));
  audit(state, ctx, { action: 'area.create', entity: 'CollectionArea', entityId: area.id, after: { name: area.name, warehouse_id: area.warehouse_id } });
  return { area, slotsCreated: slots.length };
}

/**
 * @param {object} state @param {string} id
 * @param {{ name?: string, district?: string, warehouse_id?: string, lat?: number, lng?: number }} patch @param {object} ctx
 */
export function updateArea(state, id, patch, ctx) {
  assertCan(ctx.user, 'collectionArea:update');
  const area = findArea(state, id);
  const before = { name: area.name, warehouse_id: area.warehouse_id, lat: area.lat, lng: area.lng };
  if (patch?.name !== undefined) {
    const name = String(patch.name).trim();
    if (name.length < 2) throw new ServiceError('INVALID', 'The area name is required.');
    if ((state.collectionAreas || []).some((a) => a.id !== id && String(a.name).toLowerCase() === name.toLowerCase())) {
      throw new ServiceError('DUPLICATE', `${name} already exists.`);
    }
    area.name = name; // the id never changes — scan logs, bags and users point at it
  }
  if (patch?.district !== undefined) area.district = String(patch.district).trim() || area.name;
  if (patch?.warehouse_id !== undefined) {
    if (!(state.warehouses || []).some((w) => w.id === patch.warehouse_id)) throw new ServiceError('NOT_FOUND', `Warehouse ${patch.warehouse_id} not found.`);
    area.warehouse_id = patch.warehouse_id;
  }
  if (patch?.lat !== undefined) area.lat = patch.lat == null ? null : Number(patch.lat);
  if (patch?.lng !== undefined) area.lng = patch.lng == null ? null : Number(patch.lng);
  audit(state, ctx, { action: 'area.update', entity: 'CollectionArea', entityId: area.id, before, after: { name: area.name, warehouse_id: area.warehouse_id, lat: area.lat, lng: area.lng } });
  return area;
}

/* ───────────────────────── slots ───────────────────────── */

/**
 * The 2-hour slots for an area (optionally for one flight only), with what is booked into them.
 * @param {object} state @param {object} user
 * @param {{ areaId?: string, flightId?: string, now?: number|string|Date, includePast?: boolean }} [filters]
 */
export function listSlots(state, user, filters = {}) {
  assertCan(user, 'collectionSlot:read');
  const now = ms(filters.now ?? Date.now());
  const flight = filters.flightId ? (state.flights || []).find((f) => f.id === filters.flightId) || null : null;
  return scopeFilter(user, 'collectionSlots', state.collectionSlots)
    .filter((s) => (filters.areaId ? s.collection_area_id === filters.areaId : true))
    .filter((s) => (flight?.cut_off_at ? slotInsideCollectionWindow(s, flight.cut_off_at) : true))
    .filter((s) => (filters.includePast ? true : ms(s.end) > now))
    .map((s) => {
      const assignments = (state.collectionAssignments || []).filter((a) => a.slot_id === s.id);
      return {
        slot: s,
        area: (state.collectionAreas || []).find((a) => a.id === s.collection_area_id) || null,
        booked: s.booked_count || 0,
        remaining: Math.max(0, (s.capacity_travelers || 0) - (s.booked_count || 0)),
        full: (s.booked_count || 0) >= (s.capacity_travelers || 0),
        past: ms(s.end) <= now,
        assignments,
        bags: assignments.reduce((n, a) => n + (a.bags_declared || 0), 0),
      };
    })
    .sort((a, b) => ms(a.slot.start) - ms(b.slot.start) || String(a.slot.collection_area_id).localeCompare(String(b.slot.collection_area_id)));
}

/**
 * How many travelers one slot can take. Never below what is already booked into it.
 * @param {object} state @param {string} slotId @param {number} capacity @param {object} ctx
 */
export function setSlotCapacity(state, slotId, capacity, ctx) {
  assertCan(ctx.user, 'collectionSlot:update');
  const slot = (state.collectionSlots || []).find((s) => s.id === slotId);
  if (!slot) throw new ServiceError('NOT_FOUND', `Slot ${slotId} not found.`);
  const n = Number(capacity);
  if (!Number.isInteger(n) || n < 0 || n > 200) throw new ServiceError('INVALID', 'Capacity must be a whole number between 0 and 200.');
  if (n < (slot.booked_count || 0)) throw new ServiceError('BELOW_BOOKED', `${slot.booked_count} traveler(s) are already booked into this slot.`);
  const before = { capacity_travelers: slot.capacity_travelers };
  slot.capacity_travelers = n;
  audit(state, ctx, { action: 'slot.capacity', entity: 'CollectionSlot', entityId: slot.id, before, after: { capacity_travelers: n } });
  return slot;
}

/**
 * (Re-)create a flight's 2-hour slots for every area, with a chosen capacity.
 * Existing slots keep their bookings; only missing ones are added.
 * @param {object} state @param {{ flightId: string, capacity?: number, areaId?: string }} input @param {object} ctx
 */
export function generateSlots(state, input, ctx) {
  assertCan(ctx.user, 'collectionSlot:create');
  const flight = (state.flights || []).find((f) => f.id === input?.flightId);
  if (!flight) throw new ServiceError('NOT_FOUND', `Flight ${input?.flightId} not found.`);
  if (!flight.cut_off_at) throw new ServiceError('NO_CUTOFF', `${flight.code} has no baggage cut-off, so it has no collection window.`);
  if (['Cancelled', 'Completed'].includes(flight.status)) throw new ServiceError('FLIGHT_CLOSED', `${flight.code} is ${flight.status}.`);
  const capacity = input?.capacity != null ? Number(input.capacity) : 6;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 200) throw new ServiceError('INVALID', 'Capacity must be a whole number between 1 and 200.');
  const areas = (state.collectionAreas || []).filter((a) => (input?.areaId ? a.id === input.areaId : true));
  if (!areas.length) throw new ServiceError('NOT_FOUND', 'No collection area to create slots for.');
  let created = 0;
  for (const area of areas) {
    const had = new Set((state.collectionSlots || []).filter((s) => s.collection_area_id === area.id).map((s) => s.id));
    for (const slot of ensureSlots(state, area.id, flight, capacity)) {
      if (!had.has(slot.id)) created++;
      else if (capacity > (slot.capacity_travelers || 0)) slot.capacity_travelers = capacity;
    }
  }
  audit(state, ctx, { action: 'slot.generate', entity: 'Flight', entityId: flight.id, after: { created, capacity, areas: areas.length } });
  return { flight, created, capacity, areas: areas.length };
}
