/**
 * checkinService — everything Check-in Staff do AT THE TRAVELER'S RESIDENCE (there is no counter):
 * assignment list → start route → arrived → identity → bag count → weigh → attach & scan tags →
 * count match → complete check-in (bags → Checked-in) → hand bags to Transport.
 *
 * All bag status changes go through bagService.advanceBag; permissions through rbac; scans through
 * scanService.recordScan.
 */
import { assertCan, scopeFilter } from '../rbac.js';
import { forecast } from '../time/window.js';
import { makeBag } from '../models.js';
import { advanceBag } from './bagService.js';
import { audit, nextCounter, nowIso } from './audit.js';
import { notify } from './notify.js';
import { raiseException } from './exceptionService.js';
import { recordScan } from './scanService.js';
import { ServiceError } from './errors.js';
import { validateLpn } from '../tags/validateLpn.js';
import { integrations } from '../integrations/index.js';
import { airlinePolicyFor, availableSlots, moveSlot } from './travelerService.js';

const ms = (d) => new Date(d).getTime();
const norm = (s) => String(s || '').trim().toUpperCase();
const MAX_SCALE_KG = 60;

/* ───────────────────────── lookups ───────────────────────── */

function getAssignment(state, id, user) {
  const a = state.collectionAssignments.find((x) => x.id === id);
  if (!a) throw new ServiceError('NOT_FOUND', 'Assignment not found.');
  assertCan(user, 'assignment:update', a);
  return a;
}
const travelerOf = (state, a) => state.travelers.find((t) => t.id === a.traveler_id);

/** The bags still in play for this assignment (withdrawn bags — left with the traveler — are excluded). */
export function activeBags(state, a) {
  return state.bags.filter((b) => b.traveler_id === a.traveler_id && b.flight_id === a.flight_id && !b.withdrawn && !b.legacy)
    .sort((x, y) => x.id.localeCompare(y.id));
}

/* ───────────────────────── list + route ───────────────────────── */

/** Great-circle-ish distance (km) good enough for ordering stops in one district. */
function dist(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  return 6371 * Math.sqrt(dLat * dLat + dLng * dLng);
}

/** Nearest-neighbour stop order from `origin`. Items without coordinates go last (stable). @returns {string[]} ids in visiting order */
export function routeOrder(origin, stops) {
  const withPos = stops.filter((s) => s.lat != null && s.lng != null);
  const without = stops.filter((s) => s.lat == null || s.lng == null).map((s) => s.id);
  const order = [];
  let cur = origin;
  const left = [...withPos];
  while (left.length) {
    left.sort((a, b) => dist(cur, a) - dist(cur, b) || a.id.localeCompare(b.id));
    const next = left.shift();
    order.push(next.id);
    cur = next;
  }
  return [...order, ...without];
}

const OPEN_STATUSES = ['Assigned', 'Rescheduled', 'En Route', 'Arrived', 'Collected'];

/**
 * My area's assignments, grouped by slot and sorted by flight priority (P1 first), with everything the
 * staff card shows. Read-only.
 * @returns {{ slot: any, items: any[] }[]}
 */
