/**
 * travelerService — everything the Traveler (Customer) app does, plus the Nusuk/airline upserts
 * Backend uses. Traveler actions run as a pseudo-user `{ role:'traveler', traveler_id }` so RBAC
 * (scope: own) applies exactly like it does for staff.
 */
import { assertCan } from '../rbac.js';
import { getConfig } from '../config.js';
import { BAG_STATUSES, ROLE, SIDE_STATUSES } from '../constants.js';
import { collectionSlotWindows, slotInsideCollectionWindow } from '../time/window.js';
import { integrations } from '../integrations/index.js';
import { makeBag } from '../models.js';
import { audit, nextCounter, nowIso } from './audit.js';
import { notify } from './notify.js';
import { ServiceError } from './errors.js';

const pad = (n, w) => String(n).padStart(w, '0');
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();
const ms = (d) => new Date(d).getTime();

/** @param {any} t traveler row @returns {any} RBAC pseudo-user */
export function travelerUser(t) {
  return { id: t.id, employee_id: t.id, name: t.name, role: ROLE.TRAVELER, traveler_id: t.id, flight_id: t.flight_id, status: 'Active' };
}

export function areaForDistrict(state, district) {
  const d = norm(district);
  return state.collectionAreas.find((a) => norm(a.district) === d || norm(a.name) === d) || null;
}

const flightByCode = (state, code) => state.flights.find((f) => norm(f.code) === norm(code)) || null;

/* ───────────────────────── Nusuk / airline upserts (used by login-sync and Backend) ───────────────────────── */

/**
 * Create or update a Traveler + Residence from a Nusuk record. Fields the traveler corrected
 * (flat no., landmark, contact phone) are NEVER overwritten by a later sync.
 * @returns {{ traveler: any, created: boolean }}
 */
export function upsertFromNusuk(state, rec, ctx = {}) {
  const id = `TRV-${rec.nusuk_id}`;
  let t = state.travelers.find((x) => x.id === id);
  const created = !t;
  const flight = flightByCode(state, rec.flight_code);
  const area = areaForDistrict(state, rec.residence?.district);
  if (!t) {
    t = {
      id, nusuk_id: rec.nusuk_id, booking_ref: null, name: rec.name, passport: rec.passport, airline_code: flight?.airline_code ?? null,
      flight_id: flight?.id ?? null, source: 'Nusuk', data_verified: false, data_rejected: false, boarding_pass_no: rec.boarding_pass_no ?? null,
      boarding_pass_verified: false, boarding_pass_flag: null, residence_id: null, collection_area_id: area?.id ?? null, nusuk_synced_at: null,
      nusuk: null, airline: null, mismatch_resolved: null,
    };
    state.travelers.push(t);
  }
  t.nusuk = { name: rec.name, passport: rec.passport, flight_code: rec.flight_code };
  if (created || !t.data_verified) { t.name = t.name || rec.name; }
  if (rec.boarding_pass_no && !t.boarding_pass_verified) t.boarding_pass_no = rec.boarding_pass_no;
  t.nusuk_synced_at = nowIso(ctx);

  // residence
  const r = rec.residence;
  if (r) {
    let res = state.residences.find((x) => x.id === t.residence_id) || state.residences.find((x) => (x.traveler_ids || []).includes(t.id));
    if (!res) {
      res = { id: `RES-${pad(nextCounter(state, 'residence'), 5)}`, traveler_ids: [t.id], building: r.building, flat_no: r.flat_no, street: r.street, district: r.district,
        collection_area_id: area?.id ?? null, lat: r.lat, lng: r.lng, contact_phone: r.contact_phone, landmark: r.landmark, source: 'Nusuk', corrected: {}, change_log: [] };
      state.residences.push(res);
    } else {
      for (const k of ['building', 'street', 'district', 'lat', 'lng']) res[k] = r[k];
      for (const k of ['flat_no', 'landmark', 'contact_phone']) if (!res.corrected?.[k]) res[k] = r[k];
      if (!res.collection_area_id || res.source === 'Nusuk') res.collection_area_id = res.manual_area ? res.collection_area_id : (area?.id ?? null);
    }
    t.residence_id = res.id;
    t.collection_area_id = res.collection_area_id;
  }
  return { traveler: t, created };
}

