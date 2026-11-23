import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from '../../shared/store.js';
import { seedDeparture, SAMPLE_TAG_FILES } from '../../shared/seed/departure.js';
import { validateState, summarise } from '../../shared/seed/validate.js';
import * as tags from '../../shared/services/tagService.js';
import * as be from '../../shared/services/backendService.js';
import * as tv from '../../shared/services/travelerService.js';
import { PermissionError } from '../../shared/rbac.js';
import { ServiceError } from '../../shared/services/errors.js';

const NOW = new Date('2026-06-01T06:00:00Z').getTime();
let state;
let BE;
let OPS;
let CHK;
const ctx = (user) => ({ user, now: NOW });
const trav = (nid) => state.travelers.find((t) => t.nusuk_id === nid);
const csv = (id) => SAMPLE_TAG_FILES.find((f) => f.id === id).csv;

beforeEach(() => {
  state = createStore({ storage: null, baseAccounts: false }).get();
  seedDeparture(state, { now: NOW });
  BE = state.users.find((u) => u.id === 'BE-001');
  OPS = state.users.find((u) => u.id === 'OPS-001');
  CHK = state.users.find((u) => u.id === 'CHK-001');
});

describe('seed', () => {
  it('has 3 airlines, 5 flights (1 cancelled with 8 bags, 1 New without airline tags), 14 travelers with residences', () => {
    expect(state.airlines.map((a) => [a.code, a.bags_allowed, a.extra_bags_max, a.max_bag_weight_kg, a.btic_codes[0]])).toEqual([['SV', 2, 2, 23, '065'], ['GA', 2, 1, 20, '126'], ['PK', 2, 0, 23, '214']]);
    expect(state.flights).toHaveLength(5);
    const cancelled = state.flights.find((f) => f.status === 'Cancelled');
    expect(state.bags.filter((b) => b.flight_id === cancelled.id)).toHaveLength(8);
    expect(state.flights.find((f) => f.status === 'New').no_airline_tag).toBe(true);
    expect(state.travelers).toHaveLength(14);
    expect(state.travelers.every((t) => t.nusuk_id && t.residence_id)).toBe(true);
  });
  it('has exactly 1 unmapped address, 2 unverified boarding passes, and Nusuk/airline mismatches + a missing record', () => {
    expect(be.unmappedAddresses(state)).toHaveLength(1);
    expect(state.travelers.filter((t) => !t.boarding_pass_verified && t.boarding_pass_flag)).toHaveLength(2);
    const rows = be.dataRows(state);
    expect(rows.filter((r) => r.match.status === 'mismatch').map((r) => r.match.fields[0]).sort()).toEqual(['name', 'passport']);
    expect(rows.filter((r) => r.match.status === 'missing')).toHaveLength(1);
  });
  it('is idempotent — running twice creates no duplicates', () => {
    const snap = (s) => JSON.stringify(['travelers', 'residences', 'flights', 'airlines', 'bags', 'bagTags', 'collectionSlots', 'collectionAssignments', 'users', 'collectionAreas'].map((k) => s[k].length));
    const before = snap(state);
    seedDeparture(state, { now: NOW });
    seedDeparture(state, { now: NOW + 3600e3 });
    expect(snap(state)).toBe(before);
  });
});

