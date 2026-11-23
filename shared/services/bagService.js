/**
 * bagService — the ONLY code allowed to change a departure bag's status.
 *
 *  advanceBag(state, bagId, toStatus, ctx)   forward-only, exactly one step
 *  holdForCancelledFlight / markRebooked / retagRebooked / returnToTraveler
 *                                            the only way into / out of side statuses
 *
 * `state` is the shared store object (see shared/store.js). `ctx`:
 *   { user, now?, note?, countMatch?, voucherCountMatch?, system? }
 * `ctx.system` skips RBAC only (migrations / seed); the transition rules
 * always apply.
 */
import { BAG_STATUSES, SIDE_STATUSES, IDEMPOTENT_STATUSES } from '../constants.js';
import { assertCan } from '../rbac.js';
import { audit, nowIso } from './audit.js';

export class BagStateError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'BagStateError';
    this.code = code;
  }
}

/**
 * Preconditions per target status. Return an error message, or null when OK.
 * (Count match etc. are computed by the calling screen and passed via ctx —
 * bagService enforces that the caller actually established them.)
 * @type {Record<string, (bag: any, ctx: any, state: any) => string|null>}
 */
export const STATUS_GUARDS = {
  'Tag Assigned': (bag) => (bag.tag_no ? null : 'A Rabel internal tag (tag_no) must be issued first.'),
  'Checked-in': (bag, ctx) => {
    if (!(bag.weight_kg > 0)) return 'Bag must be weighed before check-in.';
    if (bag.meets_airline_criteria !== true) return 'Bag does not meet the airline weight criteria.';
    if (bag.tag_verified !== true) return 'Tag must be attached and scanned before check-in.';
    if (ctx.countMatch !== true) return 'Declared, weighed and tagged counts must match.';
    return null;
  },
  'Loaded to Collection Truck': (_b, ctx) => (ctx.countMatch === true ? null : 'Pickup count must match the check-in log.'),
  'Received at Warehouse': (_b, ctx) => (ctx.countMatch === true ? null : 'Received count must match the truck count.'),
  'Received at Airport': (_b, ctx) => (ctx.countMatch === true ? null : 'Offloaded count must match the loaded count.'),
  'SGS Voucher Accepted': (_b, ctx) => (ctx.voucherCountMatch === true ? null : 'Voucher count must match the handed-over count.'),
};

/** @param {string} status @returns {number} -1 when not a main-line status */
export function statusIndex(status) { return BAG_STATUSES.indexOf(status); }

/** @param {string} status */
export function isSideStatus(status) { return /** @type {string[]} */ (Object.values(SIDE_STATUSES)).includes(status); }

/** @param {object} state @param {string} bagId */
function getBag(state, bagId) {
  const bag = (state.bags || []).find((b) => b.id === bagId);
  if (!bag) throw new BagStateError('BAG_NOT_FOUND', `Bag ${bagId} not found.`);
  return bag;
}

function authorize(ctx, permission, resource) {
  if (ctx?.system) return;
  assertCan(ctx?.user, permission, resource);
}

/** @param {object} bag @param {string} to @param {object} ctx @param {string} at */
function record(bag, to, ctx, at, extra = {}) {
  bag.status_history = bag.status_history || [];
  bag.status_history.push({
    from: bag.status, to, at, by: ctx?.user?.id || (ctx?.system ? 'SYSTEM' : null),
    role: ctx?.user?.role || (ctx?.system ? 'system' : null), note: ctx?.note || null, ...extra,
  });
  bag.status = to;
  bag.updated_at = at;
}

/**
 * Move a bag exactly one step forward on the 13-step line.
 * @param {object} state @param {string} bagId @param {string} toStatus @param {object} ctx
 * @returns {{ bag: object, changed: boolean }}
 */