export function listAssignments(state, user, { now = Date.now(), includeDone = false } = {}) {
  const mine = scopeFilter(user, 'collectionAssignments', state.collectionAssignments)
    .filter((a) => includeDone || OPEN_STATUSES.includes(a.status));
  const ranks = new Map(forecast(state.flights, state.bags, now).map((f) => [f.id, f.priority_rank]));
  const items = mine.map((a) => {
    const traveler = state.travelers.find((t) => t.id === a.traveler_id);
    const residence = state.residences.find((r) => r.id === a.residence_id) || null;
    const flight = state.flights.find((f) => f.id === a.flight_id) || null;
    const slot = state.collectionSlots.find((s) => s.id === a.slot_id) || null;
    const bags = activeBags(state, a);
    const releasedTags = state.bagTags.filter((t) => t.tag_type === 'IATA_LPN' && t.traveler_id === a.traveler_id && t.flight_id === a.flight_id && t.status === 'Released').length;
    return {
      assignment: a, traveler, residence, flight, slot, bags, priority: ranks.get(a.flight_id) ?? 99, releasedTags,
      boardingPass: traveler?.boarding_pass_verified ? 'Verified' : (traveler?.boarding_pass_flag ? 'Flagged' : 'Not verified'),
      mapsUrl: residence?.lat != null ? `https://www.google.com/maps?q=${residence.lat},${residence.lng}` : null,
      routeOrder: a.route_order,
    };
  });
  // route order per slot (nearest neighbour from the area centre) — computed, persisted when the route starts
  const area = state.collectionAreas.find((x) => x.id === user.area_id);
  const bySlot = new Map();
  for (const it of items) { const k = it.slot?.id ?? 'none'; if (!bySlot.has(k)) bySlot.set(k, []); bySlot.get(k).push(it); }
  const groups = [...bySlot.values()].map((arr) => {
    if (area?.lat != null) {
      const ord = routeOrder(area, arr.map((i) => ({ id: i.assignment.id, lat: i.residence?.lat, lng: i.residence?.lng })));
      arr.forEach((i) => { i.routeOrder = i.assignment.route_order ?? ord.indexOf(i.assignment.id) + 1; });
    }
    arr.sort((x, y) => x.priority - y.priority || (x.routeOrder ?? 99) - (y.routeOrder ?? 99) || x.assignment.id.localeCompare(y.assignment.id));
    return { slot: arr[0].slot, items: arr };
  });
  return groups.sort((a, b) => ms(a.slot?.start ?? 0) - ms(b.slot?.start ?? 0));
}

/* ───────────────────────── route / arrival / absent ───────────────────────── */

export function startRoute(state, id, { etaMinutes = 20 } = {}, ctx) {
  const a = getAssignment(state, id, ctx.user);
  if (!['Assigned', 'Rescheduled'].includes(a.status)) throw new ServiceError('INVALID_STATE', `A collection that is "${a.status}" cannot start a route.`);
  const slot = state.collectionSlots.find((s) => s.id === a.slot_id);
  const area = state.collectionAreas.find((x) => x.id === a.collection_area_id);
  const res = state.residences.find((r) => r.id === a.residence_id);
  const peers = state.collectionAssignments.filter((x) => x.slot_id === a.slot_id && x.collection_area_id === a.collection_area_id && OPEN_STATUSES.includes(x.status));
  if (area?.lat != null) {
    const ord = routeOrder(area, peers.map((p) => { const r = state.residences.find((q) => q.id === p.residence_id); return { id: p.id, lat: r?.lat, lng: r?.lng }; }));
    a.route_order = ord.indexOf(a.id) + 1;
  }
  a.status = 'En Route';
  a.eta = new Date(ms(nowIso(ctx)) + etaMinutes * 60e3).toISOString();
  a.check_in_staff_id = ctx.user.id;
  const t = travelerOf(state, a);
  notify(state, { traveler_id: t.id, title: 'Your collector is on the way', body: `${ctx.user.name} will arrive around ${a.eta.slice(11, 16)} UTC.` }, ctx);
  integrations().sms.send(state, { traveler_id: t.id, phone: res?.contact_phone, text: `Rabel: ${ctx.user.name} is on the way to collect your bags (ETA ${etaMinutes} min).` }, ctx);
  audit(state, ctx, { action: 'assignment.start_route', entity: 'CollectionAssignment', entityId: a.id, after: { eta: a.eta, route_order: a.route_order, slot: slot?.id } });
  return a;
}