describe('Traveler login + Nusuk', () => {
  it('finds a traveler by Nusuk ID or booking ref + passport; unknown → "Booking not found in Nusuk or airline data"', () => {
    expect(tv.findTravelerForLogin(state, '2000000001', 'c1234567').id).toBe('TRV-2000000001');
    expect(tv.findTravelerForLogin(state, 'svk7q1', 'C1234567').id).toBe('TRV-2000000001');
    expect(() => tv.findTravelerForLogin(state, '2000000001', 'WRONG')).toThrowError('Booking not found in Nusuk or airline data');
    expect(() => tv.findTravelerForLogin(state, '9999999999', 'C1234567')).toThrowError('Booking not found in Nusuk or airline data');
  });
  it('OTP is the simulated 123456', () => {
    expect(tv.verifyOtp('123456')).toBe(true);
    expect(() => tv.verifyOtp('000000')).toThrow(ServiceError);
  });
  it('travelers can correct ONLY flat no., landmark and phone — each change is logged; sync never overwrites a correction', () => {
    const t = trav('2000000004');
    const r = tv.updateContact(state, t.id, { flat_no: '1106', landmark: 'Tower B, near lift', contact_phone: '+966511111111' }, { now: NOW });
    expect(r.changed).toBe(3);
    expect(state.residences.find((x) => x.id === t.residence_id).change_log).toHaveLength(3);
    expect(state.auditLog.filter((a) => a.action === 'traveler.contact_change')).toHaveLength(3);
    expect(() => tv.updateContact(state, t.id, { building: 'Hacked' }, {})).toThrowError(/only change/);
    expect(() => tv.updateContact(state, t.id, { contact_phone: 'abc' }, {})).toThrowError(/valid phone/);
    tv.syncFromNusuk(state, t.id, { now: NOW });
    const res = state.residences.find((x) => x.id === t.residence_id);
    expect(res.flat_no).toBe('1106');
    expect(res.building).toBe('Aziziyah Towers');
    expect(t.nusuk_synced_at).toBeTruthy();
  });
});

describe('Traveler booking', () => {
  it('offers only 2-hour slots inside the flight’s 8 h window, in the future, by availability', () => {
    const t = trav('2000000004'); // GA 981, cut-off +14h → window [+2h,+10h]
    const slots = tv.availableSlots(state, t.id, { now: NOW });
    const f = state.flights.find((x) => x.id === t.flight_id);
    expect(slots).toHaveLength(4);
    for (const s of slots) {
      expect(new Date(s.end) - new Date(s.start)).toBe(2 * 3600e3);
      expect(new Date(s.start) >= new Date(f.cut_off_at) - 12 * 3600e3).toBe(true);
      expect(new Date(s.end) <= new Date(f.cut_off_at) - 4 * 3600e3).toBe(true);
    }
    // SV 1821 cut-off +6h → window [-6h,+2h]; only the not-yet-finished slot is offered
    expect(tv.availableSlots(state, trav('2000000002').id, { now: NOW + 1 })).toHaveLength(1);
  });
  it('airline rules: SV 2 + up to 2 extra, GA 2 + 1, PK 2 + 0; extra bags need airline approval', () => {
    const pol = (nid) => { const p = tv.airlinePolicyFor(state, trav(nid)); return [p.bags_allowed, p.extra_bags_max, p.max_bag_weight_kg]; };
    expect(pol('2000000001')).toEqual([2, 2, 23]);
    expect(pol('2000000004')).toEqual([2, 1, 20]);
    expect(pol('2000000008')).toEqual([2, 0, 23]);
    const t = trav('2000000004');
    const slot = tv.availableSlots(state, t.id, { now: NOW })[0];
    expect(() => tv.bookCollection(state, t.id, { bags: 4, slotId: slot.id }, { now: NOW })).toThrowError(/at most 3 bags/);
    const r = tv.bookCollection(state, t.id, { bags: 3, slotId: slot.id }, { now: NOW });
    expect(r.extraCount).toBe(1);
    expect(r.assignment).toMatchObject({ extra_bags: 1, extra_approval: 'Pending', status: 'Assigned' });
    expect(r.bags.map((b) => b.extra)).toEqual([false, false, true]);
    expect(r.bags.every((b) => b.status === 'Declared')).toBe(true);
    expect(state.notifications.some((n) => n.channel === 'sms' && n.traveler_id === t.id)).toBe(true);
    expect(() => tv.bookCollection(state, t.id, { bags: 2, slotId: slot.id }, { now: NOW })).toThrowError(/already have/);
  });
  it('PK allows no extra bags', () => {
    const t = trav('2000000008');
    const slot = tv.availableSlots(state, t.id, { now: NOW })[0];
    expect(() => tv.bookCollection(state, t.id, { bags: 3, slotId: slot.id }, { now: NOW })).toThrowError(/at most 2 bags/);
  });
  it('full slots, slots outside the window and unmapped addresses are refused; cancelled flights cannot book', () => {
    const t = trav('2000000004');
    const slot = tv.availableSlots(state, t.id, { now: NOW })[0];
    state.collectionSlots.find((s) => s.id === slot.id).booked_count = 6;
    expect(() => tv.bookCollection(state, t.id, { bags: 2, slotId: slot.id }, { now: NOW })).toThrowError(/full/);
    expect(() => tv.bookCollection(state, t.id, { bags: 2, slotId: 'SLOT-NOPE' }, { now: NOW })).toThrowError(/not available/);
    expect(() => tv.bookCollection(state, trav('2000000014').id, { bags: 2, slotId: 'x' }, { now: NOW })).toThrowError(/not linked to a collection area/);
    expect(() => tv.bookCollection(state, trav('2000000010').id, { bags: 2, slotId: 'x' }, { now: NOW })).toThrowError(/cancelled/);
  });
  it('a traveler cannot book for someone else (RBAC scope: own)', () => {
    const a = trav('2000000004');
    const slot = tv.availableSlots(state, a.id, { now: NOW })[0];
    expect(() => tv.bookCollection(state, 'TRV-NOBODY', { bags: 2, slotId: slot.id }, {})).toThrow(ServiceError);
  });
  it('reschedule after "Traveler Absent" moves the booking inside the window', () => {
    const t = trav('2000000003');
    const a = state.collectionAssignments.find((x) => x.traveler_id === t.id);
    a.status = 'Traveler Absent';
    const next = tv.availableSlots(state, t.id, { now: NOW + 1 }).find((s) => s.id !== a.slot_id) || tv.availableSlots(state, t.id, { now: NOW + 1 })[0];
    tv.rescheduleAssignment(state, a.id, next.id, { now: NOW + 1 });
    expect(a.status).toBe('Assigned');
    expect(a.slot_id).toBe(next.id);
  });
  it('tracking: 13-step timeline, cancelled-flight banner, absent banner, receipt only after check-in', () => {
    const cancelled = tv.trackingFor(state, trav('2000000010').id);
    expect(cancelled.timeline).toHaveLength(13);
    expect(cancelled.banners.map((b) => b.kind)).toContain('cancelled');
    expect(cancelled.timeline.filter((s) => s.done).map((s) => s.status).at(-1)).toBe('Received at Warehouse');
    expect(cancelled.receipt).not.toBeNull();
    const fresh = tv.trackingFor(state, trav('2000000001').id);
    expect(fresh.receipt).toBeNull();
    expect(fresh.timeline[0]).toMatchObject({ status: 'Declared', done: true });
    const t3 = trav('2000000003');
    state.collectionAssignments.find((x) => x.traveler_id === t3.id).status = 'Traveler Absent';
    expect(tv.trackingFor(state, t3.id).banners.map((b) => b.kind)).toContain('absent');
  });
});

