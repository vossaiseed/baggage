/**
 * backendService — Backend Team operations: Nusuk / airline data collection, match & verify,
 * mismatch fix/reject, unmapped addresses, boarding-pass verification, manifest monitoring,
 * dashboard tiles. Tag operations live in tagService.
 */
import { assertCan } from '../rbac.js';
import { BAG_STATUSES, ROLE } from '../constants.js';
import { integrations } from '../integrations/index.js';
import { advanceBag } from './bagService.js';
import { audit, nextCounter, nowIso } from './audit.js';
import { notify } from './notify.js';
import { ServiceError } from './errors.js';
import { issueInternalLabel, findFlight } from './tagService.js';
import { upsertFromNusuk, upsertFromAirline, areaForDistrict } from './travelerService.js';
import { parseCsv } from '../tags/csv.js';

const pad = (n, w) => String(n).padStart(w, '0');
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();

/** Pre-v7 imported travelers/bags are read-only history and never appear in Backend work queues. */
const liveTravelers = (state) => state.travelers.filter((t) => !t.legacy);

/** "Sync Nusuk" — pull every Nusuk record. @returns {{checked:number, created:number, updated:number}} */
export function syncNusuk(state, ctx) {
  assertCan(ctx.user, 'nusuk:sync');
  const records = integrations().nusuk.fetchAll();
  let created = 0;
  for (const rec of records) if (upsertFromNusuk(state, rec, ctx).created) created++;
  audit(state, ctx, { action: 'data.nusuk_sync', entity: 'Traveler', entityId: '*', after: { checked: records.length, created } });
  return { checked: records.length, created, updated: records.length - created };
}

/**
 * "Import airline file" (CSV: booking_ref, passport, name, flight, boarding_pass_no). With no file, the
 * simulated airline feed is used.
 */
export function importAirlineFile(state, csv, ctx) {
  assertCan(ctx.user, 'airline_file:import');
  let records;
  if (csv != null && String(csv).trim()) {
    const { header, rows } = parseCsv(csv);
    for (const col of ['booking_ref', 'passport', 'name', 'flight']) {
      if (!header.includes(col)) throw new ServiceError('BAD_HEADER', `The airline file must have the columns: booking_ref, passport, name, flight, boarding_pass_no (missing ${col}).`);
    }
    records = rows.map(({ cells }) => ({ booking_ref: cells.booking_ref, passport: cells.passport, name: cells.name, flight_code: cells.flight, boarding_pass_no: cells.boarding_pass_no || null }));
  } else records = integrations().airlineFeed.fetchReservations();
  let created = 0;
  for (const rec of records) if (upsertFromAirline(state, rec).created) created++;
  audit(state, ctx, { action: 'data.airline_import', entity: 'Traveler', entityId: '*', after: { rows: records.length, created } });
  return { rows: records.length, created, updated: records.length - created };
}

/** @returns {{ status:'matched'|'mismatch'|'missing', fields: string[], missing_from: string|null }} */
export function matchStatus(t) {
  if (!t.nusuk || !t.airline) return { status: 'missing', fields: [], missing_from: t.nusuk ? 'airline' : 'nusuk' };
  const fields = [];
  if (norm(t.nusuk.name) !== norm(t.airline.name)) fields.push('name');
  if (norm(t.nusuk.passport) !== norm(t.airline.passport)) fields.push('passport');
  if (norm(t.nusuk.flight_code) !== norm(t.airline.flight_code)) fields.push('flight');
  const unresolved = fields.filter((f) => !(t.mismatch_resolved?.fields || []).includes(f));
  return { status: unresolved.length ? 'mismatch' : 'matched', fields: unresolved, missing_from: null };
}

/** Rows for the Data collection tab (incl. residence address). */
export function dataRows(state, { flightId = null } = {}) {
  return liveTravelers(state).filter((t) => !flightId || t.flight_id === flightId).map((t) => {
    const res = state.residences.find((r) => r.id === t.residence_id) || null;
    const flight = state.flights.find((f) => f.id === t.flight_id);
    return {
      traveler: t, flight: flight?.code || '—', match: matchStatus(t),
      address: res ? `${res.building}, flat ${res.flat_no}, ${res.district}` : null,
      mapped: !!res?.collection_area_id,
    };
  });
}

