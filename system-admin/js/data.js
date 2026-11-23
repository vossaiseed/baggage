/**
 * System Admin ↔ shared domain layer. Views call `run()` so every action executes a shared
 * service (RBAC + audit inside), persists the store, toasts the outcome and re-renders.
 */
import { getStore } from '../../shared/store.js';
import { authenticate } from '../../shared/services/staffService.js';
import { getConfig } from '../../shared/config.js';
import { getSession, setSession } from './session.js';
import { toast, esc } from './ui.js';

export const S = () => getStore().get();
export const save = () => getStore().save();
export const store = () => getStore();

/** @returns {any|null} the signed-in v7 user (re-read so a disabled account stops working) */
export function user() {
  const s = getSession();
  const u = s ? S().users.find((x) => x.id === s.id) : null;
  return u && u.status !== 'Disabled' ? u : null;
}

/**
 * Admin sign-in keeps the demo's second factor: employee ID + PIN, then the 2FA code.
 * `pending` holds the half-authenticated user between the two steps.
 */
let pending = null;

export function startLogin(employeeId, pin) {
  const u = authenticate(S(), employeeId, pin);
  if (!u) throw new Error('Invalid employee ID or PIN.');
  if (u.role !== 'system_admin') throw new Error('This console is for System Admin accounts (ADM-xxx).');
  pending = u;
  return u;
}

export function completeLogin(code) {
  if (!pending) throw new Error('Start again — the sign-in timed out.');
  if (String(code).trim() !== getConfig().demoOtp) throw new Error('That verification code is not right.');
  setSession({ id: pending.id, name: pending.name, role: pending.role, startedAt: new Date().toISOString() });
  const u = pending;
  pending = null;
  return u;
}

export const logout = () => { pending = null; setSession(null); };

/** Run a service call `fn(state, ctx)`: success → save + toast(okMsg); failure → error toast. */
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

/** Read a service query; on failure show the message instead of the screen. */
export function read(fn, fallback = null) {
  try { return fn(S(), user()); } catch (err) { toast(err.message || String(err), 'error'); return fallback; }
}

export const chip = (text, color = 'grey') => `<span class="chip chip-${color}">${esc(text)}</span>`;
