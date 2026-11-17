/**
 * Departure v7 demo seed — IDEMPOTENT: every step upserts by stable id / skips what exists, so
 * running it twice never creates duplicates and never overwrites user edits.
 * Phase 2 content: airlines, flights, collection areas + slots, 14 travelers (Nusuk + airline data,
 * residences), pre-booked collections, the cancelled flight's 8 bags, sample airline tag files.
 * Phase 7 extends this with staff/transport/trips/incidents and the "Reset demo data" action.
 */
import { makeAirline, makeFlight, makeBag } from '../models.js';
import { integrations } from '../integrations/index.js';
import { ensureBaseAccounts } from './baseAccounts.js';
import { upsertFromNusuk, upsertFromAirline, ensureSlots, bookCollection, availableSlots } from '../services/travelerService.js';
import { verifyBoardingPass } from '../services/backendService.js';
import { advanceBag } from '../services/bagService.js';
import { issueInternalLabel } from '../services/tagService.js';
import { nextCounter } from '../services/audit.js';

export const SEED_VERSION = 3;
const H = 3600e3;

export const SEED_AIRLINES = Object.freeze([
  { code: 'SV', name: 'Saudia', bags_allowed: 2, extra_bags_max: 2, max_bag_weight_kg: 23, btic_codes: ['065'], data_feed_status: 'Connected' },
  { code: 'GA', name: 'Garuda Indonesia', bags_allowed: 2, extra_bags_max: 1, max_bag_weight_kg: 20, btic_codes: ['126'], data_feed_status: 'Connected' },
  { code: 'PK', name: 'Pakistan International', bags_allowed: 2, extra_bags_max: 0, max_bag_weight_kg: 23, btic_codes: ['214'], data_feed_status: 'Not connected' },
]);

/** 5 flights in the next 24 h: one Cancelled (8 bags), one New with no airline tag list. Offsets are hours from `now`. */
export const SEED_FLIGHTS = Object.freeze([
  { id: 'FLT-SV-1821', code: 'SV 1821', airline_code: 'SV', route: 'JED → CGK', status: 'Scheduled', cut_off_h: 6 },
  { id: 'FLT-GA-981', code: 'GA 981', airline_code: 'GA', route: 'JED → CGK', status: 'Scheduled', cut_off_h: 14 },
  { id: 'FLT-PK-760', code: 'PK 760', airline_code: 'PK', route: 'JED → LHE', status: 'Scheduled', cut_off_h: 20 },
  { id: 'FLT-SV-1944', code: 'SV 1944', airline_code: 'SV', route: 'JED → DAC', status: 'Cancelled', cut_off_h: 10, cancel_reason: 'Airline cancelled the departure (operational).' },
  { id: 'FLT-GA-7005', code: 'GA 7005', airline_code: 'GA', route: 'JED → KNO', status: 'New', cut_off_h: 23 },
]);

/** Sample airline tag files for the Backend "Import airline file" demo. SV has a leading-zero LPN + a bad-format row; GA has a duplicate. */
export const SAMPLE_TAG_FILES = Object.freeze([
  { id: 'sv', label: 'SV 1821 — Saudia tags', file: 'SV1821_tags.csv', csv: [
    'booking_ref,flight,lpn',
    'SVK7Q1,SV 1821,0650012345', 'SVK7Q1,SV 1821,0650012346', 'SVK7Q2,SV 1821,0650012347', 'SVK7Q2,SV 1821,0650012348',
    'SVK7Q3,SV 1821,0650012349', 'SVK7Q3,SV 1821,0650012350', ',SV 1821,0650012351', ',SV 1821,0650012352',
    'SVK7Q3,SV 1821,12345',
  ].join('\n') },
  { id: 'ga', label: 'GA 981 — Garuda tags', file: 'GA981_tags.csv', csv: [
    'booking_ref,flight,lpn',
    'GAM4R1,GA 981,1260020001', 'GAM4R1,GA 981,1260020002', 'GAM4R2,GA 981,1260020003', 'GAM4R2,GA 981,1260020004',
    'GAM4R3,GA 981,1260020005', 'GAM4R3,GA 981,1260020006', ',GA 981,1260020007',
    'GAM4R3,GA 981,1260020001',
  ].join('\n') },
  { id: 'pk', label: 'PK 760 — PIA tags', file: 'PK760_tags.csv', csv: [
    'booking_ref,flight,lpn',
    'PKT9S1,PK 760,2140030001', 'PKT9S1,PK 760,2140030002', 'PKT9S2,PK 760,2140030003', 'PKT9S2,PK 760,2140030004', ',PK 760,2140030005',
  ].join('\n') },
]);

/**
 * @param {any} state a migrated v7 state
 * @param {{ now?: number|Date }} [opts]
 */
