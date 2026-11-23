/**
 * flightService — the ONLY place a Flight row changes (Operations Manager).
 *
 *   listFlights / flightDetail / forecastBoard   read models for the Ops screens
 *   createFlight / updateFlight                  a new flight; a corrected route or cut-off
 *   cancelFlight                                 the status change + the fan-out every role sees
 *   rebookBags                                   held bags -> a new flight (via bagService.markRebooked)
 *   closureChecklist / closeFlight               a flight closes only when every bag is accounted for
 *
 * Cancelling a flight does NOT move a bag. Bags already in the line are physically moved to the
 * holding area by the Warehouse Manager (warehouseService.holdBags — that is where the rack is
 * recorded) or by the Airport Coordinator. What cancelling does is call off the collection that has
 * not happened yet and tell every role and every affected traveler.
 */
import {
  SIDE_STATUSES, ACCOUNTED_STATUSES, ROLE, WINDOW,
  PRE_COLLECTION_ASSIGNMENT_STATUSES, OPEN_EXCEPTION_STATUSES,
} from '../constants.js';
import { assertCan, scopeFilter } from '../rbac.js';
import { makeFlight } from '../models.js';
import { statusIndex, markRebooked } from './bagService.js';
import { ensureSlots } from './travelerService.js';
import { forecast, computeAlerts, windowFor, stageAt, slotInsideCollectionWindow } from '../time/window.js';
import { integrations } from '../integrations/index.js';
import { audit, nowIso } from './audit.js';
import { notify } from './notify.js';
import { ServiceError } from './errors.js';

const ms = (d) => new Date(d).getTime();
/** Every role that works a bag — the audience for a cancellation or a closure. */
const OPERATIONAL_ROLES = /** @type {string[]} */ ([
  ROLE.BACKEND, ROLE.CHECKIN, ROLE.TRANSPORT_MANAGER, ROLE.TRANSPORT_STAFF,
  ROLE.WAREHOUSE_MANAGER, ROLE.AIRPORT_COORDINATOR, ROLE.WINDOW_MONITOR, ROLE.OPS_MANAGER,
]);

function findFlight(state, id) {
  const f = (state.flights || []).find((x) => x.id === id);
  if (!f) throw new ServiceError('NOT_FOUND', `Flight ${id} not found.`);
  return f;
}

const bagsOf = (state, flightId) => (state.bags || []).filter((b) => b.flight_id === flightId);
const idx = (status) => statusIndex(status);
const fmtTime = (iso) => (iso ? new Date(iso).toISOString().slice(11, 16) : '—');

/**
 * Where a flight's bags are, in the five groups Ops actually reasons about.
 * @param {object[]} bags
 */
export function bagGroups(bags) {
  const byStatus = /** @type {Record<string, number>} */ ({});
  for (const b of bags) byStatus[b.status] = (byStatus[b.status] || 0) + 1;
  const between = (b, from, to) => idx(b.status) >= idx(from) && idx(b.status) <= idx(to);
  return {
    total: bags.length,
    byStatus,
    withTraveler: bags.filter((b) => idx(b.status) >= 0 && idx(b.status) < idx('Checked-in')).length,
    inTransit: bags.filter((b) => between(b, 'Checked-in', 'In Transit to Airport')).length,
    atAirport: bags.filter((b) => between(b, 'Received at Airport', 'SGS Voucher Accepted')).length,
    loaded: bags.filter((b) => b.status === 'Loaded on Aircraft').length,
    held: bags.filter((b) => b.status === SIDE_STATUSES.HELD).length,
    rebooked: bags.filter((b) => b.status === SIDE_STATUSES.REBOOKED).length,
    returned: bags.filter((b) => b.status === SIDE_STATUSES.RETURNED).length,
    accounted: bags.filter((b) => ACCOUNTED_STATUSES.includes(b.status)).length,
    toMove: bags.filter((b) => !ACCOUNTED_STATUSES.includes(b.status)).length,
  };
}

