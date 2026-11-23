/** Check-in Staff ↔ shared domain layer. Every action goes through a shared service (RBAC + audit inside). */
import { getStore } from '../../shared/store.js';
import { getSession } from './store.js';
import { toast } from './ui.js';

export const S = () => getStore().get();
export const save = () => getStore().save();

/** @returns {any} the signed-in v7 user (re-read so a disabled account stops working) */
export function me() {
  const s = getSession();
  const u = s ? S().users.find((x) => x.employee_id === s.employeeId) : null;
  if (!u || u.status === 'Disabled') throw new Error('Please sign in again.');
  return u;
}

/** Run `fn(state, ctx)`: persist on success, toast an error on failure. Returns the result or `undefined`. */
export function run(fn, okMsg) {
  try {
    const res = fn(S(), { user: me(), now: Date.now() });
    save();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(res) : okMsg, 'success');
    return res;
  } catch (err) {
    toast(err.message || String(err), 'error');
    return undefined;
  }
}