/** Attach an airline reservation to a traveler (matched by passport), or create an Airline-only traveler. */
export function upsertFromAirline(state, rec) {
  const flight = flightByCode(state, rec.flight_code);
  // Match by passport first; if the passports disagree, fall back to same name + same flight (that is a MISMATCH to review, not a new traveler).
  // Pre-v7 (legacy) imported travelers are never matched to airline data.
  let t = state.travelers.filter((x) => !x.legacy).find((x) => (rec.booking_ref && x.booking_ref === rec.booking_ref) || norm(x.passport) === norm(rec.passport) || norm(x.nusuk?.passport) === norm(rec.passport))
    || state.travelers.filter((x) => !x.legacy).find((x) => x.nusuk && !x.airline && norm(x.nusuk.name) === norm(rec.name) && norm(x.nusuk.flight_code) === norm(rec.flight_code));
  const created = !t;
  if (!t) {
    t = {
      id: `TRV-${rec.booking_ref}`, nusuk_id: null, booking_ref: rec.booking_ref, name: rec.name, passport: rec.passport, airline_code: flight?.airline_code ?? null,
      flight_id: flight?.id ?? null, source: 'Airline', data_verified: false, data_rejected: false, boarding_pass_no: null, boarding_pass_verified: false,
      boarding_pass_flag: null, residence_id: null, collection_area_id: null, nusuk_synced_at: null, nusuk: null, airline: null, mismatch_resolved: null,
    };
    state.travelers.push(t);
  }
  t.booking_ref = rec.booking_ref;
  t.airline = { name: rec.name, passport: rec.passport, flight_code: rec.flight_code, booking_ref: rec.booking_ref, boarding_pass_no: rec.boarding_pass_no };
  if (!t.boarding_pass_no) t.boarding_pass_no = rec.boarding_pass_no;
  if (!t.flight_id && flight) { t.flight_id = flight.id; t.airline_code = flight.airline_code; }
  return { traveler: t, created };
}

/* ───────────────────────── login + sync ───────────────────────── */

/** Look a traveler up by Nusuk ID OR airline booking reference, plus passport. */
export function findTravelerForLogin(state, idOrRef, passport) {
  const key = norm(idOrRef);
  const pass = norm(passport);
  const t = state.travelers.find((x) => (norm(x.nusuk_id) === key || norm(x.booking_ref) === key)
    && (norm(x.passport) === pass || norm(x.nusuk?.passport) === pass || norm(x.airline?.passport) === pass));
  if (!t) throw new ServiceError('NOT_FOUND', 'Booking not found in Nusuk or airline data');
  return t;
}

/** Simulated OTP (code from config; 123456 in the demo). */
export function verifyOtp(code) {
  if (String(code).trim() !== getConfig().demoOtp) throw new ServiceError('BAD_OTP', 'That code is not correct. Please try again.');
  return true;
}

/** "Sync again" — pull the traveler's record from Nusuk. */
export function syncFromNusuk(state, travelerId, ctx = {}) {
  const t = state.travelers.find((x) => x.id === travelerId);
  if (!t) throw new ServiceError('NOT_FOUND', 'Traveler not found.');
  assertCan(travelerUser(t), 'nusuk:sync');
  if (!t.nusuk_id) throw new ServiceError('NO_NUSUK', 'This booking has no Nusuk ID — it came from the airline.');
  const rec = integrations().nusuk.fetchTraveler({ nusukId: t.nusuk_id, passport: t.passport });
  if (!rec) throw new ServiceError('NOT_FOUND', 'Booking not found in Nusuk');
  upsertFromNusuk(state, rec, ctx);
  audit(state, { user: travelerUser(t), now: ctx.now }, { action: 'traveler.nusuk_sync', entity: 'Traveler', entityId: t.id });
  return t;
}

/** Travelers may correct ONLY flat no., landmark and contact phone. Every change is logged. */
export function updateContact(state, travelerId, changes, ctx = {}) {
  const t = state.travelers.find((x) => x.id === travelerId);
  if (!t) throw new ServiceError('NOT_FOUND', 'Traveler not found.');
  const user = travelerUser(t);
  assertCan(user, 'traveler:edit_contact', t);
  const allowed = ['flat_no', 'landmark', 'contact_phone'];
  const extra = Object.keys(changes).filter((k) => !allowed.includes(k));
  if (extra.length) throw new ServiceError('FIELD_NOT_ALLOWED', `You can only change: flat number, landmark and contact phone (not ${extra.join(', ')}).`);
  const res = state.residences.find((r) => r.id === t.residence_id);
  if (!res) throw new ServiceError('NO_RESIDENCE', 'No residence on file.');
  if (changes.contact_phone != null && !/^\+?\d{8,15}$/.test(String(changes.contact_phone).replace(/[\s-]/g, ''))) {
    throw new ServiceError('INVALID_PHONE', 'Enter a valid phone number (8–15 digits).');
  }
  if (changes.flat_no != null && !String(changes.flat_no).trim()) throw new ServiceError('INVALID', 'Flat number cannot be empty.');
  res.corrected = res.corrected || {};
  res.change_log = res.change_log || [];
  let n = 0;
  for (const k of allowed) {
    if (changes[k] == null) continue;
    const next = String(changes[k]).trim();
    if (next === String(res[k] ?? '')) continue;
    res.change_log.push({ at: nowIso(ctx), field: k, from: res[k] ?? null, to: next, by: user.id });
    audit(state, { user, now: ctx.now }, { action: 'traveler.contact_change', entity: 'Residence', entityId: res.id, before: { [k]: res[k] ?? null }, after: { [k]: next } });
    res[k] = next;
    res.corrected[k] = true;
    n++;
  }
  return { residence: res, changed: n };
}

