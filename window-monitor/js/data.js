/**
 * Window Monitor ↔ shared domain layer. The board only reads; the one write a monitor may make
 * is `alertOps` (monitorService), which is what `run()` is here for.
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
  if (u.role !== 'window_monitor') throw new Error('This board is for Window Monitor accounts (MON-xxx).');
  setSession({ id: u.id, name: u.name, role: u.role, startedAt: new Date().toISOString() });
  return u;
}
export const logout = () => setSession(null);

/** Read a service query; on failure show the message instead of the board. */
export function read(fn, fallback = null) {
  try { return fn(S(), user()); } catch (err) { toast(err.message || String(err), 'error'); return fallback; }
}

/** Run the one write the board allows. */
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

export const chip = (text, color = 'grey') => `<span class="chip chip-${color}">${esc(text)}</span>`;
export const levelColor = (level) => (level === 'red' ? 'red' : level === 'amber' ? 'amber' : 'green');

/** "in 3h 20m" / "20m ago" — the countdown the wall board is read for. */
export function untilText(iso, now = Date.now()) {
  if (!iso) return '—';
  const mins = Math.round((new Date(iso).getTime() - now) / 60000);
  const abs = Math.abs(mins);
  const txt = abs >= 60 ? `${Math.floor(abs / 60)}h ${String(abs % 60).padStart(2, '0')}m` : `${abs}m`;
  return mins >= 0 ? `in ${txt}` : `${txt} ago`;
}
