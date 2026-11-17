import { nextCounter, nowIso, audit } from './audit.js';

/**
 * Raise an exception row (one place, one id format). Dedupes an identical OPEN exception
 * (same type + bag/assignment + value) so repeated failed scans do not flood the queue.
 * @param {any} state
 * @param {{ type: string, severity?: string, assignment_id?: string, traveler_id?: string, flight_id?: string, bag_id?: string, tag_id?: string, value?: string, area_id?: string|null, notes?: string }} e
 * @param {{ user?: any, now?: any }} [ctx]
 */
export function raiseException(state, e, ctx = {}) {
  const dup = state.exceptions.find((x) => x.status === 'Open' && x.type === e.type && (x.assignment_id ?? null) === (e.assignment_id ?? null)
    && (x.bag_id ?? null) === (e.bag_id ?? null) && (x.value ?? null) === (e.value ?? null));
  if (dup) return dup;
  const row = {
    id: `EXC-${String(nextCounter(state, 'exception')).padStart(6, '0')}`, type: e.type, severity: e.severity || 'Medium', status: 'Open',
    assignment_id: e.assignment_id ?? null, traveler_id: e.traveler_id ?? null, flight_id: e.flight_id ?? null, bag_id: e.bag_id ?? null,
    tag_id: e.tag_id ?? null, value: e.value ?? null, area_id: e.area_id ?? null, notes: e.notes || '', raised_by: ctx.user?.id ?? null, time: nowIso(ctx),
  };
  state.exceptions.push(row);
  audit(state, ctx, { action: 'exception.raise', entity: 'Exception', entityId: row.id, after: { type: row.type, bag_id: row.bag_id } });
  return row;
}