/** @param {object} state @param {object} flight @param {{ now: number|string|Date, rank?: number|null }} opts */
function flightRow(state, flight, { now, rank = null }) {
  const bags = bagsOf(state, flight.id);
  return {
    flight,
    airline: (state.airlines || []).find((a) => a.code === flight.airline_code) || null,
    window: flight.cut_off_at ? windowFor(flight.cut_off_at) : null,
    stage: flight.cut_off_at ? stageAt(now, flight.cut_off_at) : null,
    counts: bagGroups(bags),
    travelers: (state.travelers || []).filter((t) => t.flight_id === flight.id).length,
    alerts: computeAlerts(now, flight, bags),
    priorityRank: rank,
  };
}

/* ───────────────────────── read models ───────────────────────── */

/**
 * Every flight the user may see: live ones first (earliest cut-off), then cancelled/completed.
 * @param {object} state @param {object} user @param {{ now?: number|string|Date }} [opts]
 */
export function listFlights(state, user, { now = Date.now() } = {}) {
  assertCan(user, 'flight:read');
  const ranks = new Map(forecast(state.flights, state.bags, now).map((f) => [f.id, f.priority_rank]));
  const rows = scopeFilter(user, 'flights', state.flights)
    .filter((f) => !f.legacy)
    .map((f) => flightRow(state, f, { now, rank: ranks.get(f.id) ?? null }));
  const live = (r) => !['Cancelled', 'Completed'].includes(r.flight.status);
  return rows.sort((a, b) => Number(live(b)) - Number(live(a))
    || (live(a) ? ms(a.flight.cut_off_at || 0) - ms(b.flight.cut_off_at || 0) : ms(b.flight.cut_off_at || 0) - ms(a.flight.cut_off_at || 0))
    || String(a.flight.id).localeCompare(String(b.flight.id)));
}

/**
 * One flight in full: its bags (with traveler), trips, open exceptions and the window.
 * @param {object} state @param {string} flightId @param {object} user @param {{ now?: number|string|Date }} [opts]
 */
export function flightDetail(state, flightId, user, { now = Date.now() } = {}) {
  assertCan(user, 'flight:read');
  const flight = findFlight(state, flightId);
  const row = flightRow(state, flight, { now, rank: forecast(state.flights, state.bags, now).find((f) => f.id === flight.id)?.priority_rank ?? null });
  const bags = bagsOf(state, flight.id).map((b) => ({
    bag: b,
    traveler: (state.travelers || []).find((t) => t.id === b.traveler_id) || null,
    area: (state.collectionAreas || []).find((a) => a.id === b.collection_area_id) || null,
  })).sort((a, b) => idx(a.bag.status) - idx(b.bag.status) || String(a.bag.id).localeCompare(String(b.bag.id)));
  return {
    ...row,
    bags,
    trips: (state.trips || []).filter((t) => (t.bag_ids || []).some((id) => bags.some((x) => x.bag.id === id))),
    exceptions: (state.exceptions || []).filter((e) => e.flight_id === flight.id && OPEN_EXCEPTION_STATUSES.includes(e.status)),
    rebookedTo: flight.rebooked_to_flight_id ? (state.flights || []).find((f) => f.id === flight.rebooked_to_flight_id) || null : null,
  };
}

/**
 * The 24-hour forecast board: flights with a cut-off in the next 24 h, most urgent first,
 * each with its stage counts and worst time-rule alert. Recomputed on every call (the screens
 * re-draw every `WINDOW.forecastRefreshMin` minutes).
 * @param {object} state @param {object} user @param {{ now?: number|string|Date }} [opts]
 */
export function forecastBoard(state, user, { now = Date.now() } = {}) {
  assertCan(user, 'flight:read');
  const visible = new Set(scopeFilter(user, 'flights', state.flights).map((f) => f.id));
  return forecast(state.flights, state.bags, now)
    .filter((f) => visible.has(f.id))
    .map((f) => {
      const flight = findFlight(state, f.id);
      const row = flightRow(state, flight, { now, rank: f.priority_rank });
      const worst = row.alerts.find((a) => a.level === 'red') || row.alerts[0] || null;
      return { ...row, bagsToMove: f.bags_to_move, worstAlert: worst, level: worst?.level ?? 'green' };
    });
}

/** Minutes until the forecast is stale (for the screens' "recomputed every 5 min" line). */
export const FORECAST_REFRESH_MIN = WINDOW.forecastRefreshMin;

/* ───────────────────────── create / update ───────────────────────── */

