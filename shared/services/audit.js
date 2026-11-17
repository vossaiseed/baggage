/** Tiny audit-log helper shared by all services. State is the shared store object. */

/** @param {object} state @param {string} key @returns {number} */
export function nextCounter(state, key) {
  state.counters = state.counters || {};
  state.counters[key] = (state.counters[key] || 0) + 1;
  return state.counters[key];
}

/** @param {{now?: Date|string|number}|undefined} ctx @returns {string} ISO timestamp */
export function nowIso(ctx) {
  const n = ctx?.now;
  if (n instanceof Date) return n.toISOString();
  if (typeof n === 'string' || typeof n === 'number') return new Date(n).toISOString();
  return new Date().toISOString();
}

/**
 * Append an audit entry.
 * @param {object} state
 * @param {{user?: object, system?: boolean, now?: any}} ctx
 * @param {{action: string, entity: string, entityId: string, before?: any, after?: any, note?: string|null}} e
 */
export function audit(state, ctx, e) {
  state.auditLog = state.auditLog || [];
  const entry = {
    id: `AUD-${String(nextCounter(state, 'audit')).padStart(6, '0')}`,
    at: nowIso(ctx),
    user_id: ctx?.user?.id || (ctx?.system ? 'SYSTEM' : null),
    role: ctx?.user?.role || (ctx?.system ? 'system' : null),
    action: e.action, entity: e.entity, entity_id: e.entityId,
    before: e.before ?? null, after: e.after ?? null, note: e.note ?? null,
  };
  state.auditLog.push(entry);
  return entry;
}