/** "Match & verify": matched → data_verified, bags Declared → Data Verified, internal labels issued. */
export function matchAndVerify(state, travelerId, ctx) {
  assertCan(ctx.user, 'traveler:verify');
  const t = state.travelers.find((x) => x.id === travelerId);
  if (!t) throw new ServiceError('NOT_FOUND', 'Traveler not found.');
  const m = matchStatus(t);
  if (m.status !== 'matched') throw new ServiceError('NOT_MATCHED', m.status === 'missing' ? `Cannot verify: record missing from ${m.missing_from} data.` : `Cannot verify: mismatch on ${m.fields.join(', ')}. Fix or reject it first.`);
  if (t.data_rejected) throw new ServiceError('REJECTED', 'This traveler was rejected. Fix the data first.');
  t.data_verified = true;
  let advanced = 0;
  for (const bag of state.bags.filter((b) => b.traveler_id === t.id && b.status === 'Declared')) {
    advanceBag(state, bag.id, 'Data Verified', { user: ctx.user, now: ctx.now, note: 'Nusuk + airline data matched' });
    issueInternalLabel(state, bag);
    advanced++;
  }
  audit(state, ctx, { action: 'traveler.verify', entity: 'Traveler', entityId: t.id, after: { bags: advanced } });
  return { traveler: t, bagsVerified: advanced };
}

/** Verify every matched, not-yet-verified traveler (optionally one flight). */
export function verifyAllMatched(state, flightId, ctx) {
  let verified = 0;
  for (const r of dataRows(state, { flightId })) {
    if (r.match.status === 'matched' && !r.traveler.data_verified && !r.traveler.data_rejected) { matchAndVerify(state, r.traveler.id, ctx); verified++; }
  }
  return { verified };
}

/**
 * Fix a mismatch: choose which source is right per field. Reason required.
 * @param {Record<string,'nusuk'|'airline'>} choices e.g. { name: 'airline' }
 */
export function fixMismatch(state, travelerId, choices, reason, ctx) {
  assertCan(ctx.user, 'traveler:fix');
  if (!String(reason || '').trim()) throw new ServiceError('REASON_REQUIRED', 'A reason is required to fix a mismatch.');
  const t = state.travelers.find((x) => x.id === travelerId);
  if (!t?.nusuk || !t?.airline) throw new ServiceError('NOT_FIXABLE', 'Only a traveler present in BOTH Nusuk and airline data can be fixed.');
  const m = matchStatus(t);
  if (m.status !== 'mismatch') throw new ServiceError('NOT_MISMATCH', 'There is nothing to fix.');
  const before = { name: t.name, passport: t.passport };
  for (const f of m.fields) {
    const pick = choices?.[f];
    if (pick !== 'nusuk' && pick !== 'airline') throw new ServiceError('CHOICE_REQUIRED', `Choose the correct source for "${f}".`);
    if (f === 'name') t.name = t[pick].name;
    if (f === 'passport') t.passport = t[pick].passport;
  }
  t.mismatch_resolved = { fields: [...(t.mismatch_resolved?.fields || []), ...m.fields], reason: reason.trim(), by: ctx.user.id, at: nowIso(ctx) };
  t.data_rejected = false;
  audit(state, ctx, { action: 'traveler.fix_mismatch', entity: 'Traveler', entityId: t.id, before, after: { name: t.name, passport: t.passport }, note: reason.trim() });
  return t;
}

/** Reject a traveler's data with a note to Ops. */
export function rejectTraveler(state, travelerId, note, ctx) {
  assertCan(ctx.user, 'traveler:fix');
  if (!String(note || '').trim()) throw new ServiceError('REASON_REQUIRED', 'A note for Ops is required.');
  const t = state.travelers.find((x) => x.id === travelerId);
  if (!t) throw new ServiceError('NOT_FOUND', 'Traveler not found.');
  t.data_rejected = true;
  t.data_verified = false;
  state.exceptions.push({ id: `EXC-${pad(nextCounter(state, 'exception'), 6)}`, type: 'Data Mismatch', severity: 'Medium', status: 'Open', traveler_id: t.id, flight_id: t.flight_id, notes: note.trim(), time: nowIso(ctx) });
  notify(state, { role: ROLE.OPS_MANAGER, title: `Data rejected: ${t.name}`, body: note.trim(), severity: 'warning' }, ctx);
  audit(state, ctx, { action: 'traveler.reject', entity: 'Traveler', entityId: t.id, note: note.trim() });
  return t;
}

