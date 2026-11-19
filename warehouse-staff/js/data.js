/**
 * Warehouse Manager ↔ shared domain layer. Views call `run()` so every action executes a shared
 * service (RBAC + audit inside), persists the store, toasts the outcome and re-renders.
 */
import { getStore } from '../../shared/store.js';
import { authenticate } from '../../shared/services/staffService.js';
import { getSession, setSession } from './session.js';
import { toast } from './ui.js';

export const S = () => getStore().get();
export const save = () => getStore().save();

/** @returns {any|null} the signed-in v7 user (re-read so a disabled account stops working) */
export function user() {
  const s = getSession();
  const u = s ? S().users.find((x) => x.id === s.id) : null;
  return u && u.status !== 'Disabled' ? u : null;
}

/** @returns {any|null} the warehouse this manager runs */
export function warehouse() {
  const id = user()?.warehouse_id;
  return id ? S().warehouses.find((w) => w.id === id) || null : null;
}

export function login(employeeId, pin) {
  const u = authenticate(S(), employeeId, pin);
  if (!u) throw new Error('Invalid employee ID or PIN.');
  if (u.role !== 'warehouse_manager') throw new Error('This console is for Warehouse Manager accounts (WM-xxx).');
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

/** Run a scan-style service call that returns `{ ok, message }` instead of throwing. */
export function runScan(fn) {
  try {
    const res = fn(S(), { user: user(), now: Date.now() });
    save();
    return res || { ok: false, message: 'No result.' };
  } catch (err) {
    return { ok: false, message: err.message || String(err) };
  }
}

/** In-app notifications addressed to this warehouse manager. */
export function myNotifications() {
  const me = user();
  return S().notifications.filter((n) => n.roles?.includes('warehouse_manager') || n.user_id === me?.id).slice().reverse();
}

export function markNotificationsRead(id) {
  for (const n of myNotifications()) if (id === 'all' || n.id === id) n.unread = false;
  save();
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const chip = (text, color = 'grey') => `<span class="chip chip-${color}">${esc(text)}</span>`;

/** amber/red → chip colour; null → green ("on time"). */
export const levelColor = (level) => (level === 'red' ? 'red' : level === 'amber' ? 'amber' : 'green');