/**
 * A new flight. Status "New" until the airline tag list is imported (Backend).
 * @param {object} state @param {{ code: string, airline_code: string, route?: string, cut_off_at: string|number|Date }} input @param {object} ctx
 */
export function createFlight(state, input, ctx) {
  assertCan(ctx.user, 'flight:create');
  const code = String(input?.code || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!/^[A-Z0-9]{2}\s?\d{1,4}$/.test(code)) throw new ServiceError('INVALID', 'A flight code looks like "SV 1821".');
  const airline = (state.airlines || []).find((a) => a.code === String(input?.airline_code || '').trim().toUpperCase());
  if (!airline) throw new ServiceError('NO_AIRLINE', 'Choose an airline from the airline policy table.');
  if ((state.flights || []).some((f) => String(f.code || '').toUpperCase() === code)) throw new ServiceError('DUPLICATE', `Flight ${code} already exists.`);
  const cut = ms(input?.cut_off_at ?? NaN);
  if (!Number.isFinite(cut)) throw new ServiceError('INVALID', 'A baggage cut-off time is required.');
  if (cut <= ms(nowIso(ctx))) throw new ServiceError('INVALID', 'The baggage cut-off must be in the future.');

  const id = `FLT-${airline.code}-${code.replace(/\D/g, '')}`;
  if ((state.flights || []).some((f) => f.id === id)) throw new ServiceError('DUPLICATE', `Flight ${id} already exists.`);
  const flight = makeFlight({
    id, code, airline_code: airline.code, route: String(input?.route || '').trim() || null,
    status: 'New', cut_off_at: new Date(cut).toISOString(),
  });
  state.flights.push(flight);
  const slots = (state.collectionAreas || []).flatMap((area) => ensureSlots(state, area.id, flight));
  audit(state, ctx, { action: 'flight.create', entity: 'Flight', entityId: flight.id, after: { code: flight.code, cut_off_at: flight.cut_off_at } });
  notify(state, {
    role_list: [ROLE.BACKEND, ROLE.OPS_MANAGER, ROLE.WINDOW_MONITOR],
    title: `New flight ${flight.code}`,
    body: `Cut-off ${flight.cut_off_at}. Import the airline tag list before check-in starts.`,
  }, ctx);
  return { flight, slotsCreated: slots.length };
}

/**
 * Correct a flight's route or cut-off. Moving the cut-off moves the whole 12 h window, so any
 * booked slot that falls outside the new collection window is reported back (and its travelers
 * are asked to pick a new one) rather than silently left behind.
 * @param {object} state @param {string} flightId @param {{ route?: string, cut_off_at?: string|number|Date }} patch @param {object} ctx
 */
export function updateFlight(state, flightId, patch, ctx) {
  assertCan(ctx.user, 'flight:update');
  const flight = findFlight(state, flightId);
  if (['Cancelled', 'Completed'].includes(flight.status)) throw new ServiceError('FLIGHT_CLOSED', `${flight.code} is ${flight.status} — it can no longer be edited.`);
  const before = { route: flight.route, cut_off_at: flight.cut_off_at };
  if (patch?.route !== undefined) flight.route = String(patch.route || '').trim() || null;

  const outside = [];
  let slotsCreated = 0;
  if (patch?.cut_off_at !== undefined) {
    const cut = ms(patch.cut_off_at);
    if (!Number.isFinite(cut)) throw new ServiceError('INVALID', 'That cut-off time is not a valid date.');
    if (cut <= ms(nowIso(ctx))) throw new ServiceError('INVALID', 'The baggage cut-off must be in the future.');
    const next = makeFlight({ ...flight, cut_off_at: new Date(cut).toISOString() });
    flight.cut_off_at = next.cut_off_at;
    flight.window_start_at = next.window_start_at;
    slotsCreated = (state.collectionAreas || []).flatMap((area) => ensureSlots(state, area.id, flight)).length;

    for (const a of (state.collectionAssignments || []).filter((x) => x.flight_id === flight.id && PRE_COLLECTION_ASSIGNMENT_STATUSES.includes(x.status))) {
      const slot = (state.collectionSlots || []).find((s) => s.id === a.slot_id);
      if (!slot || slotInsideCollectionWindow(slot, flight.cut_off_at)) { a.slot_outside_window = false; continue; }
      a.slot_outside_window = true;
      outside.push({ assignment_id: a.id, traveler_id: a.traveler_id, slot_id: slot.id, slot_start: slot.start });
      const t = (state.travelers || []).find((x) => x.id === a.traveler_id);
      notify(state, {
        traveler_id: a.traveler_id, severity: 'warning',
        title: `${flight.code}: your collection slot moved`,
        body: `The baggage cut-off changed, so your ${fmtTime(slot.start)} slot is outside the new collection window. Please pick a new slot.`,
      }, ctx);
      if (t) integrations().sms.send(state, { traveler_id: t.id, text: `Rabel: ${flight.code} cut-off changed — please pick a new collection slot in the app.` }, ctx);
    }
    if (outside.length) {
      notify(state, {
        role_list: [ROLE.CHECKIN, ROLE.OPS_MANAGER], severity: 'warning',
        title: `${flight.code}: ${outside.length} collection(s) outside the new window`,
        body: 'The cut-off moved. These travelers were asked to pick a new slot.',
      }, ctx);
    }
  }
  audit(state, ctx, { action: 'flight.update', entity: 'Flight', entityId: flight.id, before, after: { route: flight.route, cut_off_at: flight.cut_off_at }, note: ctx.note });
  return { flight, slotsCreated, slotsOutsideWindow: outside };
}