export function advanceBag(state, bagId, toStatus, ctx = {}) {
  const bag = getBag(state, bagId);
  const to = statusIndex(toStatus);
  if (to === -1) {
    if (isSideStatus(toStatus)) throw new BagStateError('SIDE_STATUS', `"${toStatus}" can only be set through its named helper.`);
    throw new BagStateError('UNKNOWN_STATUS', `Unknown bag status "${toStatus}".`);
  }
  if (isSideStatus(bag.status)) {
    throw new BagStateError('SIDE_STATUS', `Bag is "${bag.status}"; use the named helper to move it.`);
  }
  const from = statusIndex(bag.status);
  if (from === -1) throw new BagStateError('UNKNOWN_STATUS', `Bag has unknown status "${bag.status}".`);

  if (to === from) {
    if (IDEMPOTENT_STATUSES.includes(toStatus)) return { bag, changed: false };
    throw new BagStateError('NOT_FORWARD', `Bag is already "${toStatus}".`);
  }
  if (to < from) throw new BagStateError('BACKWARD', `Cannot move a bag back from "${bag.status}" to "${toStatus}".`);
  if (to > from + 1) {
    throw new BagStateError('SKIP_STEP', `Cannot skip from "${bag.status}" to "${toStatus}"; next step is "${BAG_STATUSES[from + 1]}".`);
  }

  authorize(ctx, `bag:advance:${toStatus}`, bag);
  const guardError = STATUS_GUARDS[toStatus]?.(bag, ctx, state) ?? null;
  if (guardError) throw new BagStateError('GUARD_FAILED', guardError);

  const at = nowIso(ctx);
  const before = bag.status;
  record(bag, toStatus, ctx, at);
  audit(state, ctx, { action: 'bag.advance', entity: 'Bag', entityId: bag.id, before: { status: before }, after: { status: toStatus }, note: ctx.note });
  return { bag, changed: true };
}

/* ───────────────────────── named side-status helpers ───────────────────────── */

/**
 * Cancelled-flight bag -> "Held – Cancelled Flight" (warehouse holding area).
 * Allowed from Checked-in through Received at Airport, only if the flight is Cancelled.
 * @param {object} state @param {string} bagId @param {{user?:object, holdingArea?:string, holdingRack?:string, now?:any, note?:string, system?:boolean}} ctx
 */
export function holdForCancelledFlight(state, bagId, ctx = {}) {
  const bag = getBag(state, bagId);
  authorize(ctx, 'bag:hold', bag);
  const flight = (state.flights || []).find((f) => f.id === bag.flight_id);
  if (!flight || flight.status !== 'Cancelled') throw new BagStateError('FLIGHT_NOT_CANCELLED', 'Only bags of a cancelled flight can be held.');
  const idx = statusIndex(bag.status);
  if (idx < statusIndex('Checked-in') || idx > statusIndex('Received at Airport')) {
    throw new BagStateError('INVALID_TRANSITION', `A bag that is "${bag.status}" cannot be moved to holding.`);
  }
  const at = nowIso(ctx);
  const before = bag.status;
  bag.held_from_status = before;
  bag.holding_area = ctx.holdingArea ?? bag.holding_area ?? null;
  bag.holding_rack = ctx.holdingRack ?? bag.holding_rack ?? null;
  bag.held_at = at;
  record(bag, SIDE_STATUSES.HELD, ctx, at);
  audit(state, ctx, { action: 'bag.hold', entity: 'Bag', entityId: bag.id, before: { status: before }, after: { status: bag.status, area: bag.holding_area, rack: bag.holding_rack }, note: ctx.note });
  return bag;
}

/**
 * Held bag -> "Rebooked" on a new flight. A re-tag is then required (retagRebooked).
 * @param {object} state @param {string} bagId @param {string} newFlightId @param {object} ctx
 */
export function markRebooked(state, bagId, newFlightId, ctx = {}) {
  const bag = getBag(state, bagId);
  authorize(ctx, 'flight:rebook', bag);
  if (bag.status !== SIDE_STATUSES.HELD) throw new BagStateError('INVALID_TRANSITION', 'Only a held bag can be rebooked.');
  const nf = (state.flights || []).find((f) => f.id === newFlightId);
  if (!nf) throw new BagStateError('FLIGHT_NOT_FOUND', `Flight ${newFlightId} not found.`);
  if (nf.status === 'Cancelled') throw new BagStateError('FLIGHT_CANCELLED', 'Cannot rebook onto a cancelled flight.');
  const at = nowIso(ctx);
  const before = bag.status;
  bag.previous_flight_id = bag.flight_id;
  bag.flight_id = newFlightId;
  bag.retag_required = true;
  record(bag, SIDE_STATUSES.REBOOKED, ctx, at);
  audit(state, ctx, { action: 'bag.rebook', entity: 'Bag', entityId: bag.id, before: { status: before, flight_id: bag.previous_flight_id }, after: { status: bag.status, flight_id: newFlightId }, note: ctx.note });
  return bag;
}

/**
 * Rebooked bag re-enters the line at "Tag Assigned" with a NEW tag.
 * @param {object} state @param {string} bagId @param {{tagNo:string, airlineTagNo?:string|null}} tag @param {object} ctx
 */
