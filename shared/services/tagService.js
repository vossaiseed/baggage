/**
 * tagService — airline tag (LPN) import / assign / release / void, internal Rabel labels,
 * "internal tags only" flights, label sheets and tag verification.
 *
 * Rabel cannot create IATA tags: Backend IMPORTS the airline's numbers, assigns them to
 * traveler + flight and RELEASES them to check-in staff. Every bag also gets an internal
 * label `tag_no` = RBL-D-xxxxxx used for every internal hand-off.
 */
import { assertCan } from '../rbac.js';
import { INTERNAL_TAG_PREFIX } from '../constants.js';
import { advanceBag } from './bagService.js';
import { audit, nextCounter, nowIso } from './audit.js';
import { notify } from './notify.js';
import { ServiceError } from './errors.js';
import { validateLpn } from '../tags/validateLpn.js';
import { parseCsv } from '../tags/csv.js';

const pad = (n, w) => String(n).padStart(w, '0');
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();

/** @param {any} state @param {string} flightRef flight id or code ("SV 1821") */
export function findFlight(state, flightRef) {
  const r = norm(flightRef);
  return state.flights.find((f) => norm(f.id) === r || norm(f.code) === r) || null;
}

/** Issue (once) the internal Rabel label for a bag. @returns {string} tag_no */
export function issueInternalLabel(state, bag) {
  if (bag.tag_no) return bag.tag_no;
  bag.tag_no = `${INTERNAL_TAG_PREFIX}${pad(nextCounter(state, 'internalTag'), 6)}`;
  state.bagTags.push({
    id: `BTAG-${pad(nextCounter(state, 'bagTag'), 6)}`, bag_id: bag.id, tag_type: 'INTERNAL', lpn: null, tag_no: bag.tag_no,
    issuer_code: null, serial: null, source: 'Internal', airline_code: null, flight_id: bag.flight_id, traveler_id: bag.traveler_id,
    collection_area_id: bag.collection_area_id ?? null, status: 'Assigned', void_reason: null, batch_id: null,
  });
  return bag.tag_no;
}

/**
 * Import an airline tag list (CSV text or pre-parsed rows). Every row is validated; rejected rows are
 * returned with a reason and stored on the TagImportBatch.
 * CSV columns: booking_ref, flight, lpn
 * @param {any} state
 * @param {{ source?: 'Airline DCS'|'SGS'|'Manual', fileName?: string, csv?: string, rows?: {line?:number, cells:Record<string,string>}[] }} input
 * @param {{ user: any, now?: any }} ctx
 */
export function importTagBatch(state, input, ctx) {
  assertCan(ctx.user, 'tag:import');
  const parsed = input.rows ? { header: ['booking_ref', 'flight', 'lpn'], rows: input.rows } : parseCsv(input.csv || '');
  if (!parsed.rows.length) throw new ServiceError('EMPTY_FILE', 'The file has no rows.');
  if (!parsed.header.includes('lpn') || !parsed.header.includes('flight')) {
    throw new ServiceError('BAD_HEADER', 'The file must have the columns: booking_ref, flight, lpn.');
  }
  const batchId = `TIB-${pad(nextCounter(state, 'tagBatch'), 4)}`;
  const flightIds = state.flights.map((f) => f.id);
  const rejected = [];
  let ok = 0;
  const touchedFlights = new Set();

  for (const { line, cells } of parsed.rows) {
    const flight = findFlight(state, cells.flight);
    const airline = flight ? state.airlines.find((a) => a.code === flight.airline_code) : null;
    const verdict = validateLpn(cells.lpn, { mode: 'import', airline, tags: state.bagTags, flightIds, flightId: flight?.id });
    if (!verdict.ok) {
      rejected.push({ line: line ?? null, booking_ref: cells.booking_ref || null, flight: cells.flight || null, lpn: cells.lpn || '', reason: verdict.message, code: verdict.code });
      continue;
    }
    const traveler = cells.booking_ref
      ? state.travelers.find((t) => norm(t.booking_ref) === norm(cells.booking_ref) && t.flight_id === flight.id)
      : null;
    state.bagTags.push({
      id: `BTAG-${pad(nextCounter(state, 'bagTag'), 6)}`, bag_id: null, tag_type: 'IATA_LPN', lpn: verdict.lpn, tag_no: null,
      issuer_code: verdict.issuer_code, serial: verdict.serial, source: input.source || 'Airline DCS', airline_code: airline.code,
      flight_id: flight.id, traveler_id: traveler?.id ?? null, booking_ref: cells.booking_ref || null, collection_area_id: null,
      status: 'Imported', void_reason: null, batch_id: batchId,
    });
    touchedFlights.add(flight.id);
    ok++;
  }
  for (const fid of touchedFlights) state.flights.find((f) => f.id === fid).no_airline_tag = false;

  const batch = {
    id: batchId, source: input.source || 'Airline DCS', file_name: input.fileName || 'tags.csv', rows_ok: ok, rows_rejected: rejected.length,
    rejected_rows: rejected, imported_by: ctx.user.id, status: ok ? (rejected.length ? 'Partial' : 'Completed') : 'Rejected', at: nowIso(ctx),
  };
  state.tagImportBatches.push(batch);
  audit(state, ctx, { action: 'tag.import', entity: 'TagImportBatch', entityId: batchId, after: { ok, rejected: rejected.length, file: batch.file_name } });
  return batch;
}

