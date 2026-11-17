/**
 * validateLpn — the single validator for airline bag tag numbers (IATA LPN).
 *
 * An LPN is a 10-digit STRING `^\d{10}$` (a leading zero is valid and must be
 * kept). Layout used by Rabel: issuer code = digits 1–3 (the airline's BTIC
 * allow-list entry), serial = digits 4–9, digit 10 = check digit (not validated:
 * Rabel cannot know the airline's algorithm).
 *
 * Two modes:
 *  - 'import' (Backend CSV): format → issuer allow-list → not a duplicate → flight exists
 *  - 'scan'   (check-in / any scan): format → issuer → known tag → duplicate → wrong flight →
 *             traveler → released (expected step)
 */
import { LPN_REGEX } from '../constants.js';

/**
 * @typedef {{ ok: boolean, code: string, result: string, exception_type: string|null, message: string,
 *            lpn: string|null, issuer_code: string|null, serial: string|null, tag?: object }} LpnResult
 */

/** @returns {LpnResult} */
function fail(code, result, exception_type, message, parts = {}) {
  return { ok: false, code, result, exception_type, message, lpn: parts.lpn ?? null, issuer_code: parts.issuer_code ?? null, serial: parts.serial ?? null };
}

/**
 * @param {unknown} raw
 * @param {{
 *   mode?: 'import'|'scan',
 *   airline?: { code?: string, btic_codes?: string[] } | null,
 *   tags?: object[],
 *   flightIds?: string[],      // import: known flight ids
 *   flightId?: string|null,    // import: flight of the row / scan: expected flight
 *   travelerId?: string|null,  // scan: expected traveler
 * }} [ctx]
 * @returns {LpnResult}
 */
export function validateLpn(raw, ctx = {}) {
  const mode = ctx.mode || 'scan';
  const lpn = typeof raw === 'string' ? raw.trim() : (raw == null ? '' : String(raw).trim());
  if (typeof raw === 'number') {
    // A number has already lost its leading zeros — refuse it instead of guessing.
    return fail('INVALID_FORMAT', 'INVALID_FORMAT', 'Invalid Tag Format', 'Tag number must be read as text (10 digits), not a number.', { lpn });
  }
  if (!LPN_REGEX.test(lpn)) {
    return fail('INVALID_FORMAT', 'INVALID_FORMAT', 'Invalid Tag Format', `"${lpn}" is not a 10-digit tag number.`, { lpn });
  }
  const parts = { lpn, issuer_code: lpn.slice(0, 3), serial: lpn.slice(3, 9) };

  if (mode === 'import' && ctx.flightIds && !ctx.flightIds.includes(ctx.flightId)) {
    return fail('FLIGHT_NOT_FOUND', 'WRONG_FLIGHT', 'Wrong Flight Tag', 'Flight not found.', parts);
  }

  const allow = ctx.airline?.btic_codes || [];
  if (!allow.includes(parts.issuer_code)) {
    return fail('WRONG_ISSUER', 'INVALID_FORMAT', 'Invalid Tag Format',
      `Issuer code ${parts.issuer_code} is not in ${ctx.airline?.code || 'the airline'}'s allowed list (${allow.join(', ') || 'none'}).`, parts);
  }

  const existing = (ctx.tags || []).find((t) => t.lpn === lpn);

  if (mode === 'import') {
    if (existing) return fail('DUPLICATE', 'DUPLICATE', 'Duplicate Tag', `Tag ${lpn} already exists.`, parts);
    return { ok: true, code: 'OK', result: 'OK', exception_type: null, message: 'OK', ...parts };
  }

  // scan mode
  if (!existing) return fail('UNKNOWN', 'UNKNOWN', 'Invalid Tag Format', `Tag ${lpn} is not in the imported airline tag list.`, parts);
  if (existing.status === 'Void') return fail('VOID', 'WRONG_STEP', 'Damaged Tag', `Tag ${lpn} was voided (${existing.void_reason || 'damaged'}).`, parts);
  if (ctx.flightId && existing.flight_id !== ctx.flightId) {
    return fail('WRONG_FLIGHT', 'WRONG_FLIGHT', 'Wrong Flight Tag', `Tag ${lpn} belongs to a different flight.`, parts);
  }
  if (ctx.travelerId && existing.traveler_id && existing.traveler_id !== ctx.travelerId) {
    return fail('WRONG_TRAVELER', 'UNKNOWN', 'Wrong Flight Tag', `Tag ${lpn} is assigned to another traveler.`, parts);
  }
  if (existing.status === 'Attached' || existing.status === 'Scanned') {
    return fail('DUPLICATE', 'DUPLICATE', 'Duplicate Tag', `Tag ${lpn} was already attached to a bag.`, parts);
  }
  if (existing.status !== 'Released') {
    return fail('NOT_RELEASED', 'WRONG_STEP', 'Tag Not Released', `Tag ${lpn} has not been released to check-in staff yet.`, parts);
  }
  return { ok: true, code: 'OK', result: 'OK', exception_type: null, message: 'OK', ...parts, tag: existing };
}
