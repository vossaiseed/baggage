/**
 * Transport Manager + Transport Staff share this console. Views call `run()` so every action:
 * executes a shared service (RBAC + audit inside), persists the store, shows a toast, re-renders.
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

/** @returns {boolean} is the signed-in user the Transport Manager (vs. Transport Staff)? */
export function isManager() { return user()?.role === 'transport_manager'; }

export function login(employeeId, pin) {
  const u = authenticate(S(), employeeId, pin);
  if (!u) throw new Error('Invalid employee ID or PIN.');
  if (!['transport_manager', 'transport_staff'].includes(u.role)) throw new Error('This console is for Transport accounts (TM-xxx / TS-xxx).');
  setSession({ id: u.id, name: u.name, role: u.role });
  return u;
}
export const logout = () => setSession(null);

/** Run a service call: `fn(state, ctx)`; success -> save + toast(okMsg); failure -> error toast. Returns the result or undefined. */
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

export const chip = (text, color = 'grey') => `<span class="chip chip-${color}">${String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>`;
export const pillClass = (status) => `resource-pill st-${String(status).toLowerCase().replace(/\s+/g, '-')}`;