/* ───────────────────────── cancel ───────────────────────── */

/**
 * Cancel a flight: stop every collection that has not happened yet, and tell everyone.
 * Bags already in the line are NOT moved here — they appear in the Warehouse Manager's
 * holding queue (and the Airport Coordinator's) to be physically racked.
 * @param {object} state @param {string} flightId @param {{ reason: string }} input @param {object} ctx
 */
export function cancelFlight(state, flightId, input, ctx) {
  assertCan(ctx.user, 'flight:cancel');
  const flight = findFlight(state, flightId);
  if (flight.status === 'Cancelled') throw new ServiceError('ALREADY_CANCELLED', `${flight.code} is already cancelled.`);
  if (flight.status === 'Completed') throw new ServiceError('FLIGHT_CLOSED', `${flight.code} is closed — it cannot be cancelled.`);
  const reason = String(input?.reason || '').trim();
  if (reason.length < 4) throw new ServiceError('REASON_REQUIRED', 'Record why the flight was cancelled.');

  const at = nowIso(ctx);
  const before = { status: flight.status };
  flight.status = 'Cancelled';
  flight.cancelled_at = at;
  flight.cancel_reason = reason;

  // 1. Call off the collections that have not happened yet (we do not drive out for a cancelled flight).
  const cancelledAssignments = [];
  for (const a of (state.collectionAssignments || []).filter((x) => x.flight_id === flight.id && PRE_COLLECTION_ASSIGNMENT_STATUSES.includes(x.status))) {
    a.status = 'Cancelled';
    a.cancel_reason = `Flight cancelled: ${reason}`;
    a.cancelled_at = at;
    const slot = (state.collectionSlots || []).find((s) => s.id === a.slot_id);
    if (slot) slot.booked_count = Math.max(0, (slot.booked_count || 0) - 1);
    cancelledAssignments.push(a.id);
  }

  // 2. Where the bags are now decides who has to act.
  const bags = bagsOf(state, flight.id);
  const groups = bagGroups(bags);
  const toHold = bags.filter((b) => idx(b.status) >= idx('Checked-in') && idx(b.status) <= idx('Received at Airport'));
  const byWarehouse = [...new Set(toHold.filter((b) => idx(b.status) < idx('Received at Airport')).map((b) => b.warehouse_id).filter(Boolean))];
  const byAirport = [...new Set(toHold.filter((b) => b.status === 'Received at Airport').map((b) => b.airport_id).filter(Boolean))];

  // 3. Fan-out: every operational role, then every affected traveler (in-app + simulated SMS).
  notify(state, {
    role_list: OPERATIONAL_ROLES, severity: 'critical',
    title: `Flight ${flight.code} cancelled`,
    body: `${reason} — ${toHold.length} bag(s) to move to holding, ${cancelledAssignments.length} collection(s) called off, ${groups.withTraveler} bag(s) still with travelers.`,
  }, ctx);
  const travelers = (state.travelers || []).filter((t) => t.flight_id === flight.id || bags.some((b) => b.traveler_id === t.id));
  for (const t of travelers) {
    notify(state, {
      traveler_id: t.id, severity: 'critical',
      title: `Flight ${flight.code} cancelled`,
      body: bags.some((b) => b.traveler_id === t.id && idx(b.status) >= idx('Checked-in'))
        ? 'Your bags are held safely in our warehouse. We will contact you about your new flight.'
        : 'Keep your bags with you. We will contact you about your new flight.',
    }, ctx);
    integrations().sms.send(state, { traveler_id: t.id, text: `Rabel: flight ${flight.code} was cancelled. ${reason}` }, ctx);
  }

  audit(state, ctx, {
    action: 'flight.cancel', entity: 'Flight', entityId: flight.id, before,
    after: { status: flight.status, reason, assignments_cancelled: cancelledAssignments.length, bags_to_hold: toHold.length },
    note: reason,
  });
  return {
    flight,
    assignmentsCancelled: cancelledAssignments,
    bagsToHold: toHold.map((b) => b.id),
    bagsWithTraveler: groups.withTraveler,
    bagsGone: groups.loaded,
    warehouses: byWarehouse,
    airports: byAirport,
    travelersNotified: travelers.length,
  };
}