/* ───────────────────────── slots & booking ───────────────────────── */

/** Create (once) the 2-hour slot rows for an area inside a flight's 8 h collection window. */
export function ensureSlots(state, areaId, flight, capacity = 6) {
  if (!flight?.cut_off_at || !areaId) return [];
  return collectionSlotWindows(flight.cut_off_at).map((w) => {
    const id = `SLOT-${areaId.replace(/^AREA-/, '')}-${ms(w.start)}`;
    let slot = state.collectionSlots.find((s) => s.id === id);
    if (!slot) {
      slot = { id, collection_area_id: areaId, date: w.start.slice(0, 10), start: w.start, end: w.end, capacity_travelers: capacity, booked_count: 0 };
      state.collectionSlots.push(slot);
    }
    return slot;
  });
}

/** Bookable slots for a traveler: their area, inside the flight's 8 h window, not in the past, by availability. */
export function availableSlots(state, travelerId, ctx = {}) {
  const t = state.travelers.find((x) => x.id === travelerId);
  if (!t) throw new ServiceError('NOT_FOUND', 'Traveler not found.');
  const flight = state.flights.find((f) => f.id === t.flight_id);
  const res = state.residences.find((r) => r.id === t.residence_id);
  if (!flight?.cut_off_at || !res?.collection_area_id) return [];
  const now = ms(nowIso(ctx));
  return ensureSlots(state, res.collection_area_id, flight)
    .filter((s) => slotInsideCollectionWindow(s, flight.cut_off_at) && ms(s.end) > now)
    .map((s) => ({ ...s, remaining: Math.max(0, s.capacity_travelers - s.booked_count), full: s.booked_count >= s.capacity_travelers }));
}

/** @returns {{ airline: any, bags_allowed: number, extra_bags_max: number, max_bag_weight_kg: number }} the traveler's airline rules */
export function airlinePolicyFor(state, traveler) {
  const flight = state.flights.find((f) => f.id === traveler.flight_id);
  const code = flight?.airline_code || traveler.airline_code;
  const airline = state.airlines.find((a) => a.code === code);
  if (!airline) throw new ServiceError('NO_AIRLINE', 'No airline policy found for this booking.');
  return { airline, bags_allowed: airline.bags_allowed, extra_bags_max: airline.extra_bags_max, max_bag_weight_kg: airline.max_bag_weight_kg };
}

const ACTIVE_ASSIGNMENT = ['Assigned', 'En Route', 'Arrived', 'Collected', 'Handed to Transport', 'Traveler Absent', 'Rescheduled'];

export function activeAssignment(state, travelerId) {
  return state.collectionAssignments.find((a) => a.traveler_id === travelerId && ACTIVE_ASSIGNMENT.includes(a.status)) || null;
}

/**
 * Book residence collection. Declares the bags (status Declared).
 * @param {{ bags: number, slotId: string }} input
 */