export function markArrived(state, id, { gps = null } = {}, ctx) {
  const a = getAssignment(state, id, ctx.user);
  if (a.status !== 'En Route') throw new ServiceError('INVALID_STATE', 'Start the route before marking arrival.');
  a.status = 'Arrived';
  a.arrived_at = nowIso(ctx);
  a.gps = gps ? { lat: gps.lat ?? null, lng: gps.lng ?? null, accuracy: gps.accuracy ?? null, simulated: !!gps.simulated } : null;
  audit(state, ctx, { action: 'assignment.arrived', entity: 'CollectionAssignment', entityId: a.id, after: { gps: a.gps } });
  return a;
}

/**
 * Identity: passport last 4 digits + photo. Already verified by Backend → green tick. Not verified →
 * "Call supervisor" and STOP (Ops is notified).
 */
export function confirmIdentity(state, id, { last4, photoOk }, ctx) {
  const a = getAssignment(state, id, ctx.user);
  if (a.status !== 'Arrived') throw new ServiceError('INVALID_STATE', 'Mark arrival before checking identity.');
  const t = travelerOf(state, a);
  assertCan(ctx.user, 'traveler:read', t);
  if (!t.data_verified) {
    a.supervisor_called = true;
    notify(state, { role: 'ops_manager', title: `Supervisor needed: ${t.name}`, body: 'Traveler data is not verified by Backend. Check-in stopped at the residence.', severity: 'critical' }, ctx);
    audit(state, ctx, { action: 'checkin.supervisor_called', entity: 'CollectionAssignment', entityId: a.id });
    throw new ServiceError('NOT_VERIFIED', 'This traveler has not been verified by Backend. Call your supervisor — check-in is stopped.');
  }
  if (!photoOk) throw new ServiceError('PHOTO_MISMATCH', 'Confirm the traveler matches the photo.');
  if (!/^[A-Z0-9]{4}$/.test(norm(last4)) || norm(last4) !== norm(t.passport).slice(-4)) {
    a.identity_attempts = (a.identity_attempts || 0) + 1;
    if (a.identity_attempts >= 3) {
      raiseException(state, { type: 'Data Mismatch', severity: 'High', assignment_id: a.id, traveler_id: t.id, flight_id: a.flight_id, area_id: a.collection_area_id, notes: 'Passport last 4 digits do not match after 3 attempts.' }, ctx);
    }
    throw new ServiceError('PASSPORT_MISMATCH', 'The last 4 characters of the passport do not match.');
  }
  a.identity = { verified: true, at: nowIso(ctx), by: ctx.user.id };
  audit(state, ctx, { action: 'checkin.identity', entity: 'CollectionAssignment', entityId: a.id });
  return a;
}

/**
 * Traveler not at the residence: exception + reschedule inside the window, or Ops is told if the
 * window is closing (no slot left).
 * @returns {{ assignment: any, rescheduleOffered: boolean, opsNotified: boolean, slots: any[] }}
 */
export function markAbsent(state, id, ctx) {
  const a = getAssignment(state, id, ctx.user);
  if (!['En Route', 'Arrived'].includes(a.status)) throw new ServiceError('INVALID_STATE', 'Only a collection in progress can be marked "Traveler Absent".');
  const t = travelerOf(state, a);
  a.status = 'Traveler Absent';
  a.absent_at = nowIso(ctx);
  raiseException(state, { type: 'Traveler Absent', severity: 'Medium', assignment_id: a.id, traveler_id: t.id, flight_id: a.flight_id, area_id: a.collection_area_id, notes: `${t.name} was not at the residence.` }, ctx);
  const slots = availableSlots(state, t.id, ctx).filter((s) => !s.full && s.id !== a.slot_id);
  let opsNotified = false;
  if (slots.length) {
    notify(state, { traveler_id: t.id, title: 'We missed you', body: 'We missed you — choose a new collection slot in the app.', severity: 'warning' }, ctx);
    integrations().sms.send(state, { traveler_id: t.id, text: 'Rabel: We missed you — please choose a new collection slot in the app.' }, ctx);
  } else {
    opsNotified = true;
    notify(state, { role: 'ops_manager', title: `Window closing: ${t.name} was absent`, body: 'No collection slot is left inside the flight window.', severity: 'critical' }, ctx);
  }
  audit(state, ctx, { action: 'assignment.absent', entity: 'CollectionAssignment', entityId: a.id, after: { rescheduleOffered: slots.length > 0, opsNotified } });
  return { assignment: a, rescheduleOffered: slots.length > 0, opsNotified, slots };
}

