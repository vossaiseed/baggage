/**
 * exceptionService — raising an exception (every role, by working) and working it off
 * (Operations Manager only).
 *
 *   raiseException                               one row, one id format, deduped while still open
 *   exceptionQueue / exceptionSummary            the Ops queue and its tiles
 *   assignException / addExceptionNote           who owns it, what has been tried
 *   escalateException                            raise the severity, tell Ops
 *   resolveException / closeException           Resolved -> Closed; nothing is deleted
 *
 * Statuses: Open -> Assigned -> (Escalated) -> Resolved -> Closed (shared/constants.js).
 * Every other role can only read and raise — that is why there is no "resolve" permission in
 * their presets.
 */
import { OPEN_EXCEPTION_STATUSES, EXCEPTION_SEVERITIES, ROLE } from '../constants.js';
import { assertCan, scopeFilter } from '../rbac.js';
import { nextCounter, nowIso, audit } from './audit.js';
import { notify } from './notify.js';
import { ServiceError } from './errors.js';

/** Is this exception still work to be done? */
export const isOpenException = (e) => OPEN_EXCEPTION_STATUSES.includes(e?.status);

/**
 * Raise an exception row (one place, one id format). Dedupes an identical still-open exception
 * (same type + bag/assignment + value) so repeated failed scans do not flood the queue.
 * @param {any} state
 * @param {{ type: string, severity?: string, assignment_id?: string, traveler_id?: string, flight_id?: string, bag_id?: string, tag_id?: string, value?: string, area_id?: string|null, notes?: string }} e
 * @param {{ user?: any, now?: any }} [ctx]
 */
export function raiseException(state, e, ctx = {}) {
  const dup = state.exceptions.find((x) => isOpenException(x) && x.type === e.type && (x.assignment_id ?? null) === (e.assignment_id ?? null)
    && (x.bag_id ?? null) === (e.bag_id ?? null) && (x.value ?? null) === (e.value ?? null));
  if (dup) return dup;
  const row = {
    id: `EXC-${String(nextCounter(state, 'exception')).padStart(6, '0')}`, type: e.type, severity: e.severity || 'Medium', status: 'Open',
    assignment_id: e.assignment_id ?? null, traveler_id: e.traveler_id ?? null, flight_id: e.flight_id ?? null, bag_id: e.bag_id ?? null,
    tag_id: e.tag_id ?? null, value: e.value ?? null, area_id: e.area_id ?? null, notes: e.notes || '', raised_by: ctx.user?.id ?? null, time: nowIso(ctx),
    owner: null, owner_team: null, due_at: null, updates: /** @type {{at:string,by:string|null,text:string}[]} */ ([]),
    resolution: null, resolved_at: null, resolved_by: null, closed_at: null,
  };
  state.exceptions.push(row);
  audit(state, ctx, { action: 'exception.raise', entity: 'Exception', entityId: row.id, after: { type: row.type, bag_id: row.bag_id } });
  return row;
}

/* ───────────────────────── read models ───────────────────────── */

function find(state, id, user) {
  const e = (state.exceptions || []).find((x) => x.id === id);
  if (!e) throw new ServiceError('NOT_FOUND', `Exception ${id} not found.`);
  assertCan(user, 'exception:read', e);
  return e;
}

/** How old an exception is, in minutes. @param {object} e @param {number|string|Date} now */
export const ageMinutes = (e, now) => Math.max(0, Math.round((new Date(now).getTime() - new Date(e.time).getTime()) / 60000));

/**
 * The exception queue for whoever is asking (Ops sees all; a scoped role sees its own area).
 * Newest first within severity; still-open rows before resolved/closed ones.
 * @param {object} state @param {object} user
 * @param {{ now?: number|string|Date, status?: string, type?: string, severity?: string, flightId?: string, areaId?: string, q?: string, includeClosed?: boolean }} [filters]
 */