/** Travelers whose residence is missing or not linked to a CollectionArea. */
export function unmappedAddresses(state) {
  return liveTravelers(state).map((t) => ({ t, res: state.residences.find((r) => r.id === t.residence_id) || null }))
    .filter(({ res }) => !res || !res.collection_area_id)
    .map(({ t, res }) => ({ traveler: t, residence: res, flight: state.flights.find((f) => f.id === t.flight_id)?.code || '—' }));
}

/** Link a residence to a collection area (also fixes the traveler's denormalised area). */
export function mapResidence(state, travelerId, areaId, ctx) {
  assertCan(ctx.user, 'traveler:fix');
  const t = state.travelers.find((x) => x.id === travelerId);
  const area = state.collectionAreas.find((a) => a.id === areaId);
  const res = state.residences.find((r) => r.id === t?.residence_id);
  if (!t || !res) throw new ServiceError('NOT_FOUND', 'Traveler or residence not found.');
  if (!area) throw new ServiceError('NOT_FOUND', 'Collection area not found.');
  const before = { collection_area_id: res.collection_area_id };
  res.collection_area_id = area.id;
  res.manual_area = true;
  t.collection_area_id = area.id;
  for (const b of state.bags.filter((x) => x.traveler_id === t.id)) b.collection_area_id = area.id;
  audit(state, ctx, { action: 'residence.map_area', entity: 'Residence', entityId: res.id, before, after: { collection_area_id: area.id } });
  return res;
}

export { areaForDistrict };

/* ───────────────────────── boarding pass ───────────────────────── */

/** Compare the traveler's boarding_pass_no with airline data → verified, or flagged for the check-in supervisor. */
export function verifyBoardingPass(state, travelerId, ctx) {
  assertCan(ctx.user, 'boarding_pass:verify');
  const t = state.travelers.find((x) => x.id === travelerId);
  if (!t) throw new ServiceError('NOT_FOUND', 'Traveler not found.');
  if (!t.airline?.boarding_pass_no) throw new ServiceError('NO_AIRLINE_DATA', 'No airline boarding-pass data for this traveler yet.');
  const same = norm(t.boarding_pass_no) === norm(t.airline.boarding_pass_no);
  t.boarding_pass_verified = same;
  t.boarding_pass_flag = same ? null : 'Flagged for check-in supervisor';
  audit(state, ctx, { action: same ? 'boarding_pass.verified' : 'boarding_pass.flagged', entity: 'Traveler', entityId: t.id, after: { boarding_pass_no: t.boarding_pass_no } });
  if (!same) notify(state, { role: ROLE.CHECKIN, title: `Boarding pass flagged: ${t.name}`, body: `Number ${t.boarding_pass_no || '—'} does not match airline data.`, severity: 'warning' }, ctx);
  return t;
}

/** Fix the boarding-pass number (reason required) and re-verify. */
export function fixBoardingPass(state, travelerId, newNumber, reason, ctx) {
  assertCan(ctx.user, 'boarding_pass:verify');
  if (!String(reason || '').trim()) throw new ServiceError('REASON_REQUIRED', 'A reason is required.');
  const t = state.travelers.find((x) => x.id === travelerId);
  if (!t) throw new ServiceError('NOT_FOUND', 'Traveler not found.');
  const before = t.boarding_pass_no;
  t.boarding_pass_no = String(newNumber || '').trim();
  audit(state, ctx, { action: 'boarding_pass.fix', entity: 'Traveler', entityId: t.id, before: { boarding_pass_no: before }, after: { boarding_pass_no: t.boarding_pass_no }, note: reason.trim() });
  return verifyBoardingPass(state, travelerId, ctx);
}

/* ───────────────────────── manifest ───────────────────────── */