/** Staff books the absent traveler a new slot right away (status "Rescheduled"). */
export function offerSlot(state, id, slotId, ctx) {
  const a = getAssignment(state, id, ctx.user);
  if (a.status !== 'Traveler Absent') throw new ServiceError('INVALID_STATE', 'Only an absent traveler can be rescheduled here.');
  const t = travelerOf(state, a);
  const slot = availableSlots(state, t.id, ctx).find((s) => s.id === slotId);
  if (!slot || slot.full) throw new ServiceError('SLOT_UNAVAILABLE', 'That slot is not available inside the flight window.');
  const before = moveSlot(state, a, slotId, 'Rescheduled');
  notify(state, { traveler_id: t.id, title: 'Collection rescheduled', body: 'Your bag collection has a new time. Open the app for details.' }, ctx);
  audit(state, ctx, { action: 'assignment.offer_slot', entity: 'CollectionAssignment', entityId: a.id, before, after: { slot_id: slotId } });
  return a;
}

/* ───────────────────────── bag count vs allowance ───────────────────────── */

/**
 * Bags presented vs the declared/allowed amount.
 *  fewer  → the missing bags are left out (withdrawn) + Count Mismatch exception
 *  extra within the airline's extra_bags_max → extra bag(s) declared + tag request to Backend
 *  extra beyond the limit → the extra bag(s) stay with the traveler + "Over Airline Limit" exception
 */
export function checkBagCount(state, id, { presented }, ctx) {
  const a = getAssignment(state, id, ctx.user);
  if (a.status !== 'Arrived' || !a.identity?.verified) throw new ServiceError('INVALID_STATE', 'Verify the traveler’s identity first.');
  const n = Number(presented);
  if (!Number.isInteger(n) || n < 0 || n > 10) throw new ServiceError('INVALID', 'Enter how many bags the traveler presented.');
  const t = travelerOf(state, a);
  const pol = airlinePolicyFor(state, t);
  const allowed = pol.bags_allowed + pol.extra_bags_max;
  const bags = activeBags(state, a);
  const declared = bags.length;
  const out = { presented: n, declared, allowed, outcome: 'ok', extraRequested: 0, leftWithTraveler: 0, withdrawn: 0 };

  if (n < declared) {
    for (const b of bags.slice(n)) { b.withdrawn = true; b.withdrawn_reason = 'Not presented at the residence'; out.withdrawn++; }
    out.outcome = 'fewer';
    raiseException(state, { type: 'Count Mismatch', severity: 'Medium', assignment_id: a.id, traveler_id: t.id, flight_id: a.flight_id, area_id: a.collection_area_id, notes: `${declared} bag(s) declared, ${n} presented.` }, ctx);
  } else if (n > declared) {
    const accept = Math.min(n, allowed) - declared;
    if (accept > 0) {
      const area = state.collectionAreas.find((x) => x.id === a.collection_area_id);
      for (let i = 0; i < accept; i++) {
        state.bags.push(makeBag({
          id: `BAG-${String(nextCounter(state, 'bag')).padStart(6, '0')}`, traveler_id: t.id, flight_id: a.flight_id, collection_area_id: a.collection_area_id,
          warehouse_id: area?.warehouse_id ?? null, airport_id: 'JED', extra: true, created_at: nowIso(ctx),
        }));
      }
      a.extra_bags = (a.extra_bags || 0) + accept;
      a.extra_approval = 'Requested';
      out.extraRequested = accept;
      out.outcome = 'extra_requested';
      notify(state, { role: 'backend', title: `Extra tag request: ${t.name}`, body: `${accept} extra bag(s) presented at the residence (${t.name}, ${a.id}). Please verify and issue tag(s).`, severity: 'warning' }, ctx);
    }
    if (n > allowed) {
      out.leftWithTraveler = n - allowed;
      out.outcome = accept > 0 ? 'extra_requested' : 'over_limit';
      raiseException(state, { type: 'Over Airline Limit', severity: 'Medium', assignment_id: a.id, traveler_id: t.id, flight_id: a.flight_id, area_id: a.collection_area_id, notes: `${n} bags presented; ${pol.airline.code} allows ${allowed}. ${out.leftWithTraveler} stay with the traveler.` }, ctx);
    }
  }
  a.bags_declared = activeBags(state, a).length;
  a.count_check = out;
  audit(state, ctx, { action: 'checkin.bag_count', entity: 'CollectionAssignment', entityId: a.id, after: out });
  return out;
}