export function retagRebooked(state, bagId, tag, ctx = {}) {
  const bag = getBag(state, bagId);
  authorize(ctx, 'bag:rebook_retag', bag);
  if (bag.status !== SIDE_STATUSES.REBOOKED) throw new BagStateError('INVALID_TRANSITION', 'Only a rebooked bag can be re-tagged.');
  if (!tag?.tagNo) throw new BagStateError('GUARD_FAILED', 'A new tag number is required.');
  if (tag.tagNo === bag.tag_no) throw new BagStateError('GUARD_FAILED', 'The bag must receive a NEW tag, not the old one.');
  const at = nowIso(ctx);
  const before = bag.status;
  bag.previous_tags = [...(bag.previous_tags || []), { tag_no: bag.tag_no, airline_tag_no: bag.airline_tag_no ?? null }];
  bag.tag_no = tag.tagNo;
  bag.airline_tag_no = tag.airlineTagNo != null ? String(tag.airlineTagNo) : null;
  bag.tag_verified = false;
  bag.retag_required = false;
  bag.holding_area = null;
  bag.holding_rack = null;
  record(bag, 'Tag Assigned', ctx, at);
  audit(state, ctx, { action: 'bag.retag', entity: 'Bag', entityId: bag.id, before: { status: before }, after: { status: bag.status, tag_no: bag.tag_no }, note: ctx.note });
  return bag;
}

/**
 * Held bag -> "Returned to Traveler" (ID check + signature required).
 * @param {object} state @param {string} bagId @param {{user?:object, idChecked?:boolean, signature?:string, now?:any, note?:string, system?:boolean}} ctx
 */
export function returnToTraveler(state, bagId, ctx = {}) {
  const bag = getBag(state, bagId);
  authorize(ctx, 'bag:return_to_traveler', bag);
  if (bag.status !== SIDE_STATUSES.HELD) throw new BagStateError('INVALID_TRANSITION', 'Only a held bag can be returned to the traveler.');
  if (!ctx.idChecked || !ctx.signature) throw new BagStateError('GUARD_FAILED', 'Traveler ID check and signature are required.');
  const at = nowIso(ctx);
  const before = bag.status;
  bag.returned_at = at;
  bag.return_signature = ctx.signature;
  record(bag, SIDE_STATUSES.RETURNED, ctx, at);
  audit(state, ctx, { action: 'bag.return', entity: 'Bag', entityId: bag.id, before: { status: before }, after: { status: bag.status }, note: ctx.note });
  return bag;
}

/**
 * A rebooked bag that Backend has re-tagged re-enters the line at "Tag Assigned" — but it is already
 * physically in the warehouse, so it must not be driven through Checked-in … Received at Warehouse a
 * second time. The Warehouse Manager releases it back to the stage it was held from
 * ("Received at Warehouse" → screen it again; "Screened" or beyond → straight back to loading, capped
 * at "Screened" because it has to go onto a truck again anyway). A bag held before it ever reached the
 * warehouse takes the normal steps. `advanceBag` stays strictly one step; this is the only way to
 * re-enter the line further along.
 * @param {object} state @param {string} bagId @param {{user?:object, now?:any, note?:string, system?:boolean}} ctx
 * @returns {object} the bag, now back on the main line
 */
export function releaseRebookedToLoading(state, bagId, ctx = {}) {
  const bag = getBag(state, bagId);
  authorize(ctx, 'bag:release_to_loading', bag);
  if (bag.status !== 'Tag Assigned') throw new BagStateError('INVALID_TRANSITION', `This bag is "${bag.status}"; only a re-tagged rebooked bag can be released to loading.`);
  if (bag.retag_required || !(bag.previous_tags || []).length) throw new BagStateError('INVALID_TRANSITION', 'This bag has not been rebooked and re-tagged by Backend.');
  const heldFrom = statusIndex(bag.held_from_status || '');
  if (heldFrom < statusIndex('Received at Warehouse')) {
    throw new BagStateError('INVALID_TRANSITION', `This bag was only "${bag.held_from_status || 'unknown'}" when it was held — it must go through the normal steps.`);
  }
  const to = BAG_STATUSES[Math.min(heldFrom, statusIndex('Screened'))];
  const at = nowIso(ctx);
  const before = bag.status;
  bag.released_to_loading_at = at;
  record(bag, to, ctx, at, { reason: `Rebooked bag released back to "${to}" (held from "${bag.held_from_status}")` });
  audit(state, ctx, { action: 'bag.release_to_loading', entity: 'Bag', entityId: bag.id, before: { status: before }, after: { status: bag.status }, note: ctx.note });
  return bag;
}