export function bookCollection(state, travelerId, input, ctx = {}) {
  const t = state.travelers.find((x) => x.id === travelerId);
  if (!t) throw new ServiceError('NOT_FOUND', 'Traveler not found.');
  const user = travelerUser(t);
  assertCan(user, 'assignment:book', { traveler_id: t.id });
  const flight = state.flights.find((f) => f.id === t.flight_id);
  if (!flight) throw new ServiceError('NO_FLIGHT', 'No flight on this booking.');
  if (flight.status === 'Cancelled') throw new ServiceError('FLIGHT_CANCELLED', 'Your flight was cancelled — collection cannot be booked.');
  if (activeAssignment(state, t.id)) throw new ServiceError('ALREADY_BOOKED', 'You already have a collection booked.');
  const res = state.residences.find((r) => r.id === t.residence_id);
  if (!res) throw new ServiceError('NO_RESIDENCE', 'No residence on file — contact support.');
  if (!res.collection_area_id) throw new ServiceError('UNMAPPED', 'Your address is not linked to a collection area yet. Support has been notified.');

  const policy = airlinePolicyFor(state, t);
  const n = Number(input.bags);
  const max = policy.bags_allowed + policy.extra_bags_max;
  if (!Number.isInteger(n) || n < 1) throw new ServiceError('INVALID_BAGS', 'Enter the number of bags (at least 1).');
  if (n > max) throw new ServiceError('OVER_LIMIT', `${policy.airline.code} allows at most ${max} bags (${policy.bags_allowed} + ${policy.extra_bags_max} extra).`);

  const slot = availableSlots(state, t.id, ctx).find((s) => s.id === input.slotId);
  if (!slot) throw new ServiceError('SLOT_UNAVAILABLE', 'That slot is not available. Slots are offered only inside your flight’s collection window.');
  if (slot.full) throw new ServiceError('SLOT_FULL', 'That slot is full. Please choose another.');
  const slotRow = state.collectionSlots.find((s) => s.id === slot.id);

  const area = state.collectionAreas.find((a) => a.id === res.collection_area_id);
  const staff = state.users.filter((u) => u.role === ROLE.CHECKIN && u.area_id === area.id && u.status !== 'Disabled')
    .sort((a, b) => state.collectionAssignments.filter((x) => x.check_in_staff_id === a.id).length - state.collectionAssignments.filter((x) => x.check_in_staff_id === b.id).length)[0];

  const extraCount = Math.max(0, n - policy.bags_allowed);
  const bags = [];
  for (let i = 0; i < n; i++) {
    const bag = makeBag({
      id: `BAG-${pad(nextCounter(state, 'bag'), 6)}`, traveler_id: t.id, flight_id: flight.id, collection_area_id: area.id,
      warehouse_id: area.warehouse_id ?? null, airport_id: 'JED', extra: i >= policy.bags_allowed, created_at: nowIso(ctx),
    });
    bag.status_history = [{ from: null, to: 'Declared', at: nowIso(ctx), by: user.id, role: user.role, note: 'Booked residence collection' }];
    state.bags.push(bag);
    bags.push(bag);
  }
  const assignment = {
    id: `ASG-${pad(nextCounter(state, 'assignment'), 6)}`, traveler_id: t.id, residence_id: res.id, slot_id: slotRow.id, flight_id: flight.id,
    collection_area_id: area.id, check_in_staff_id: staff?.id ?? null, route_order: null, status: 'Assigned', bags_declared: n,
    extra_bags: extraCount, extra_approval: extraCount ? 'Pending' : null, eta: null, arrived_at: null, collected_at: null, gps: null, created_at: nowIso(ctx),
  };
  state.collectionAssignments.push(assignment);
  slotRow.booked_count += 1;

  integrations().sms.send(state, { traveler_id: t.id, phone: res.contact_phone, text: `Rabel: keep your ${n} bag(s) ready at ${res.building}, flat ${res.flat_no} at ${fmtTime(slotRow.start)}–${fmtTime(slotRow.end)}.` }, ctx);
  audit(state, { user, now: ctx.now }, { action: 'assignment.book', entity: 'CollectionAssignment', entityId: assignment.id, after: { bags: n, slot: slotRow.id } });
  return { assignment, bags, slot: slotRow, extraCount };
}

/** Move an assignment to another slot, keeping both slots' booked counts right. */
export function moveSlot(state, a, slotId, status) {
  const prev = state.collectionSlots.find((s) => s.id === a.slot_id);
  const next = state.collectionSlots.find((s) => s.id === slotId);
  if (prev && prev.id !== next.id) prev.booked_count = Math.max(0, prev.booked_count - 1);
  if (!prev || prev.id !== next.id) next.booked_count += 1;
  const before = { slot_id: a.slot_id, status: a.status };
  a.slot_id = next.id;
  a.status = status;
  a.eta = null;
  return before;
}

