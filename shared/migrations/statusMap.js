import { BAG_STATUSES, SIDE_STATUSES } from '../constants.js';

/**
 * Maps an OLD (pre-v7) bag status to its v7 status.
 *
 *  Tagged            -> Checked-in
 *  Tag Pre-printed   -> Tag Assigned
 *  Stored            -> Held – Cancelled Flight (flight cancelled) | Screened
 *  Handed to Airline -> Handed to Airport Authority
 *  Checked-in        -> Checked-in if it already has a tag, else Data Verified
 *                       ("Checked-in" now means post-tag; see plan §3.3)
 *
 * Statuses that already exist in v7 are returned unchanged. Unknown values
 * are returned unchanged too (never dropped) so nothing is lost silently.
 *
 * @param {string} oldStatus
 * @param {{ flightCancelled?: boolean, hasTag?: boolean }} [ctx]
 * @returns {string}
 */
export function migrateStatus(oldStatus, ctx = {}) {
  switch (oldStatus) {
    case 'Tagged': return 'Checked-in';
    case 'Tag Pre-printed': return 'Tag Assigned';
    case 'Stored': return ctx.flightCancelled ? SIDE_STATUSES.HELD : 'Screened';
    case 'Handed to Airline': return 'Handed to Airport Authority';
    case 'Checked-in': return ctx.hasTag ? 'Checked-in' : 'Data Verified';
    default: return oldStatus;
  }
}

/** The static part of the map, exposed for documentation / tests. */
export const STATUS_MAP = Object.freeze({
  'Tagged': 'Checked-in',
  'Tag Pre-printed': 'Tag Assigned',
  'Stored': 'Screened | Held – Cancelled Flight',
  'Handed to Airline': 'Handed to Airport Authority',
  'Checked-in': 'Checked-in (tagged) | Data Verified (untagged)',
});

/** @param {string} s */
export function isKnownStatus(s) {
  return BAG_STATUSES.includes(s) || /** @type {string[]} */ (Object.values(SIDE_STATUSES)).includes(s);
}