export function seedDeparture(state, opts = {}) {
  const now = new Date(opts.now ?? Date.now()).getTime();
  const ctx = { now };
  ensureBaseAccounts(state);

  for (const a of SEED_AIRLINES) {
    if (!state.airlines.some((x) => x.code === a.code)) state.airlines.push(makeAirline(a));
  }
  for (const f of SEED_FLIGHTS) {
    const existing = state.flights.find((x) => x.id === f.id);
    // A flight imported from the pre-v7 stores has no cut-off/window: upgrade it in place (once).
    if (existing && existing.cut_off_at) continue;
    const next = makeFlight({
      id: f.id, code: f.code, airline_code: f.airline_code, route: f.route, status: f.status, cut_off_at: new Date(now + f.cut_off_h * H).toISOString(),
      cancelled_at: f.status === 'Cancelled' ? new Date(now - 1 * H).toISOString() : null, cancel_reason: f.cancel_reason ?? null,
      no_airline_tag: f.id === 'FLT-GA-7005',
    });
    if (existing) Object.assign(existing, next, { legacy: false }); else state.flights.push(next);
  }
  // Heal: airline data must never be attached to pre-v7 (legacy) travelers.
  for (const t of state.travelers.filter((x) => x.legacy && x.airline)) { t.airline = null; t.booking_ref = null; }
  state.airports ||= [];

  // Travelers: Nusuk first (identity + residence), then airline data (booking ref, boarding pass).
  const { nusuk, airlineFeed } = integrations();
  for (const rec of nusuk.fetchAll()) upsertFromNusuk(state, rec, ctx);
  for (const rec of airlineFeed.fetchReservations()) upsertFromAirline(state, rec);

  // Slots (2-hour, inside each live flight's 8 h collection window) for every area.
  for (const f of state.flights.filter((x) => x.status !== 'Cancelled')) {
    for (const area of state.collectionAreas) ensureSlots(state, area.id, f);
  }

  // Boarding passes: verify every traveler whose number matches airline data; the 2 demo mismatches stay flagged/unverified.
  const be = state.users.find((u) => u.employee_id === 'BE-001');
  for (const t of state.travelers) {
    if (t.airline && !t.boarding_pass_verified && !t.boarding_pass_flag) verifyBoardingPass(state, t.id, { user: be, now });
  }

  // The cancelled flight's 8 bags (4 travelers × 2) are already at the warehouse.
  seedCancelledFlightBags(state, now);

  // Pre-booked residence collections (some travelers are left un-booked so the booking flow can be demoed).
  const prebooked = ['2000000001', '2000000002', '2000000003', '2000000007'];
  for (const nid of prebooked) {
    const t = state.travelers.find((x) => x.nusuk_id === nid);
    if (!t || state.collectionAssignments.some((a) => a.traveler_id === t.id)) continue;
    const slot = availableSlots(state, t.id, ctx).find((s) => !s.full);
    if (!slot) continue;
    const { assignment } = bookCollection(state, t.id, { bags: 2, slotId: slot.id }, ctx);
    if (nid === '2000000003') assignment.demo_absent = true; // Phase 3 demo: this traveler will not be at home
  }

  state.seed_version = SEED_VERSION;
  return state;
}

function seedCancelledFlightBags(state, now) {
  const flight = state.flights.find((f) => f.id === 'FLT-SV-1944');
  if (!flight) return;
  const wh = 'WH-MAKKAH';
  let lpnSerial = 1;
  for (const t of state.travelers.filter((x) => x.flight_id === flight.id)) {
    if (state.bags.some((b) => b.traveler_id === t.id)) continue;
    t.data_verified = true;
    t.boarding_pass_verified = true;
    const res = state.residences.find((r) => r.id === t.residence_id);
    for (let i = 0; i < 2; i++) {
      const bag = makeBag({
        id: `BAG-${String(nextCounter(state, 'bag')).padStart(6, '0')}`, traveler_id: t.id, flight_id: flight.id, collection_area_id: res?.collection_area_id ?? null,
        warehouse_id: wh, airport_id: 'JED', weight_kg: 19 + i, meets_airline_criteria: true, tag_verified: true, created_at: new Date(now - 9 * H).toISOString(),
      });
      state.bags.push(bag);
      issueInternalLabel(state, bag);
      const lpn = `06599${String(lpnSerial++).padStart(5, '0')}`;
      bag.airline_tag_no = lpn;
      state.bagTags.push({ id: `BTAG-${String(nextCounter(state, 'bagTag')).padStart(6, '0')}`, bag_id: bag.id, tag_type: 'IATA_LPN', lpn, tag_no: null, issuer_code: '065', serial: lpn.slice(3, 9),
        source: 'Airline DCS', airline_code: 'SV', flight_id: flight.id, traveler_id: t.id, collection_area_id: bag.collection_area_id, status: 'Scanned', void_reason: null, batch_id: 'TIB-SEED' });
      for (const to of ['Data Verified', 'Tag Assigned', 'Checked-in', 'Loaded to Collection Truck', 'Received at Warehouse']) {
        advanceBag(state, bag.id, to, { system: true, now, countMatch: true, note: 'Seed' });
      }
    }
  }
}