describe('Backend — data collection', () => {
  it('Sync Nusuk is idempotent (0 new), airline import by CSV validates the header', () => {
    expect(be.syncNusuk(state, ctx(BE))).toMatchObject({ checked: 14, created: 0 });
    expect(() => be.importAirlineFile(state, 'a,b\n1,2', ctx(BE))).toThrowError(/missing booking_ref/);
    expect(be.importAirlineFile(state, '', ctx(BE)).rows).toBe(13);
    expect(state.travelers).toHaveLength(14);
  });
  it('match & verify: only matched travelers; bags → Data Verified and get internal labels', () => {
    const t = trav('2000000001');
    const r = be.matchAndVerify(state, t.id, ctx(BE));
    expect(r.bagsVerified).toBe(2);
    const bags = state.bags.filter((b) => b.traveler_id === t.id);
    expect(bags.every((b) => b.status === 'Data Verified' && /^RBL-D-\d{6}$/.test(b.tag_no))).toBe(true);
    expect(new Set(state.bags.map((b) => b.tag_no).filter(Boolean)).size).toBe(state.bags.filter((b) => b.tag_no).length);
    expect(() => be.matchAndVerify(state, trav('2000000005').id, ctx(BE))).toThrowError(/mismatch on name/);
    expect(() => be.matchAndVerify(state, trav('2000000013').id, ctx(BE))).toThrowError(/missing from airline/);
    expect(() => be.matchAndVerify(state, t.id, ctx(CHK))).toThrow(PermissionError);
  });
  it('mismatch: fix needs a reason and a choice, then verifies; reject notifies Ops', () => {
    const t = trav('2000000005');
    expect(() => be.fixMismatch(state, t.id, { name: 'airline' }, '', ctx(BE))).toThrowError(/reason/i);
    expect(() => be.fixMismatch(state, t.id, {}, 'Passport checked', ctx(BE))).toThrowError(/Choose the correct source/);
    be.fixMismatch(state, t.id, { name: 'airline' }, 'Airline spelling is on the passport', ctx(BE));
    expect(t.name).toBe('Dewi Lestari Putri');
    expect(be.matchStatus(t).status).toBe('matched');
    expect(be.matchAndVerify(state, t.id, ctx(BE)).traveler.data_verified).toBe(true);
    const bad = trav('2000000006');
    be.rejectTraveler(state, bad.id, 'Passport differs — call the airline', ctx(BE));
    expect(bad.data_rejected).toBe(true);
    expect(state.exceptions.some((e) => e.type === 'Data Mismatch' && e.traveler_id === bad.id)).toBe(true);
    expect(state.notifications.some((n) => n.roles.includes('ops_manager'))).toBe(true);
  });
  it('unmapped address can be mapped to a collection area (bags follow)', () => {
    const t = trav('2000000014');
    be.mapResidence(state, t.id, 'AREA-AL-AWALI', ctx(BE));
    expect(be.unmappedAddresses(state)).toHaveLength(0);
    expect(t.collection_area_id).toBe('AREA-AL-AWALI');
  });
  it('dashboard tiles match the seed: 2 unverified boarding passes, 1 unmapped address', () => {
    const t = be.dashboardTiles(state);
    expect(t).toMatchObject({ unmapped_addresses: 1, boarding_passes_unverified: 2, tags_to_release: 0, manifest_gaps: 0 });
    expect(t.data_rows_pending).toBe(10); // the cancelled flight's 4 travelers are already verified
  });
  it('boarding pass: mismatch flagged for the supervisor, fix with reason re-verifies', () => {
    const t = trav('2000000004');
    expect(t.boarding_pass_verified).toBe(false);
    expect(t.boarding_pass_flag).toMatch(/supervisor/);
    expect(() => be.fixBoardingPass(state, t.id, 'BP-GA981-001', ' ', ctx(BE))).toThrowError(/reason/);
    be.fixBoardingPass(state, t.id, 'BP-GA981-001', 'Typo: letter O instead of zero', ctx(BE));
    expect(t.boarding_pass_verified).toBe(true);
    expect(t.boarding_pass_flag).toBeNull();
  });
});

