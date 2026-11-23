/**
 * Airport Coordinator (Departure v7) bridge to the shared domain layer.
 *
 * This app is the one console that serves both directions: the arrival screens keep their own
 * `rabel_ui_airport-coordinator` store untouched, while every departure screen reads and writes the
 * shared `rabel_v7` store through `shared/services/airportService.js`. The signed-in coordinator is
 * matched to a v7 user by employee ID, so one sign-in covers both sides.
 */
import { getStore } from '../../../shared/store.js';
import { getSession } from '../store.js';
import { toast } from '../ui.js';

export const S = () => getStore().get();
export const save = () => getStore().save();

/** @returns {any|null} the signed-in v7 user (re-read so a disabled account stops working) */
export function user() {
  const s = getSession();
  const id = s?.employeeId || s?.id;
  const u = id ? S().users.find((x) => x.employee_id === id || x.id === id) : null;
  return u && u.status !== 'Disabled' && u.role === 'airport_coordinator' ? u : null;
}

/** @returns {any|null} the airport this coordinator works at */
export function airport() {
  const id = user()?.airport_id;
  return id ? S().airports.find((a) => a.id === id) || null : null;
}

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

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const chip = (text, color = 'grey') => `<span class="chip chip-${color}">${esc(text)}</span>`;

/**
 * Every departure screen opens with this: without a v7 account there is nothing to show, and an
 * empty board at a quiet airport should say so rather than look broken.
 * @param {string} emptyHint what the screen would show once there is work
 * @returns {string|null} HTML to render instead of the screen, or null when the screen may draw
 */
export function blockedHtml(emptyHint) {
  const u = user();
  if (!u) {
    return `<div class="state-block"><h1 class="fs-lg">No departure account</h1>
      <p>This sign-in has no Departure v7 Airport Coordinator account, so the departure screens have nothing to read.
      Sign in as <strong>APC-001</strong> (Jeddah) to run the departure flow, or switch the top bar to <strong>Arrival</strong>.</p></div>`;
  }
  if (!u.airport_id) {
    return `<div class="state-block"><h1 class="fs-lg">No airport assigned</h1><p>${esc(emptyHint)}</p></div>`;
  }
  return null;
}
