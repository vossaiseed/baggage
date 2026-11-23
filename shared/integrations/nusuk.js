/**
 * Nusuk adapter. Screens talk ONLY to this interface:
 *   fetchTraveler({ nusukId?, bookingRef?, passport? }) -> NusukRecord | null
 *   fetchAll() -> NusukRecord[]
 * The simulated implementation reads shared/integrations/simulatedData.js.
 * A live implementation (RABEL_NUSUK_MODE=live) would call the Nusuk API here.
 */
import { NUSUK_RECORDS, BOARDING_PASS_OVERRIDES } from './simulatedData.js';

/** Nusuk carries the boarding-pass number the traveler holds; two demo travelers hold a wrong one. */
const withBp = (r) => ({ ...structuredClone(r), boarding_pass_no: BOARDING_PASS_OVERRIDES[r.nusuk_id] ?? null });

/** @typedef {typeof NUSUK_RECORDS[number]} NusukRecord */

export const simulatedNusuk = {
  mode: 'simulated',
  /** @param {{nusukId?:string, passport?:string}} q @returns {NusukRecord|null} */
  fetchTraveler(q) {
    const r = NUSUK_RECORDS.find((x) => x.nusuk_id === String(q.nusukId || '').trim()
      && (!q.passport || x.passport.toUpperCase() === String(q.passport).trim().toUpperCase()));
    return r ? withBp(r) : null;
  },
  /** @returns {NusukRecord[]} */
  fetchAll() { return NUSUK_RECORDS.map(withBp); },
};