describe('Backend — tags', () => {
  function verifyFlight(code) {
    for (const r of be.dataRows(state)) if (r.flight === code && r.match.status === 'matched') be.matchAndVerify(state, r.traveler.id, ctx(BE));
  }
  it('CSV import rejects the bad-format and duplicate rows, keeps the leading-zero LPN as text, saves a batch', () => {
    const sv = tags.importTagBatch(state, { csv: csv('sv'), fileName: 'SV1821_tags.csv' }, ctx(BE));
    expect(sv).toMatchObject({ rows_ok: 8, rows_rejected: 1, status: 'Partial', imported_by: 'BE-001' });
    expect(sv.rejected_rows[0]).toMatchObject({ lpn: '12345', code: 'INVALID_FORMAT' });
    const first = state.bagTags.find((t) => t.lpn === '0650012345');
    expect(first).toBeTruthy();
    expect(typeof first.lpn).toBe('string');
    expect(first).toMatchObject({ issuer_code: '065', serial: '001234', status: 'Imported', traveler_id: 'TRV-2000000001', tag_type: 'IATA_LPN' });
    const ga = tags.importTagBatch(state, { csv: csv('ga') }, ctx(BE));
    expect(ga).toMatchObject({ rows_ok: 7, rows_rejected: 1 });
    expect(ga.rejected_rows[0].code).toBe('DUPLICATE');
    expect(state.tagImportBatches).toHaveLength(2);
  });
  it('rejects unknown flights, wrong issuer, wrong header, and non-Backend users', () => {
    const b = tags.importTagBatch(state, { csv: 'booking_ref,flight,lpn\nX,ZZ 1,0650012345\nX,SV 1821,1260012345' }, ctx(BE));
    expect(b.rejected_rows.map((r) => r.code)).toEqual(['FLIGHT_NOT_FOUND', 'WRONG_ISSUER']);
    expect(() => tags.importTagBatch(state, { csv: 'a,b\n1,2' }, ctx(BE))).toThrowError(/columns/);
    expect(() => tags.importTagBatch(state, { csv: csv('sv') }, ctx(CHK))).toThrow(PermissionError);
    expect(() => tags.importTagBatch(state, { csv: csv('sv') }, ctx(OPS))).toThrow(PermissionError);
  });
  it('assign + release: LPNs go to the right travelers, bags Data Verified → Tag Assigned, tags Released', () => {
    verifyFlight('SV 1821');
    tags.importTagBatch(state, { csv: csv('sv') }, ctx(BE));
    expect(tags.assignTags(state, 'SV 1821', ctx(BE))).toEqual({ assigned: 6, shortage: 0 });
    const t1 = trav('2000000001');
    expect(state.bags.filter((b) => b.traveler_id === t1.id).map((b) => b.airline_tag_no).sort()).toEqual(['0650012345', '0650012346']);
    expect(state.bagTags.filter((t) => t.status === 'Assigned' && t.tag_type === 'IATA_LPN')).toHaveLength(6);
    expect(be.dashboardTiles(state).tags_to_release).toBe(6);
    expect(tags.releaseTags(state, 'SV 1821', ctx(BE))).toEqual({ released: 6 });
    expect(state.bags.filter((b) => b.flight_id === 'FLT-SV-1821' && b.airline_tag_no).every((b) => b.status === 'Tag Assigned')).toBe(true);
    expect(state.bagTags.filter((t) => t.status === 'Released' && t.tag_type === 'IATA_LPN')).toHaveLength(6);
    expect(be.dashboardTiles(state).tags_to_release).toBe(0);
  });
  it('shortage is reported when there are fewer tags than bags', () => {
    verifyFlight('PK 760');
    tags.importTagBatch(state, { csv: 'booking_ref,flight,lpn\nPKT9S1,PK 760,2140030001' }, ctx(BE));
    expect(tags.assignTags(state, 'PK 760', ctx(BE))).toEqual({ assigned: 1, shortage: 1 }); // 2 verified PK bags (one booked traveler), 1 tag in the file
  });
  it('a flight with no airline tag list runs on internal tags only, is flagged, and Ops is notified', () => {
    for (const r of be.dataRows(state)) if (r.flight === 'GA 7005') { /* GA 7005 travelers have no booking yet */ }
    const t = trav('2000000013');
    const slot = tv.availableSlots(state, t.id, { now: NOW })[0];
    tv.bookCollection(state, t.id, { bags: 2, slotId: slot.id }, { now: NOW });
    // 2000000013 is missing from airline data → cannot be matched; use a Nusuk+airline traveler on the same flight
    const t2 = trav('2000000014');
    be.mapResidence(state, t2.id, 'AREA-AL-AWALI', ctx(BE));
    const slot2 = tv.availableSlots(state, t2.id, { now: NOW })[0];
    tv.bookCollection(state, t2.id, { bags: 2, slotId: slot2.id }, { now: NOW });
    be.matchAndVerify(state, t2.id, ctx(BE));
    const r = tags.issueInternalOnly(state, 'GA 7005', ctx(BE));
    expect(r.issued).toBe(2);
    const bags = state.bags.filter((b) => b.traveler_id === t2.id);
    expect(bags.every((b) => b.status === 'Tag Assigned' && b.tag_no && !b.airline_tag_no)).toBe(true);
    expect(state.flights.find((f) => f.id === 'FLT-GA-7005').no_airline_tag).toBe(true);
    expect(state.notifications.some((n) => /No airline tags/.test(n.title))).toBe(true);
    // but not for a flight that has an airline list
    tags.importTagBatch(state, { csv: csv('sv') }, ctx(BE));
    expect(() => tags.issueInternalOnly(state, 'SV 1821', ctx(BE))).toThrowError(/airline tag list/);
  });
  it('damaged tag: void the LPN, assign a spare from the SAME batch, release it', () => {
    verifyFlight('SV 1821');
    tags.importTagBatch(state, { csv: csv('sv') }, ctx(BE));
    tags.assignTags(state, 'SV 1821', ctx(BE));
    tags.releaseTags(state, 'SV 1821', ctx(BE));
    const old = state.bagTags.find((t) => t.lpn === '0650012345');
    const bagId = old.bag_id;
    expect(() => tags.voidAndReplace(state, old.id, '', ctx(BE))).toThrowError(/reason/);
    const { replacement } = tags.voidAndReplace(state, old.id, 'Torn at the handle', ctx(BE));
    expect(old).toMatchObject({ status: 'Void', void_reason: 'Torn at the handle' });
    expect(replacement).toMatchObject({ status: 'Released', bag_id: bagId, batch_id: old.batch_id });
    expect(state.bags.find((b) => b.id === bagId).airline_tag_no).toBe(replacement.lpn);
    expect(['0650012351', '0650012352']).toContain(replacement.lpn);
  });
  it('label sheet lists internal labels per collection area', () => {
    verifyFlight('SV 1821');
    const rows = tags.labelSheet(state, { areaId: 'AREA-AZIZIYAH' }, ctx(BE));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => /^RBL-D-\d{6}$/.test(r.tag_no))).toBe(true);
  });
});