export function exceptionQueue(state, user, filters = {}) {
  assertCan(user, 'exception:read');
  const now = filters.now ?? Date.now();
  const sevRank = (s) => EXCEPTION_SEVERITIES.indexOf(s);
  const q = String(filters.q || '').trim().toLowerCase();
  return scopeFilter(user, 'exceptions', state.exceptions)
    .filter((e) => (filters.includeClosed || filters.status ? true : isOpenException(e)))
    .filter((e) => (filters.status ? e.status === filters.status : true))
    .filter((e) => (filters.type ? e.type === filters.type : true))
    .filter((e) => (filters.severity ? e.severity === filters.severity : true))
    .filter((e) => (filters.flightId ? e.flight_id === filters.flightId : true))
    .filter((e) => (filters.areaId ? e.area_id === filters.areaId : true))
    .map((e) => ({
      exception: e,
      bag: e.bag_id ? (state.bags || []).find((b) => b.id === e.bag_id) || null : null,
      traveler: e.traveler_id ? (state.travelers || []).find((t) => t.id === e.traveler_id) || null : null,
      flight: e.flight_id ? (state.flights || []).find((f) => f.id === e.flight_id) || null : null,
      area: e.area_id ? (state.collectionAreas || []).find((a) => a.id === e.area_id) || null : null,
      raisedBy: (state.users || []).find((u) => u.id === e.raised_by) || null,
      ageMinutes: ageMinutes(e, now),
    }))
    .filter((r) => (q
      ? [r.exception.id, r.exception.type, r.exception.value, r.exception.notes, r.traveler?.name, r.flight?.code, r.bag?.tag_no]
        .some((v) => String(v || '').toLowerCase().includes(q))
      : true))
    .sort((a, b) => Number(isOpenException(b.exception)) - Number(isOpenException(a.exception))
      || sevRank(b.exception.severity) - sevRank(a.exception.severity)
      || String(b.exception.time).localeCompare(String(a.exception.time)));
}

/**
 * Tiles for the Ops dashboard: open counts by severity and by type, plus the oldest open row.
 * @param {object} state @param {object} user @param {{ now?: number|string|Date }} [opts]
 */
export function exceptionSummary(state, user, { now = Date.now() } = {}) {
  assertCan(user, 'exception:read');
  const rows = scopeFilter(user, 'exceptions', state.exceptions);
  const open = rows.filter(isOpenException);
  const bySeverity = Object.fromEntries(EXCEPTION_SEVERITIES.map((s) => [s, open.filter((e) => e.severity === s).length]));
  const byType = /** @type {Record<string, number>} */ ({});
  for (const e of open) byType[e.type] = (byType[e.type] || 0) + 1;
  const oldest = [...open].sort((a, b) => String(a.time).localeCompare(String(b.time)))[0] || null;
  return {
    total: rows.length,
    open: open.length,
    resolved: rows.filter((e) => e.status === 'Resolved').length,
    closed: rows.filter((e) => e.status === 'Closed').length,
    unassigned: open.filter((e) => !e.owner).length,
    overdue: open.filter((e) => e.due_at && new Date(e.due_at).getTime() < new Date(now).getTime()).length,
    bySeverity,
    byType,
    oldest: oldest ? { exception: oldest, ageMinutes: ageMinutes(oldest, now) } : null,
  };
}

/* ───────────────────────── the Ops lifecycle ───────────────────────── */

/** Append to the exception's own log (also used by assign/escalate/resolve). */
function logUpdate(e, text, ctx) {
  e.updates = e.updates || [];
  e.updates.push({ at: nowIso(ctx), by: ctx?.user?.id ?? null, text });
  return e;
}

/**
 * Give an exception an owner (a user id or a free-text team) and optionally a due time.
 * @param {object} state @param {string} id @param {{ owner?: string|null, team?: string|null, dueAt?: string|number|Date|null }} input @param {object} ctx
 */
export function assignException(state, id, input, ctx) {
  assertCan(ctx.user, 'exception:assign');
  const e = find(state, id, ctx.user);
  if (!isOpenException(e)) throw new ServiceError('NOT_OPEN', `${e.id} is ${e.status} — reopen it before assigning.`);
  const owner = input?.owner ? String(input.owner).trim() : null;
  const team = input?.team ? String(input.team).trim() : null;
  if (!owner && !team) throw new ServiceError('INVALID', 'Choose a person or a team to own this exception.');
  if (owner && !(state.users || []).some((u) => u.id === owner)) throw new ServiceError('NOT_FOUND', `User ${owner} not found.`);
  const before = { status: e.status, owner: e.owner, owner_team: e.owner_team };
  e.owner = owner;
  e.owner_team = team;
  e.due_at = input?.dueAt ? new Date(input.dueAt).toISOString() : e.due_at;
  if (e.status === 'Open') e.status = 'Assigned';
  logUpdate(e, `Assigned to ${owner || team}${e.due_at ? ` (due ${e.due_at})` : ''}`, ctx);
  if (owner) {
    notify(state, { user_id: owner, severity: 'warning', title: `${e.type} assigned to you`, body: `${e.id}${e.notes ? ` — ${e.notes}` : ''}` }, ctx);
  }
  audit(state, ctx, { action: 'exception.assign', entity: 'Exception', entityId: e.id, before, after: { status: e.status, owner, owner_team: team } });
  return e;
}

/**
 * Record what has been tried, without changing the status.
 * @param {object} state @param {string} id @param {string} text @param {object} ctx
 */