/* ───────────────────────── rebook ───────────────────────── */

/**
 * Move held bags onto another flight. Each bag goes to "Rebooked" and needs a NEW tag from
 * Backend (bagService.retagRebooked) before the Warehouse Manager can release it to loading.
 * A traveler whose every bag on the old flight moved to the same new flight is moved with them.
 * @param {object} state @param {{ bagIds: string[], newFlightId: string }} input @param {object} ctx
 * @returns {{ rebooked: string[], skipped: {bag_id:string, reason:string}[], travelersMoved: string[], flight: object }}
 */
export function rebookBags(state, input, ctx) {
  assertCan(ctx.user, 'flight:rebook');
  const ids = [...new Set(input?.bagIds || [])];
  if (!ids.length) throw new ServiceError('NOTHING_SELECTED', 'Select the bags to rebook.');
  const target = findFlight(state, input?.newFlightId);
  if (target.status === 'Cancelled') throw new ServiceError('FLIGHT_CANCELLED', `${target.code} is cancelled — pick another flight.`);
  if (target.status === 'Completed') throw new ServiceError('FLIGHT_CLOSED', `${target.code} is closed — pick another flight.`);

  const fromFlightIds = new Set();
  const rebooked = [];
  const skipped = /** @type {{bag_id:string, reason:string}[]} */ ([]);
  for (const id of ids) {
    const was = (state.bags || []).find((b) => b.id === id)?.flight_id ?? null;
    try {
      markRebooked(state, id, target.id, { user: ctx.user, now: ctx.now, note: `Rebooked to ${target.code}` });
      rebooked.push(id);
      if (was) fromFlightIds.add(was);
    } catch (err) { skipped.push({ bag_id: id, reason: err.message }); }
  }
  if (!rebooked.length) throw new ServiceError('NOTHING_REBOOKED', skipped[0]?.reason || 'None of those bags could be rebooked.');

  // The traveler follows their bags only when every bag they had on the old flight moved.
  const travelersMoved = [];
  for (const t of state.travelers || []) {
    const theirs = (state.bags || []).filter((b) => b.traveler_id === t.id);
    if (!theirs.length || !theirs.some((b) => rebooked.includes(b.id))) continue;
    if (theirs.every((b) => b.flight_id === target.id)) {
      if (t.flight_id !== target.id) {
        t.previous_flight_id = t.flight_id;
        t.flight_id = target.id;
        travelersMoved.push(t.id);
      }
      notify(state, { traveler_id: t.id, title: `Rebooked to ${target.code}`, body: 'Your bags are being re-tagged for the new flight.' }, ctx);
      integrations().sms.send(state, { traveler_id: t.id, text: `Rabel: your bags are rebooked to ${target.code}.` }, ctx);
    }
  }
  // When a whole cancelled flight has moved to one target, record where it went.
  for (const fid of fromFlightIds) {
    const from = (state.flights || []).find((f) => f.id === fid);
    if (!from || from.status !== 'Cancelled') continue;
    const left = bagsOf(state, fid).filter((b) => b.status === SIDE_STATUSES.HELD).length;
    if (!left) from.rebooked_to_flight_id = target.id;
  }
  notify(state, {
    role_list: [ROLE.BACKEND, ROLE.WAREHOUSE_MANAGER], severity: 'warning',
    title: `${rebooked.length} bag(s) rebooked to ${target.code}`,
    body: 'Each bag needs a NEW tag from Backend before it can be released back to loading.',
  }, ctx);
  audit(state, ctx, { action: 'flight.rebook', entity: 'Flight', entityId: target.id, after: { bags: rebooked.length, skipped: skipped.length, travelers: travelersMoved.length } });
  return { rebooked, skipped, travelersMoved, flight: target };
}