describe('Backend — manifest', () => {
  function toSgs(flightId) {
    // walk every bag of the flight to "SGS Voucher Accepted" with the system actor (later phases do this per role)
    return import('../../shared/services/bagService.js').then(({ advanceBag }) => {
      for (const b of state.bags.filter((x) => x.flight_id === flightId)) {
        b.weight_kg = 20; b.meets_airline_criteria = true; b.tag_verified = true;
        while (b.status !== 'SGS Voucher Accepted') {
          const next = ['Declared', 'Data Verified', 'Tag Assigned', 'Checked-in', 'Loaded to Collection Truck', 'Received at Warehouse', 'Screened', 'Loaded to Airport Truck', 'In Transit to Airport', 'Received at Airport', 'Handed to Airport Authority', 'SGS Voucher Accepted'];
          if (!b.tag_no) b.tag_no = `RBL-D-9${b.id.slice(-5)}`;
          advanceBag(state, b.id, next[next.indexOf(b.status) + 1], { system: true, countMatch: true, voucherCountMatch: true });
        }
      }
    });
  }
  it('confirm loaded: manifest matches → Loaded on Aircraft; a gap blocks it and "Notify Ops" raises a Manifest Gap', async () => {
    for (const r of be.dataRows(state)) if (r.flight === 'SV 1821' && r.match.status === 'matched') be.matchAndVerify(state, r.traveler.id, ctx(BE));
    tags.importTagBatch(state, { csv: csv('sv') }, ctx(BE));
    tags.assignTags(state, 'SV 1821', ctx(BE));
    await toSgs('FLT-SV-1821');
    const s = be.manifestStatus(state, 'SV 1821');
    expect(s).toMatchObject({ feed: 'Connected', at_sgs: 6, gap: 0 });
    state.simulated = { manifestDrops: { 'FLT-SV-1821': ['0650012345'] } };
    const gap = be.manifestStatus(state, 'SV 1821');
    expect(gap.gap).toBe(1);
    expect(be.dashboardTiles(state).manifest_gaps).toBe(1);
    expect(() => be.confirmLoaded(state, 'SV 1821', {}, ctx(BE))).toThrowError(/missing from the airline manifest/);
    expect(be.notifyOpsManifestGap(state, 'SV 1821', ctx(BE)).type).toBe('Manifest Gap');
    state.simulated.manifestDrops = {};
    expect(be.confirmLoaded(state, 'SV 1821', {}, ctx(BE))).toEqual({ loaded: 6, manual: false });
    expect(state.bags.filter((b) => b.flight_id === 'FLT-SV-1821').every((b) => b.status === 'Loaded on Aircraft')).toBe(true);
  });
  it('no airline feed (PK): manual confirm is allowed only with a reason', async () => {
    for (const r of be.dataRows(state)) if (r.flight === 'PK 760' && r.match.status === 'matched') be.matchAndVerify(state, r.traveler.id, ctx(BE));
    await toSgs('FLT-PK-760');
    expect(be.manifestStatus(state, 'PK 760').no_feed).toBe(true);
    expect(() => be.confirmLoaded(state, 'PK 760', {}, ctx(BE))).toThrowError(/No airline feed/);
    const r = be.confirmLoaded(state, 'PK 760', { manualReason: 'Airline desk confirmed by phone' }, ctx(BE));
    expect(r.manual).toBe(true);
    expect(state.auditLog.at(-1).note).toMatch(/phone/);
  });
});