export function addExceptionNote(state, id, text, ctx) {
  assertCan(ctx.user, 'exception:update');
  const e = find(state, id, ctx.user);
  const note = String(text || '').trim();
  if (!note) throw new ServiceError('INVALID', 'Write what happened.');
  logUpdate(e, note, ctx);
  audit(state, ctx, { action: 'exception.note', entity: 'Exception', entityId: e.id, after: { note } });
  return e;
}

/**
 * Raise the severity one step (Critical is the ceiling) and tell Ops.
 * @param {object} state @param {string} id @param {string} reason @param {object} ctx
 */
export function escalateException(state, id, reason, ctx) {
  assertCan(ctx.user, 'exception:escalate');
  const e = find(state, id, ctx.user);
  if (!isOpenException(e)) throw new ServiceError('NOT_OPEN', `${e.id} is ${e.status} — it cannot be escalated.`);
  const why = String(reason || '').trim();
  if (why.length < 4) throw new ServiceError('REASON_REQUIRED', 'Record why this is being escalated.');
  const before = { status: e.status, severity: e.severity };
  const next = EXCEPTION_SEVERITIES[Math.min(EXCEPTION_SEVERITIES.indexOf(e.severity) + 1, EXCEPTION_SEVERITIES.length - 1)];
  e.severity = next;
  e.status = 'Escalated';
  logUpdate(e, `Escalated to ${next}: ${why}`, ctx);
  notify(state, { role_list: [ROLE.OPS_MANAGER], severity: 'critical', title: `${e.type} escalated to ${next}`, body: `${e.id}: ${why}` }, ctx);
  audit(state, ctx, { action: 'exception.escalate', entity: 'Exception', entityId: e.id, before, after: { status: e.status, severity: next }, note: why });
  return e;
}

/**
 * Resolve an exception. The resolution text is what the audit trail keeps.
 * @param {object} state @param {string} id @param {{ resolution: string }} input @param {object} ctx
 */
export function resolveException(state, id, input, ctx) {
  assertCan(ctx.user, 'exception:resolve');
  const e = find(state, id, ctx.user);
  if (e.status === 'Closed') throw new ServiceError('CLOSED', `${e.id} is closed.`);
  if (e.status === 'Resolved') throw new ServiceError('ALREADY_RESOLVED', `${e.id} is already resolved — close it instead.`);
  const resolution = String(input?.resolution || '').trim();
  if (resolution.length < 4) throw new ServiceError('REASON_REQUIRED', 'Record how this was resolved.');
  const before = { status: e.status };
  e.status = 'Resolved';
  e.resolution = resolution;
  e.resolved_at = nowIso(ctx);
  e.resolved_by = ctx.user?.id ?? null;
  logUpdate(e, `Resolved: ${resolution}`, ctx);
  if (e.raised_by && e.raised_by !== e.resolved_by) {
    notify(state, { user_id: e.raised_by, title: `${e.type} resolved`, body: `${e.id}: ${resolution}` }, ctx);
  }
  audit(state, ctx, { action: 'exception.resolve', entity: 'Exception', entityId: e.id, before, after: { status: e.status, resolution }, note: resolution });
  return e;
}

/**
 * Close a resolved exception (the row stays, read-only).
 * @param {object} state @param {string} id @param {object} ctx
 */
export function closeException(state, id, ctx) {
  assertCan(ctx.user, 'exception:close');
  const e = find(state, id, ctx.user);
  if (e.status === 'Closed') throw new ServiceError('CLOSED', `${e.id} is already closed.`);
  if (e.status !== 'Resolved') throw new ServiceError('NOT_RESOLVED', `${e.id} must be resolved before it is closed.`);
  const before = { status: e.status };
  e.status = 'Closed';
  e.closed_at = nowIso(ctx);
  logUpdate(e, 'Closed', ctx);
  audit(state, ctx, { action: 'exception.close', entity: 'Exception', entityId: e.id, before, after: { status: e.status } });
  return e;
}

/**
 * Put a resolved/closed exception back in the queue (it came back).
 * @param {object} state @param {string} id @param {string} reason @param {object} ctx
 */
export function reopenException(state, id, reason, ctx) {
  assertCan(ctx.user, 'exception:update');
  const e = find(state, id, ctx.user);
  if (isOpenException(e)) throw new ServiceError('ALREADY_OPEN', `${e.id} is still open.`);
  const why = String(reason || '').trim();
  if (why.length < 4) throw new ServiceError('REASON_REQUIRED', 'Record why this is being reopened.');
  const before = { status: e.status };
  e.status = e.owner || e.owner_team ? 'Assigned' : 'Open';
  e.resolution = null;
  e.resolved_at = null;
  e.resolved_by = null;
  e.closed_at = null;
  logUpdate(e, `Reopened: ${why}`, ctx);
  audit(state, ctx, { action: 'exception.reopen', entity: 'Exception', entityId: e.id, before, after: { status: e.status }, note: why });
  return e;
}