/** Leave a bag with the traveler (e.g. an extra bag whose tag Backend has not issued). */
export function withdrawBag(state, bagId, reason, ctx) {
  const bag = state.bags.find((b) => b.id === bagId);
  if (!bag) throw new ServiceError('NOT_FOUND', 'Bag not found.');
  assertCan(ctx.user, 'bag:update', bag);
  if (!['Declared', 'Data Verified', 'Tag Assigned'].includes(bag.status)) throw new ServiceError('INVALID_STATE', 'Only a bag that has not been checked in can be left with the traveler.');
  if (!String(reason || '').trim()) throw new ServiceError('REASON_REQUIRED', 'A reason is required.');
  bag.withdrawn = true;
  bag.withdrawn_reason = reason.trim();
  const a = state.collectionAssignments.find((x) => x.traveler_id === bag.traveler_id && x.flight_id === bag.flight_id && OPEN_STATUSES.includes(x.status));
  if (a) a.bags_declared = activeBags(state, a).length;
  audit(state, ctx, { action: 'bag.withdraw', entity: 'Bag', entityId: bag.id, note: reason.trim() });
  return bag;
}

/* ───────────────────────── weigh ───────────────────────── */

/**
 * Weigh all bags on one screen. Each row: weight, "Meets airline criteria ✓/✗ (max X kg)", and
 * "Repack required" on ✗ rows only. Can be re-run after a repack.
 * @param {Record<string, number|string>} weights bagId → kg
 * @returns {{ bag_id: string, weight_kg: number, meets: boolean, max: number, repack: boolean }[]}
 */
export function recordWeights(state, id, weights, ctx) {
  const a = getAssignment(state, id, ctx.user);
  if (a.status !== 'Arrived' || !a.identity?.verified) throw new ServiceError('INVALID_STATE', 'Verify the traveler’s identity before weighing.');
  const max = airlinePolicyFor(state, travelerOf(state, a)).max_bag_weight_kg;
  const bags = activeBags(state, a);
  const rows = [];
  for (const b of bags) {
    if (!(b.id in weights) || weights[b.id] === '' || weights[b.id] == null) continue;
    const w = Number(weights[b.id]);
    if (!Number.isFinite(w) || w <= 0 || w > MAX_SCALE_KG) throw new ServiceError('INVALID_WEIGHT', `Enter a weight between 0.1 and ${MAX_SCALE_KG} kg.`);
    b.weight_kg = Math.round(w * 10) / 10;
    b.meets_airline_criteria = b.weight_kg <= max;
    rows.push({ bag_id: b.id, weight_kg: b.weight_kg, meets: b.meets_airline_criteria, max, repack: !b.meets_airline_criteria });
  }
  audit(state, ctx, { action: 'checkin.weigh', entity: 'CollectionAssignment', entityId: a.id, after: { rows: rows.length, repack: rows.filter((r) => r.repack).length } });
  return rows;
}

/* ───────────────────────── tags: attach & scan ───────────────────────── */

const swap = (x, y, key) => { const t = x[key]; x[key] = y[key]; y[key] = t; };

