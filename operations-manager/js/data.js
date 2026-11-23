/**
 * Operations Manager ↔ shared domain layer. Views call `run()` so every action executes a shared
 * service (RBAC + audit inside), persists the store, toasts the outcome and re-renders.
 */
import { getStore } from '../../shared/store.js';
import { authenticate } from '../../shared/services/staffService.js';
import { getSession, setSession } from './session.js';
import { toast, esc } from './ui.js';

export const S = () => getStore().get();
export const save = () => getStore().save();

/** @returns {any|null} the signed-in v7 user (re-read so a disabled account stops working) */
export function user() {
  const s = getSession();
  const u = s ? S().users.find((x) => x.id === s.id) : null;
  return u && u.status !== 'Disabled' ? u : null;
}

export function login(employeeId, pin) {
  const u = authenticate(S(), employeeId, pin);
  if (!u) throw new Error('Invalid employee ID or PIN.');
  if (u.role !== 'ops_manager') throw new Error('This console is for Operations Manager accounts (OPS-xxx).');
  setSession({ id: u.id, name: u.name, role: u.role, startedAt: new Date().toISOString() });
  return u;
}
export const logout = () => setSession(null);

/** Run a service call `fn(state, ctx)`: success → save + toast(okMsg); failure → error toast. @returns the result or undefined */
export function run(fn, okMsg, after) {
  try {
    const res = fn(S(), { user: user(), now: Date.now() });
    save();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(res) : okMsg, 'success');
    after?.(res);
    return res;
  } catch (err) {
    toast(err.message || String(err), 'error');
    return undefined;
  }
}

/** Read a service query; on failure show the message in place of the screen. @returns {any} */
export function read(fn, fallback = null) {
  try { return fn(S(), user()); } catch (err) { toast(err.message || String(err), 'error'); return fallback; }
}

/** In-app notifications addressed to the Operations Manager. */
export function myNotifications() {
  const me = user();
  return S().notifications.filter((n) => n.roles?.includes('ops_manager') || n.user_id === me?.id).slice().reverse();
}

export function markNotificationsRead(id) {
  for (const n of myNotifications()) if (id === 'all' || n.id === id) n.unread = false;
  save();
}

export const chip = (text, color = 'grey') => `<span class="chip chip-${color}">${esc(text)}</span>`;

/** amber/red → chip colour; anything else → green ("on schedule"). */
export const levelColor = (level) => (level === 'red' ? 'red' : level === 'amber' ? 'amber' : 'green');

/** Flight status → chip colour. */
export const flightColor = (status) => ({ Scheduled: 'blue', New: 'grey', Cancelled: 'red', Completed: 'green', Rebooked: 'amber' }[status] || 'grey');

/** Exception severity → chip colour. */
export const severityColor = (sev) => ({ Critical: 'red', High: 'red', Medium: 'amber', Low: 'grey' }[sev] || 'grey');

/** A short "in 3h 20m" / "20m ago" for a cut-off. */
export function untilText(iso, now = Date.now()) {
  if (!iso) return '—';
  const mins = Math.round((new Date(iso).getTime() - now) / 60000);
  const abs = Math.abs(mins);
  const txt = abs >= 60 ? `${Math.floor(abs / 60)}h ${abs % 60}m` : `${abs}m`;
  return mins >= 0 ? `in ${txt}` : `${txt} ago`;
}