/* ───────────────────────── closure ───────────────────────── */

/**
 * Can this flight be closed? Every bag must be accounted for (on the aircraft, held, rebooked or
 * returned) and no High/Critical exception may still be open. Lower-severity exceptions are
 * listed as warnings — they do not block a closure.
 * @param {object} state @param {string} flightId @param {object} user @param {{ now?: number|string|Date }} [opts]
 */
export function closureChecklist(state, flightId, user, { now = Date.now() } = {}) {
  assertCan(user, 'flight:read');
  const flight = findFlight(state, flightId);
  const bags = bagsOf(state, flight.id);
  const counts = bagGroups(bags);
  const outstanding = bags.filter((b) => !ACCOUNTED_STATUSES.includes(b.status))
    .map((b) => ({ bag: b, traveler: (state.travelers || []).find((t) => t.id === b.traveler_id) || null }));
  const open = (state.exceptions || []).filter((e) => e.flight_id === flight.id && OPEN_EXCEPTION_STATUSES.includes(e.status));
  const blocking = open.filter((e) => ['High', 'Critical'].includes(e.severity));
  const blockers = [];
  if (flight.status === 'Completed') blockers.push(`${flight.code} is already closed.`);
  if (outstanding.length) blockers.push(`${outstanding.length} bag(s) are not accounted for.`);
  if (blocking.length) blockers.push(`${blocking.length} High/Critical exception(s) are still open.`);
  return {
    flight, counts, outstanding, exceptions: open, blockingExceptions: blocking,
    warnings: open.filter((e) => !['High', 'Critical'].includes(e.severity)),
    alerts: computeAlerts(now, flight, bags),
    canClose: blockers.length === 0,
    blockers,
  };
}

/**
 * Close a flight (status "Completed"). Refuses while the checklist has blockers.
 * @param {object} state @param {string} flightId @param {{ note?: string }} input @param {object} ctx
 */
export function closeFlight(state, flightId, input, ctx) {
  assertCan(ctx.user, 'flight:close');
  const check = closureChecklist(state, flightId, ctx.user, { now: ctx.now ?? Date.now() });
  if (!check.canClose) throw new ServiceError('NOT_CLOSEABLE', check.blockers.join(' '));
  const flight = check.flight;
  const before = { status: flight.status };
  flight.status = 'Completed';
  flight.completed_at = nowIso(ctx);
  flight.closure_note = String(input?.note || '').trim() || null;
  notify(state, {
    role_list: OPERATIONAL_ROLES,
    title: `Flight ${flight.code} closed`,
    body: `${check.counts.loaded} bag(s) on the aircraft, ${check.counts.held + check.counts.rebooked + check.counts.returned} accounted for otherwise.`,
  }, ctx);
  audit(state, ctx, { action: 'flight.close', entity: 'Flight', entityId: flight.id, before, after: { status: flight.status, counts: check.counts }, note: flight.closure_note });
  return { flight, counts: check.counts };
}

/** Flights already closed, newest first (the Closure screen's history). */
export function closedFlights(state, user) {
  assertCan(user, 'flight:read');
  return scopeFilter(user, 'flights', state.flights)
    .filter((f) => f.status === 'Completed')
    .sort((a, b) => String(b.completed_at || '').localeCompare(String(a.completed_at || '')));
}