/** Does this bag need the airline tag scan? (A bag with no LPN runs on the internal label only.) */
export function needsAirlineScan(bag) { return !!bag.airline_tag_no; }

/**
 * One scan at the residence: the airline tag (ITF, once) or the Rabel internal label (once) for ONE bag.
 * The app binds the scanned tag/label to that bag (swapping with the traveler's other bag if needed).
 * Every scan is saved as a ScanEvent with its method. Failures return { ok:false } with the exact error
 * (Invalid format / Duplicate / Not released / Wrong flight …) and raise the matching exception.
 *
 * @param {{ value: string, method: 'HANDHELD'|'CAMERA'|'MANUAL', symbology?: string, device_id?: string }} scan
 * @returns {{ ok: boolean, result: string, message: string, bag: any, exception?: any }}
 */
export function scanTag(state, assignmentId, bagId, kind, scan, ctx) {
  const a = getAssignment(state, assignmentId, ctx.user);
  assertCan(ctx.user, 'tag:attach', state.bags.find((b) => b.id === bagId) || a);
  if (a.status !== 'Arrived' || !a.identity?.verified) throw new ServiceError('INVALID_STATE', 'Verify the traveler’s identity before attaching tags.');
  const bags = activeBags(state, a);
  const bag = bags.find((b) => b.id === bagId);
  if (!bag) throw new ServiceError('NOT_FOUND', 'Bag not found on this assignment.');
  const t = travelerOf(state, a);
  const step = kind === 'AIRLINE' ? 'RESIDENCE_AIRLINE_TAG' : 'RESIDENCE_INTERNAL_LABEL';
  const base = { step, method: scan.method, symbology: scan.symbology, device_id: scan.device_id, raw_value: scan.value, flight_id: a.flight_id, traveler_id: t.id, bag_id: bag.id, assignment_id: a.id };
  const fail = (result, message, exceptionType, code) => {
    recordScan(state, { ...base, result, note: message }, ctx);
    const exception = exceptionType ? raiseException(state, { type: exceptionType, severity: 'Medium', assignment_id: a.id, traveler_id: t.id, flight_id: a.flight_id, bag_id: bag.id, value: String(scan.value), area_id: a.collection_area_id, notes: message }, ctx) : undefined;
    return { ok: false, result, code, message, bag, exception };
  };

  if (bag.status !== 'Tag Assigned') {
    return fail('WRONG_STEP', bag.status === 'Checked-in' ? 'This bag is already checked in.' : 'Tags for this bag have not been released by Backend yet.', 'Tag Not Released', 'NOT_RELEASED');
  }

  if (kind === 'AIRLINE') {
    if (!needsAirlineScan(bag)) return fail('WRONG_STEP', 'This bag runs on the internal label only — no airline tag to scan.', null, 'NO_AIRLINE_TAG');
    const airline = state.airlines.find((x) => x.code === state.flights.find((f) => f.id === a.flight_id)?.airline_code);
    const v = validateLpn(scan.value, { mode: 'scan', airline, tags: state.bagTags, flightId: a.flight_id, travelerId: t.id });
    if (!v.ok) return fail(v.result, v.message, v.exception_type, v.code);
    const tag = v.tag;
    // the tag must be one of THIS traveler's bags' tags; swap with whichever bag currently holds it
    const holder = bags.find((b) => b.id === tag.bag_id);
    if (!holder) return fail('UNKNOWN', 'That tag is not assigned to any of this traveler’s bags.', 'Wrong Flight Tag', 'NOT_THIS_TRAVELER');
    if (holder.id !== bag.id) {
      const mine = state.bagTags.find((x) => x.tag_type === 'IATA_LPN' && x.bag_id === bag.id && x.status !== 'Void');
      swap(bag, holder, 'airline_tag_no');
      tag.bag_id = bag.id;
      if (mine) mine.bag_id = holder.id;
      if (holder.airline_scanned) { holder.airline_scanned = false; holder.tag_verified = false; }
    }
    tag.status = 'Attached';
    bag.airline_scanned = true;
    recordScan(state, { ...base, result: 'OK' }, ctx);
  } else {
    const value = norm(scan.value);
    const owner = state.bags.find((b) => norm(b.tag_no) === value);
    if (!owner) return fail('UNKNOWN', `"${scan.value}" is not a Rabel label.`, null, 'UNKNOWN_LABEL');
    if (owner.traveler_id !== a.traveler_id) return fail('UNKNOWN', 'That label belongs to another traveler.', null, 'OTHER_TRAVELER');
    const holder = bags.find((b) => b.id === owner.id);
    if (!holder) return fail('UNKNOWN', 'That label belongs to a bag that is not part of this collection.', null, 'NOT_ACTIVE');
    if (holder.internal_scanned) return fail('DUPLICATE', `Label ${holder.tag_no} was already scanned.`, null, 'DUPLICATE_LABEL');
    if (holder.id !== bag.id) {
      const rows = state.bagTags.filter((x) => x.tag_type === 'INTERNAL' && (x.bag_id === bag.id || x.bag_id === holder.id));
      swap(bag, holder, 'tag_no');
      for (const r of rows) r.bag_id = r.bag_id === bag.id ? holder.id : bag.id;
      if (holder.internal_scanned) { holder.internal_scanned = false; holder.tag_verified = false; }
    }
    bag.internal_scanned = true;
    recordScan(state, { ...base, result: 'OK' }, ctx);
  }
  bag.tag_verified = !!bag.internal_scanned && (!needsAirlineScan(bag) || !!bag.airline_scanned);
  audit(state, ctx, { action: 'tag.scan', entity: 'Bag', entityId: bag.id, after: { kind, verified: bag.tag_verified } });
  return { ok: true, result: 'OK', message: kind === 'AIRLINE' ? `Airline tag ${bag.airline_tag_no} bound.` : `Label ${bag.tag_no} bound.`, bag };
}