/** Pick a new slot (after "Traveler Absent", or to move a booking). */
export function rescheduleAssignment(state, assignmentId, slotId, ctx = {}) {
  const a = state.collectionAssignments.find((x) => x.id === assignmentId);
  if (!a) throw new ServiceError('NOT_FOUND', 'Booking not found.');
  const t = state.travelers.find((x) => x.id === a.traveler_id);
  const user = travelerUser(t);
  assertCan(user, 'assignment:reschedule', a);
  if (!['Traveler Absent', 'Rescheduled', 'Assigned'].includes(a.status)) throw new ServiceError('INVALID_STATE', `A booking that is "${a.status}" cannot be rescheduled.`);
  const slot = availableSlots(state, t.id, ctx).find((s) => s.id === slotId);
  if (!slot) throw new ServiceError('SLOT_UNAVAILABLE', 'That slot is not available inside your collection window.');
  if (slot.full && slot.id !== a.slot_id) throw new ServiceError('SLOT_FULL', 'That slot is full.');
  const before = moveSlot(state, a, slotId, 'Assigned');
  audit(state, { user, now: ctx.now }, { action: 'assignment.reschedule', entity: 'CollectionAssignment', entityId: a.id, before, after: { slot_id: a.slot_id, status: a.status } });
  return a;
}

function fmtTime(iso) { return new Date(iso).toISOString().slice(11, 16); }

/* ───────────────────────── tracking / receipt ───────────────────────── */

/** The 13-status timeline for the traveler's bags (a step is done when ALL bags reached it). */
export function trackingFor(state, travelerId, ctx = {}) {
  const t = state.travelers.find((x) => x.id === travelerId);
  if (!t) throw new ServiceError('NOT_FOUND', 'Traveler not found.');
  assertCan(travelerUser(t), 'bag:read', { traveler_id: t.id });
  const flight = state.flights.find((f) => f.id === t.flight_id) || null;
  const rebookedTo = flight?.rebooked_to_flight_id ? state.flights.find((f) => f.id === flight.rebooked_to_flight_id) : null;
  const assignment = activeAssignment(state, t.id) || [...state.collectionAssignments].reverse().find((a) => a.traveler_id === t.id) || null;
  const slot = assignment ? state.collectionSlots.find((s) => s.id === assignment.slot_id) : null;
  const residence = state.residences.find((r) => r.id === t.residence_id) || null;
  const bags = state.bags.filter((b) => b.traveler_id === t.id);
  const idx = bags.map((b) => BAG_STATUSES.indexOf(b.status));
  const side = bags.find((b) => Object.values(SIDE_STATUSES).includes(b.status))?.status ?? null;
  const minIdx = bags.length && !side ? Math.min(...idx) : -1;
  const timeline = BAG_STATUSES.map((s, i) => ({ status: s, done: minIdx >= i, current: minIdx + 1 === i }));
  const banners = [];
  if (flight?.status === 'Cancelled') banners.push({ kind: 'cancelled', text: 'Flight cancelled — bags held safely in our warehouse' });
  if (rebookedTo) banners.push({ kind: 'rebooked', text: `Your flight was rebooked to ${rebookedTo.code}.` });
  if (assignment?.status === 'Traveler Absent') banners.push({ kind: 'absent', text: 'We missed you — choose a new slot' });
  const checkedIn = bags.length > 0 && bags.every((b) => BAG_STATUSES.indexOf(b.status) >= BAG_STATUSES.indexOf('Checked-in') || side);
  return {
    traveler: t, flight, rebookedTo, assignment, slot, residence, bags, timeline, side, banners, airline: state.airlines.find((a) => a.code === flight?.airline_code) || null,
    collector: assignment && assignment.status === 'En Route'
      ? { name: state.users.find((u) => u.id === assignment.check_in_staff_id)?.name || 'Collector', eta: assignment.eta } : null,
    receipt: checkedIn && bags.length ? { no: `RCPT-${assignment?.id || t.id}`, bags: bags.map((b) => ({ tag_no: b.tag_no, airline_tag_no: b.airline_tag_no, weight_kg: b.weight_kg })) } : null,
    now: nowIso(ctx),
  };
}

export function notificationsFor(state, travelerId) {
  return state.notifications.filter((n) => n.traveler_id === travelerId).sort((a, b) => b.at.localeCompare(a.at));
}

/** "Contact support" — notifies Backend + Ops. */
export function requestSupport(state, travelerId, message, ctx = {}) {
  const t = state.travelers.find((x) => x.id === travelerId);
  if (!t) throw new ServiceError('NOT_FOUND', 'Traveler not found.');
  if (!String(message || '').trim()) throw new ServiceError('INVALID', 'Please write a short message.');
  notify(state, { role_list: [ROLE.BACKEND, ROLE.OPS_MANAGER], title: `Traveler support: ${t.name}`, body: String(message).trim().slice(0, 500), severity: 'warning' }, ctx);
  audit(state, { user: travelerUser(t), now: ctx.now }, { action: 'support.request', entity: 'Traveler', entityId: t.id });
}