describe('seed on top of imported pre-v7 data (regression)', () => {
  const mem = () => {
    const m = new Map([['rabel_ui_checkin-staff', JSON.stringify({
      __v: 1, centres: [], staff: [], appointments: [], checkinSessions: [], carts: [],
      flights: [{ code: 'SV 1821' }, { code: 'GA 981' }],
      // a legacy traveler that happens to share a passport with a v7 traveler
      nusukRecords: [{ nusukId: 'NSK1', name: 'Legacy Person', passportNo: 'BX0987654', flightCode: 'GA 981' }],
      bags: [{ id: 'LEG-1', flightCode: 'SV 1821', tagNumber: 'RBTAG-1', weightKg: 18, status: 'Tagged' }],
    })]]);
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
  };

  it('upgrades legacy flights with a cut-off, never attaches airline data to legacy travelers, hides legacy rows from Backend', () => {
    const s = createStore({ storage: mem(), baseAccounts: true }).get();
    for (const id of ['FLT-SV-1821', 'FLT-GA-981']) expect(s.flights.find((f) => f.id === id).cut_off_at).toBeTruthy();
    const legacy = s.travelers.find((t) => t.id === 'TRV-NSK1');
    expect(legacy.airline).toBeFalsy();
    expect(s.travelers.find((t) => t.id === 'TRV-2000000004').airline).toBeTruthy();
    expect(s.travelers.filter((t) => t.passport === 'BX0987654')).toHaveLength(2);
    expect(be.dataRows(s).some((r) => r.traveler.id === 'TRV-NSK1')).toBe(false);
    expect(be.dashboardTiles(s)).toMatchObject({ unmapped_addresses: 1, boarding_passes_unverified: 2 });
    // legacy bag keeps its (migrated) status and never shows in manifest numbers
    expect(s.bags.find((b) => b.id === 'LEG-1').status).toBe('Checked-in');
    expect(be.manifestStatus(s, 'SV 1821').total).toBe(s.bags.filter((b) => b.flight_id === 'FLT-SV-1821' && !b.legacy).length);
    // login by Nusuk ID + passport picks the v7 traveler, not the legacy one
    expect(tv.findTravelerForLogin(s, '2000000004', 'BX0987654').id).toBe('TRV-2000000004');
  });
});