/** "Damaged tag": ask Backend for a replacement (Backend voids the LPN and releases a spare). */
export function requestDamagedTag(state, bagId, reason, ctx) {
  const bag = state.bags.find((b) => b.id === bagId);
  if (!bag) throw new ServiceError('NOT_FOUND', 'Bag not found.');
  assertCan(ctx.user, 'tag:request_replacement', bag);
  if (!bag.airline_tag_no) throw new ServiceError('NO_AIRLINE_TAG', 'This bag has no airline tag to replace.');
  const tag = state.bagTags.find((x) => x.tag_type === 'IATA_LPN' && x.lpn === bag.airline_tag_no && x.status !== 'Void');
  const t = state.travelers.find((x) => x.id === bag.traveler_id);
  const exc = raiseException(state, { type: 'Damaged Tag', severity: 'Medium', traveler_id: bag.traveler_id, flight_id: bag.flight_id, bag_id: bag.id, tag_id: tag?.id ?? null, value: bag.airline_tag_no, area_id: bag.collection_area_id,
    notes: `Damaged tag ${bag.airline_tag_no} (${t?.name || bag.traveler_id}): ${String(reason || 'damaged').trim()}` }, ctx);
  notify(state, { role: 'backend', title: 'Replacement tag requested', body: exc.notes, severity: 'warning' }, ctx);
  bag.airline_scanned = false;
  bag.tag_verified = false;
  return exc;
}

/* ───────────────────────── count match + complete + hand-off ───────────────────────── */