/** Bags of a flight that Backend can tag: Data Verified, no airline tag yet. */
function untaggedBags(state, flightId) {
  return state.bags.filter((b) => b.flight_id === flightId && b.status === 'Data Verified' && !b.airline_tag_no);
}

/**
 * Auto-assign imported LPNs to the declared (Data Verified) bags of a flight.
 * A tag pre-bound to a traveler (via booking_ref) goes to that traveler's bags first.
 * @returns {{ assigned: number, shortage: number }}
 */
export function assignTags(state, flightId, ctx) {
  assertCan(ctx.user, 'tag:assign');
  const flight = findFlight(state, flightId);
  if (!flight) throw new ServiceError('FLIGHT_NOT_FOUND', 'Flight not found.');
  const bags = untaggedBags(state, flight.id).sort((a, b) => String(a.traveler_id).localeCompare(String(b.traveler_id)) || a.id.localeCompare(b.id));
  const pool = () => state.bagTags.filter((t) => t.tag_type === 'IATA_LPN' && t.flight_id === flight.id && t.status === 'Imported' && !t.bag_id);
  let assigned = 0;
  for (const bag of bags) {
    const free = pool();
    const tag = free.find((t) => t.traveler_id === bag.traveler_id) || free.find((t) => !t.traveler_id);
    if (!tag) continue;
    issueInternalLabel(state, bag);
    tag.bag_id = bag.id;
    tag.traveler_id = bag.traveler_id;
    tag.collection_area_id = bag.collection_area_id ?? null;
    tag.status = 'Assigned';
    bag.airline_tag_no = tag.lpn; // STRING, leading zeros kept
    assigned++;
  }
  audit(state, ctx, { action: 'tag.assign', entity: 'Flight', entityId: flight.id, after: { assigned, shortage: bags.length - assigned } });
  return { assigned, shortage: bags.length - assigned };
}

/** Release assigned tags to check-in staff: bags Data Verified → Tag Assigned. @returns {{released:number}} */
export function releaseTags(state, flightId, ctx) {
  assertCan(ctx.user, 'tag:release');
  const flight = findFlight(state, flightId);
  if (!flight) throw new ServiceError('FLIGHT_NOT_FOUND', 'Flight not found.');
  let released = 0;
  for (const tag of state.bagTags.filter((t) => t.tag_type === 'IATA_LPN' && t.flight_id === flight.id && t.status === 'Assigned')) {
    const bag = state.bags.find((b) => b.id === tag.bag_id);
    if (!bag || bag.status !== 'Data Verified') continue;
    advanceBag(state, bag.id, 'Tag Assigned', { user: ctx.user, now: ctx.now, note: `Airline tag ${tag.lpn} released` });
    tag.status = 'Released';
    const internal = state.bagTags.find((t) => t.tag_type === 'INTERNAL' && t.bag_id === bag.id);
    if (internal) internal.status = 'Released';
    released++;
  }
  audit(state, ctx, { action: 'tag.release', entity: 'Flight', entityId: flight.id, after: { released } });
  return { released };
}

/**
 * Flight without an airline tag list: bags run on the INTERNAL tag only (→ Tag Assigned),
 * the flight is flagged "No airline tag" and Ops is notified.
 */