describe('seed invariants', () => {
  it('the seeded demo holds every invariant the seed script checks', () => {
    const s = createStore({ storage: null, baseAccounts: false }).get();
    seedDeparture(s, { now: NOW });
    expect(validateState(s)).toEqual([]);
    const sum = summarise(s);
    expect(sum.flights).toBe(5);
    expect(sum.areas).toBe(3);
    expect(sum.bags).toBe(16); // the cancelled flight's 8 + 2 each for the 4 pre-booked collections
    expect(sum.bagsByStatus['Received at Warehouse']).toBe(8);
  });

  it('re-running the seed changes nothing (it is an upsert, not an insert)', () => {
    const s = createStore({ storage: null, baseAccounts: false }).get();
    seedDeparture(s, { now: NOW });
    const before = summarise(s);
    seedDeparture(s, { now: NOW });
    expect(summarise(s)).toEqual(before);
    expect(validateState(s)).toEqual([]);
  });

  it('catches the mistakes it is there to catch', () => {
    const s = createStore({ storage: null, baseAccounts: false }).get();
    seedDeparture(s, { now: NOW });

    s.bags[0].status = 'Teleported';
    s.bags[1].airline_tag_no = 1260020001; // a number, not a string — leading zeros would be lost
    s.bags[2].flight_id = 'FLT-NOPE';
    s.collectionSlots[0].booked_count = 999;
    const problems = validateState(s);
    expect(problems.join('\n')).toMatch(/unknown status "Teleported"/);
    expect(problems.join('\n')).toMatch(/airline tag must stay a string/);
    expect(problems.join('\n')).toMatch(/unknown flight FLT-NOPE/);
    expect(problems.join('\n')).toMatch(/999 booked into/);
  });
});