/** declared = weighed = tags scanned, and every bag meets the airline criteria. */
export function countMatch(state, id) {
  const a = state.collectionAssignments.find((x) => x.id === id);
  if (!a) throw new ServiceError('NOT_FOUND', 'Assignment not found.');
  const bags = activeBags(state, a);
  const declared = bags.length;
  const weighed = bags.filter((b) => b.weight_kg > 0).length;
  const tagged = bags.filter((b) => b.tag_verified).length;
  const repack = bags.filter((b) => b.weight_kg > 0 && b.meets_airline_criteria === false).length;
  const blockers = [];
  if (!declared) blockers.push('No bags to check in.');
  if (declared !== weighed) blockers.push(`${declared - weighed} bag(s) not weighed`);
  if (declared !== tagged) blockers.push(`${declared - tagged} bag(s) without tags scanned`);
  if (repack) blockers.push(`${repack} bag(s) need repacking`);
  if (!a.identity?.verified) blockers.push('Identity not verified');
  return { declared, weighed, tagged, repack, ok: blockers.length === 0, blockers };
}

/** Complete check-in: every bag Tag Assigned → Checked-in (advanceBag), digital receipt, assignment Collected. */
export function completeCheckin(state, id, ctx) {
  const a = getAssignment(state, id, ctx.user);
  if (a.status !== 'Arrived') throw new ServiceError('INVALID_STATE', 'Only an assignment in progress can be completed.');
  const m = countMatch(state, id);
  if (!m.ok) throw new ServiceError('COUNT_MISMATCH', `Cannot complete check-in: ${m.blockers.join('; ')}.`);
  const bags = activeBags(state, a);
  for (const b of bags) advanceBag(state, b.id, 'Checked-in', { user: ctx.user, now: ctx.now, countMatch: true, note: 'Checked in at the residence' });
  for (const b of bags) {
    const tag = state.bagTags.find((x) => x.tag_type === 'IATA_LPN' && x.bag_id === b.id && x.status === 'Attached');
    if (tag) tag.status = 'Scanned';
  }
  a.status = 'Collected';
  a.collected_at = nowIso(ctx);
  a.receipt = {
    no: `RCPT-${a.id}`, at: a.collected_at,
    bags: bags.map((b) => ({ bag_id: b.id, tag_no: b.tag_no, airline_tag_no: b.airline_tag_no, weight_kg: b.weight_kg })),
  };
  const t = travelerOf(state, a);
  const res = state.residences.find((r) => r.id === a.residence_id);
  const list = a.receipt.bags.map((b) => b.airline_tag_no || b.tag_no).join(', ');
  notify(state, { traveler_id: t.id, title: 'Bags checked in — digital receipt', body: `Tags: ${list}` }, ctx);
  integrations().sms.send(state, { traveler_id: t.id, phone: res?.contact_phone, text: `Rabel: ${bags.length} bag(s) checked in. Tags: ${list}. Receipt ${a.receipt.no}.` }, ctx);
  audit(state, ctx, { action: 'checkin.complete', entity: 'CollectionAssignment', entityId: a.id, after: { bags: bags.length, receipt: a.receipt.no } });
  return a;
}

/** Hand the checked-in bags to Transport at the residence pickup point (area pending_pickups +n). */
export function handToTransport(state, id, ctx) {
  const a = getAssignment(state, id, ctx.user);
  if (a.status !== 'Collected') throw new ServiceError('INVALID_STATE', 'Complete check-in before handing bags to Transport.');
  const n = activeBags(state, a).filter((b) => b.status === 'Checked-in').length;
  const area = state.collectionAreas.find((x) => x.id === a.collection_area_id);
  if (area) area.pending_pickups = (area.pending_pickups || 0) + n;
  a.status = 'Handed to Transport';
  a.handed_at = nowIso(ctx);
  a.handed_bag_ids = activeBags(state, a).map((b) => b.id);
  notify(state, { role: 'transport_manager', title: `${n} bag(s) ready for pickup in ${area?.name || 'area'}`, body: `Residence pickup point: ${state.residences.find((r) => r.id === a.residence_id)?.building || ''}.` }, ctx);
  audit(state, ctx, { action: 'assignment.handed_to_transport', entity: 'CollectionAssignment', entityId: a.id, after: { bags: n, area_pending: area?.pending_pickups } });
  return { assignment: a, bags: n };
}
