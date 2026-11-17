import { audit, nextCounter, nowIso } from './audit.js';

/**
 * Role- or user-targeted in-app notification (also how simulated SMS/e-mail are recorded).
 * @param {object} state
 * @param {{ role?: string, role_list?: string[], user_id?: string, traveler_id?: string, title: string, body?: string, link?: string|null, severity?: 'info'|'warning'|'critical', channel?: 'in-app'|'sms' }} n
 * @param {{ now?: any }} [ctx]
 */
export function notify(state, n, ctx = {}) {
  const row = {
    id: `NTF-${String(nextCounter(state, 'notification')).padStart(6, '0')}`,
    at: nowIso(ctx), roles: n.role_list || (n.role ? [n.role] : []), user_id: n.user_id ?? null, traveler_id: n.traveler_id ?? null,
    title: n.title, body: n.body || '', link: n.link ?? null, severity: n.severity || 'info', channel: n.channel || 'in-app', unread: true,
  };
  state.notifications.push(row);
  return row;
}

export { audit };