/** Airline manifest vs bags at "SGS Voucher Accepted". */
export function manifestStatus(state, flightId) {
  const flight = findFlight(state, flightId);
  if (!flight) throw new ServiceError('FLIGHT_NOT_FOUND', 'Flight not found.');
  const sgs = BAG_STATUSES.indexOf('SGS Voucher Accepted');
  const bags = state.bags.filter((b) => b.flight_id === flight.id && !b.legacy);
  const atSgs = bags.filter((b) => BAG_STATUSES.indexOf(b.status) === sgs);
  const loaded = bags.filter((b) => b.status === 'Loaded on Aircraft');
  const manifest = integrations().airlineFeed.fetchManifest(state, flight);
  const lpnSet = new Set(manifest.lpns);
  const missing = atSgs.filter((b) => !b.airline_tag_no || !lpnSet.has(b.airline_tag_no));
  return {
    flight, feed: manifest.feed, manifest_count: manifest.lpns.length, at_sgs: atSgs.length, loaded: loaded.length, total: bags.length,
    gap: manifest.feed === 'Connected' ? missing.length : 0, missing_bags: missing, no_feed: manifest.feed !== 'Connected',
  };
}

/** "Confirm loaded": bags SGS Voucher Accepted → Loaded on Aircraft. Manual confirm (no feed / gap) needs a reason. */
export function confirmLoaded(state, flightId, { manualReason = '' } = {}, ctx) {
  assertCan(ctx.user, 'manifest:confirm');
  const s = manifestStatus(state, flightId);
  if (!s.at_sgs) throw new ServiceError('NOTHING_TO_CONFIRM', 'No bags are at "SGS Voucher Accepted" for this flight.');
  const manual = s.no_feed || s.gap > 0;
  if (manual && !String(manualReason).trim()) {
    throw new ServiceError('REASON_REQUIRED', s.no_feed ? 'No airline feed for this flight — a reason is required for a manual confirmation.' : `${s.gap} bag(s) are missing from the airline manifest — notify Ops or enter a reason.`);
  }
  let n = 0;
  for (const bag of s.flight && state.bags.filter((b) => b.flight_id === s.flight.id && b.status === 'SGS Voucher Accepted')) {
    advanceBag(state, bag.id, 'Loaded on Aircraft', { user: ctx.user, now: ctx.now, note: manual ? `Manual confirm: ${manualReason.trim()}` : 'Manifest confirmed' });
    n++;
  }
  audit(state, ctx, { action: 'manifest.confirm', entity: 'Flight', entityId: s.flight.id, after: { loaded: n, manual }, note: manual ? manualReason.trim() : null });
  return { loaded: n, manual };
}

/** Gaps → "Notify Ops" (creates a Manifest Gap exception + notification). */
export function notifyOpsManifestGap(state, flightId, ctx) {
  assertCan(ctx.user, 'manifest:notify_ops');
  const s = manifestStatus(state, flightId);
  if (!s.gap) throw new ServiceError('NO_GAP', 'There is no manifest gap for this flight.');
  const exc = { id: `EXC-${pad(nextCounter(state, 'exception'), 6)}`, type: 'Manifest Gap', severity: 'High', status: 'Open', flight_id: s.flight.id, notes: `${s.gap} bag(s) at SGS Voucher Accepted are missing from the airline manifest: ${s.missing_bags.map((b) => b.airline_tag_no || b.tag_no).join(', ')}`, time: nowIso(ctx) };
  state.exceptions.push(exc);
  notify(state, { role: ROLE.OPS_MANAGER, title: `Manifest gap on ${s.flight.code}`, body: exc.notes, severity: 'critical' }, ctx);
  audit(state, ctx, { action: 'manifest.notify_ops', entity: 'Flight', entityId: s.flight.id, after: { gap: s.gap } });
  return exc;
}

/* ───────────────────────── dashboard ───────────────────────── */

export function dashboardTiles(state) {
  const rows = dataRows(state);
  return {
    data_rows_pending: rows.filter((r) => !r.traveler.data_verified).length,
    unmapped_addresses: unmappedAddresses(state).length,
    tags_to_release: state.bagTags.filter((t) => t.tag_type === 'IATA_LPN' && t.status === 'Assigned').length,
    // travelers with no airline boarding-pass data yet show up under "data missing", not here
    boarding_passes_unverified: liveTravelers(state).filter((t) => t.airline?.boarding_pass_no && !t.boarding_pass_verified).length,
    manifest_gaps: state.flights.filter((f) => !['Cancelled', 'Completed'].includes(f.status)).filter((f) => manifestStatus(state, f.id).gap > 0).length,
  };
}
