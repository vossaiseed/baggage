/**
 * scanService — EVERY scan in the system is recorded here (one ScanEvent per scan, always with its
 * method HANDHELD / CAMERA / MANUAL). Screens never write scan rows themselves.
 */
import { assertCan } from '../rbac.js';
import { SCAN_METHODS, SCAN_RESULTS } from '../constants.js';
import { nextCounter, nowIso } from './audit.js';
import { ServiceError } from './errors.js';

export const SCAN_SYMBOLOGIES = Object.freeze(['ITF', 'CODE128', 'QR']);

/**
 * @param {any} state
 * @param {{ step: string, method: string, symbology?: string, device_id?: string, raw_value: string, result: string,
 *           flight_id?: string|null, traveler_id?: string|null, bag_id?: string|null, assignment_id?: string|null,
 *           lat?: number|null, lng?: number|null, note?: string|null }} scan
 * @param {{ user: any, now?: any, system?: boolean }} ctx
 */
export function recordScan(state, scan, ctx) {
  if (!ctx.system) assertCan(ctx.user, 'scan:record');
  if (!SCAN_METHODS.includes(scan.method)) throw new ServiceError('BAD_METHOD', `Scan method must be one of ${SCAN_METHODS.join(', ')}.`);
  if (!SCAN_RESULTS.includes(scan.result)) throw new ServiceError('BAD_RESULT', `Scan result must be one of ${SCAN_RESULTS.join(', ')}.`);
  if (scan.symbology && !SCAN_SYMBOLOGIES.includes(scan.symbology)) throw new ServiceError('BAD_SYMBOLOGY', `Unknown symbology "${scan.symbology}".`);
  if (!scan.step) throw new ServiceError('BAD_STEP', 'A scan needs a step.');
  const row = {
    id: `SCN-${String(nextCounter(state, 'scan')).padStart(6, '0')}`, at: nowIso(ctx), step: scan.step, method: scan.method,
    symbology: scan.symbology ?? null, device_id: scan.device_id ?? null, raw_value: String(scan.raw_value ?? ''), result: scan.result,
    user_id: ctx.user?.id ?? null, flight_id: scan.flight_id ?? null, traveler_id: scan.traveler_id ?? null, bag_id: scan.bag_id ?? null,
    assignment_id: scan.assignment_id ?? null, lat: scan.lat ?? null, lng: scan.lng ?? null, note: scan.note ?? null,
  };
  state.scanEvents.push(row);
  return row;
}
