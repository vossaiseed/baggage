/**
 * Invariants a v7 store must hold. Used by `npm run seed:departure` (which builds the demo in
 * Node and refuses to pass if any of these break) and by the unit tests.
 *
 * Each check returns a list of human-readable problems; an empty list means the state is sound.
 */
import { BAG_STATUSES, SIDE_STATUS_LIST, FLIGHT_STATUSES, ASSIGNMENT_STATUSES, EXCEPTION_STATUSES, LPN_REGEX, INTERNAL_TAG_PREFIX } from '../constants.js';
import { ROLE_PRESETS } from '../rbac.js';
import { COLLECTIONS } from '../models.js';
import { slotInsideCollectionWindow } from '../time/window.js';

/**
 * @param {object} state
 * @returns {string[]} problems, empty when the state is sound
 */
export function validateState(state) {
  const p = [];
  const has = (arr, id) => arr.some((x) => x.id === id);

  for (const c of COLLECTIONS) {
    if (!Array.isArray(state[c])) p.push(`collection "${c}" is missing or not an array`);
  }
  if (p.length) return p;

  // ── users
  for (const u of state.users) {
    if (!ROLE_PRESETS[u.role]) p.push(`user ${u.id}: unknown role "${u.role}"`);
    const prefix = ROLE_PRESETS[u.role]?.prefix;
    if (prefix && !String(u.employee_id || '').startsWith(`${prefix}-`)) p.push(`user ${u.id}: employee id does not use the ${prefix}- prefix`);
    if (u.area_id && !has(state.collectionAreas, u.area_id)) p.push(`user ${u.id}: unknown area ${u.area_id}`);
  }
  const ids = state.users.map((u) => u.employee_id);
  if (new Set(ids).size !== ids.length) p.push('two users share an employee id');

  // ── flights
  for (const f of state.flights) {
    if (!FLIGHT_STATUSES.includes(f.status)) p.push(`flight ${f.id}: unknown status "${f.status}"`);
    if (f.airline_code && !state.airlines.some((a) => a.code === f.airline_code)) p.push(`flight ${f.id}: unknown airline ${f.airline_code}`);
    if (f.cut_off_at && !f.window_start_at) p.push(`flight ${f.id}: has a cut-off but no 12 h window start`);
    if (f.cut_off_at && f.window_start_at) {
      const hours = (new Date(f.cut_off_at).getTime() - new Date(f.window_start_at).getTime()) / 3600e3;
      if (Math.abs(hours - 12) > 0.001) p.push(`flight ${f.id}: window is ${hours} h, not 12 h`);
    }
    if (f.status === 'Cancelled' && !f.cancel_reason) p.push(`flight ${f.id}: cancelled without a reason`);
  }

  // ── travelers and residences
  for (const t of state.travelers) {
    if (t.flight_id && !has(state.flights, t.flight_id)) p.push(`traveler ${t.id}: unknown flight ${t.flight_id}`);
    if (t.residence_id && !has(state.residences, t.residence_id)) p.push(`traveler ${t.id}: unknown residence ${t.residence_id}`);
  }
  for (const r of state.residences) {
    if (r.collection_area_id && !has(state.collectionAreas, r.collection_area_id)) p.push(`residence ${r.id}: unknown area ${r.collection_area_id}`);
  }

  // ── bags
  const tagNos = [];
  const airlineTags = [];
  for (const b of state.bags) {
    if (![...BAG_STATUSES, ...SIDE_STATUS_LIST].includes(b.status)) p.push(`bag ${b.id}: unknown status "${b.status}"`);
    if (b.flight_id && !has(state.flights, b.flight_id)) p.push(`bag ${b.id}: unknown flight ${b.flight_id}`);
    if (b.traveler_id && !has(state.travelers, b.traveler_id)) p.push(`bag ${b.id}: unknown traveler ${b.traveler_id}`);
    if (b.tag_no) {
      if (!String(b.tag_no).startsWith(INTERNAL_TAG_PREFIX)) p.push(`bag ${b.id}: internal tag "${b.tag_no}" is not ${INTERNAL_TAG_PREFIX}xxxxxx`);
      tagNos.push(b.tag_no);
    }
    if (b.airline_tag_no) {
      if (typeof b.airline_tag_no !== 'string') p.push(`bag ${b.id}: airline tag must stay a string (leading zeros)`);
      else if (!LPN_REGEX.test(b.airline_tag_no)) p.push(`bag ${b.id}: airline tag "${b.airline_tag_no}" is not 10 digits`);
      airlineTags.push(b.airline_tag_no);
    }
    if (BAG_STATUSES.indexOf(b.status) >= BAG_STATUSES.indexOf('Tag Assigned') && !b.tag_no) {
      p.push(`bag ${b.id}: is "${b.status}" without an internal tag`);
    }
    if (b.status === 'Held – Cancelled Flight') {
      const f = state.flights.find((x) => x.id === b.flight_id);
      if (f && f.status !== 'Cancelled') p.push(`bag ${b.id}: held, but ${f.code} is not cancelled`);
    }
  }
  if (new Set(tagNos).size !== tagNos.length) p.push('two bags share an internal tag');
  if (new Set(airlineTags).size !== airlineTags.length) p.push('two bags share an airline tag');

  // ── tags
  for (const t of state.bagTags) {
    if (t.tag_type === 'IATA_LPN' && !LPN_REGEX.test(String(t.lpn ?? ''))) p.push(`tag ${t.id}: "${t.lpn}" is not a 10-digit LPN`);
    if (t.flight_id && !has(state.flights, t.flight_id)) p.push(`tag ${t.id}: unknown flight ${t.flight_id}`);
  }

  // ── slots and assignments
  for (const s of state.collectionSlots) {
    if (!has(state.collectionAreas, s.collection_area_id)) p.push(`slot ${s.id}: unknown area ${s.collection_area_id}`);
    const hours = (new Date(s.end).getTime() - new Date(s.start).getTime()) / 3600e3;
    if (Math.abs(hours - 2) > 0.001) p.push(`slot ${s.id}: is ${hours} h, not the 2 h the rules allow`);
    if ((s.booked_count || 0) > (s.capacity_travelers || 0)) p.push(`slot ${s.id}: ${s.booked_count} booked into ${s.capacity_travelers} places`);
  }
  for (const a of state.collectionAssignments) {
    if (!ASSIGNMENT_STATUSES.includes(a.status)) p.push(`assignment ${a.id}: unknown status "${a.status}"`);
    if (!has(state.travelers, a.traveler_id)) p.push(`assignment ${a.id}: unknown traveler ${a.traveler_id}`);
    const slot = state.collectionSlots.find((s) => s.id === a.slot_id);
    const flight = state.flights.find((f) => f.id === a.flight_id);
    if (a.slot_id && !slot) p.push(`assignment ${a.id}: unknown slot ${a.slot_id}`);
    if (slot && flight?.cut_off_at && !slotInsideCollectionWindow(slot, flight.cut_off_at) && !a.slot_outside_window) {
      p.push(`assignment ${a.id}: its slot is outside ${flight.code}'s 8 h collection window`);
    }
  }

  // ── trips and exceptions
  for (const t of state.trips) {
    for (const id of t.bag_ids || []) if (!has(state.bags, id)) p.push(`trip ${t.id}: unknown bag ${id}`);
    if (t.driver_id && !has(state.drivers, t.driver_id)) p.push(`trip ${t.id}: unknown driver ${t.driver_id}`);
    if (t.truck_id && !has(state.trucks, t.truck_id)) p.push(`trip ${t.id}: unknown truck ${t.truck_id}`);
  }
  for (const e of state.exceptions) {
    if (!EXCEPTION_STATUSES.includes(e.status)) p.push(`exception ${e.id}: unknown status "${e.status}"`);
    if (e.bag_id && !has(state.bags, e.bag_id)) p.push(`exception ${e.id}: unknown bag ${e.bag_id}`);
  }

  return p;
}

/** A short count of what a state holds — what the seed script prints. */
export function summarise(state) {
  const byStatus = {};
  for (const b of state.bags) byStatus[b.status] = (byStatus[b.status] || 0) + 1;
  return {
    airlines: state.airlines.length,
    flights: state.flights.length,
    travelers: state.travelers.length,
    residences: state.residences.length,
    areas: state.collectionAreas.length,
    slots: state.collectionSlots.length,
    assignments: state.collectionAssignments.length,
    bags: state.bags.length,
    bagsByStatus: byStatus,
    bagTags: state.bagTags.length,
    users: state.users.length,
    drivers: state.drivers.length,
    trucks: state.trucks.length,
  };
}
