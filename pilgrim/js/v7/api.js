/**
 * Traveler (Departure v7) bridge to the shared domain layer. Screens never touch the store directly:
 * they call these helpers, which call shared/services (rules, RBAC, audit live there).
 */
import { getStore as getV7Store } from '../../../shared/store.js';
import * as tv from '../../../shared/services/travelerService.js';
import { getSession, setSession } from '../store.js';

export const state = () => getV7Store().get();
export const persist = () => getV7Store().save();

/** @returns {boolean} true when the signed-in traveler is a v7 (Nusuk) traveler */
export function isV7() { return getSession()?.mode === 'v7'; }

/** @returns {any} the signed-in v7 traveler row */
export function me() {
  const s = getSession();
  const t = s?.mode === 'v7' ? state().travelers.find((x) => x.id === s.travelerId) : null;
  if (!t) throw new Error('Please sign in again.');
  return t;
}

/** Step 1 of login: Nusuk ID or airline booking ref + passport. Throws "Booking not found in Nusuk or airline data". */
export function lookup(idOrRef, passport) { return tv.findTravelerForLogin(state(), idOrRef, passport); }

/** Step 2: OTP, then open the v7 session. */
export function signIn(travelerId, otp) {
  tv.verifyOtp(otp);
  const t = state().travelers.find((x) => x.id === travelerId);
  setSession({ mode: 'v7', id: t.id, travelerId: t.id, name: t.name, firstName: t.name.split(' ')[0] });
  return t;
}

export function logout() { setSession(null); }

export function tracking() { return tv.trackingFor(state(), me().id); }
export function policy() { return tv.airlinePolicyFor(state(), me()); }
export function slots() { return tv.availableSlots(state(), me().id); }

export function sync() { const t = tv.syncFromNusuk(state(), me().id); persist(); return t; }
export function saveContact(changes) { const r = tv.updateContact(state(), me().id, changes); persist(); return r; }
export function book(bags, slotId) { const r = tv.bookCollection(state(), me().id, { bags, slotId }); persist(); return r; }
export function reschedule(assignmentId, slotId) { const r = tv.rescheduleAssignment(state(), assignmentId, slotId); persist(); return r; }
export function support(message) { tv.requestSupport(state(), me().id, message); persist(); }

export function notifications() { return tv.notificationsFor(state(), me().id); }
export function markRead(id) {
  for (const n of notifications()) if (id === 'all' || n.id === id) n.unread = false;
  persist();
}