export function issueInternalOnly(state, flightId, ctx) {
  assertCan(ctx.user, 'tag:issue_internal');
  const flight = findFlight(state, flightId);
  if (!flight) throw new ServiceError('FLIGHT_NOT_FOUND', 'Flight not found.');
  if (state.bagTags.some((t) => t.tag_type === 'IATA_LPN' && t.flight_id === flight.id && t.status !== 'Void')) {
    throw new ServiceError('HAS_AIRLINE_TAGS', 'This flight has an airline tag list — assign and release those instead.');
  }
  let issued = 0;
  for (const bag of untaggedBags(state, flight.id)) {
    issueInternalLabel(state, bag);
    advanceBag(state, bag.id, 'Tag Assigned', { user: ctx.user, now: ctx.now, note: 'Internal tag only (no airline tag list)' });
    const internal = state.bagTags.find((t) => t.tag_type === 'INTERNAL' && t.bag_id === bag.id);
    if (internal) internal.status = 'Released';
    issued++;
  }
  flight.no_airline_tag = true;
  notify(state, { role: 'ops_manager', title: `No airline tags for ${flight.code}`, body: 'Bags run on the Rabel internal tag only. Please follow up with the airline.', severity: 'warning', link: null }, ctx);
  audit(state, ctx, { action: 'tag.issue_internal_only', entity: 'Flight', entityId: flight.id, after: { issued } });
  return { issued };
}

/** Damaged tag: void the old LPN, assign a spare from the SAME batch and release it. */
export function voidAndReplace(state, tagId, reason, ctx) {
  assertCan(ctx.user, 'tag:void');
  if (!reason?.trim()) throw new ServiceError('REASON_REQUIRED', 'A reason is required to void a tag.');
  const tag = state.bagTags.find((t) => t.id === tagId && t.tag_type === 'IATA_LPN');
  if (!tag) throw new ServiceError('NOT_FOUND', 'Tag not found.');
  if (tag.status === 'Void') throw new ServiceError('ALREADY_VOID', 'Tag is already void.');
  const bag = state.bags.find((b) => b.id === tag.bag_id) || null;
  const spare = state.bagTags.find((t) => t.tag_type === 'IATA_LPN' && t.batch_id === tag.batch_id && t.flight_id === tag.flight_id && t.status === 'Imported' && !t.bag_id);
  tag.status = 'Void';
  tag.void_reason = reason.trim();
  audit(state, ctx, { action: 'tag.void', entity: 'BagTag', entityId: tag.id, before: { lpn: tag.lpn }, note: tag.void_reason });
  if (!spare) {
    state.exceptions.push({ id: `EXC-${pad(nextCounter(state, 'exception'), 6)}`, type: 'Damaged Tag', severity: 'Medium', status: 'Open', flight_id: tag.flight_id, bag_id: bag?.id ?? null, notes: `Tag ${tag.lpn} voided; no spare left in batch ${tag.batch_id}.`, time: nowIso(ctx) });
    throw new ServiceError('NO_SPARE', `Tag voided, but there is no spare tag left in batch ${tag.batch_id}. Import more tags.`);
  }
  spare.bag_id = bag?.id ?? null;
  spare.traveler_id = tag.traveler_id;
  spare.collection_area_id = tag.collection_area_id ?? null;
  spare.status = 'Released';
  if (bag) { bag.airline_tag_no = spare.lpn; bag.tag_verified = false; }
  audit(state, ctx, { action: 'tag.replace', entity: 'BagTag', entityId: spare.id, after: { lpn: spare.lpn, replaces: tag.lpn } });
  return { voided: tag, replacement: spare };
}

/** Printable internal-label sheet rows for one collection area (and optionally one slot). */
export function labelSheet(state, { areaId, slotId = null }, ctx) {
  assertCan(ctx.user, 'tag:print_labels');
  const assignments = state.collectionAssignments.filter((a) => a.collection_area_id === areaId && (!slotId || a.slot_id === slotId));
  const rows = [];
  for (const a of assignments) {
    const traveler = state.travelers.find((t) => t.id === a.traveler_id);
    for (const bag of state.bags.filter((b) => b.traveler_id === a.traveler_id && b.tag_no)) {
      rows.push({ tag_no: bag.tag_no, airline_tag_no: bag.airline_tag_no, traveler: traveler?.name || '', flight: state.flights.find((f) => f.id === bag.flight_id)?.code || '', slot_id: a.slot_id });
    }
  }
  return rows;
}

/** Released vs attached vs scanned for a flight, plus the problem scans. */
export function tagVerification(state, flightId) {
  const tags = state.bagTags.filter((t) => t.tag_type === 'IATA_LPN' && t.flight_id === flightId);
  const count = (s) => tags.filter((t) => t.status === s).length;
  const scans = state.scanEvents.filter((e) => e.flight_id === flightId || tags.some((t) => t.lpn === e.raw_value));
  const issues = scans.filter((e) => e.result !== 'OK').map((e) => ({ at: e.at, raw_value: e.raw_value, result: e.result, step: e.step }));
  return {
    imported: count('Imported'), assigned: count('Assigned'), released: count('Released'), attached: count('Attached'), scanned: count('Scanned'), void: count('Void'),
    unused: tags.filter((t) => t.status === 'Released').length, total: tags.length, issues,
  };
}
