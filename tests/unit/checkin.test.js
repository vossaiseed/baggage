import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from '../../shared/store.js';
import { seedDeparture, SAMPLE_TAG_FILES } from '../../shared/seed/departure.js';
import * as tags from '../../shared/services/tagService.js';
import * as be from '../../shared/services/backendService.js';
import * as tv from '../../shared/services/travelerService.js';
import * as ck from '../../shared/services/checkinService.js';
import { recordScan } from '../../shared/services/scanService.js';
import { createReadFilter, inferSymbology, symbologyFromFormat } from '../../shared/scan/readFilter.js';
import { PermissionError } from '../../shared/rbac.js';
import { ServiceError } from '../../shared/services/errors.js';

const NOW = new Date('2026-06-01T06:00:00Z').getTime();
let s; let BE; let CHK1; let CHK2;
const ctx = (user) => ({ user, now: NOW });
const trav = (nid) => s.travelers.find((t) => t.nusuk_id === nid);
const csv = (id) => SAMPLE_TAG_FILES.find((f) => f.id === id).csv;
const asg = (nid) => s.collectionAssignments.find((a) => a.traveler_id === trav(nid).id);
const bagsOf = (nid) => s.bags.filter((b) => b.traveler_id === trav(nid).id && !b.withdrawn).sort((a, b) => a.id.localeCompare(b.id));
const hand = (value, method = 'HANDHELD', symbology) => ({ value, method, symbology, device_id: 'DEV-TEST' });

/** Backend prepares a flight: verify its matched travelers, import tags, assign, release. */
function prepare(code, file) {
  for (const r of be.dataRows(s)) if (r.flight === code && r.match.status === 'matched' && !r.traveler.data_verified) be.matchAndVerify(s, r.traveler.id, ctx(BE));
  tags.importTagBatch(s, { csv: csv(file) }, ctx(BE));
  tags.assignTags(s, code, ctx(BE));
  tags.releaseTags(s, code, ctx(BE));
}
/** Book Ahmad (GA 981) so we have a GA collection. */
function bookAhmad(bags = 2) {
  const t = trav('2000000004');
  const slot = tv.availableSlots(s, t.id, { now: NOW })[0];
  return tv.bookCollection(s, t.id, { bags, slotId: slot.id }, { now: NOW }).assignment;
}
/** Walk an assignment to "Arrived + identity verified". */
function arrive(a, user, last4) {
  ck.startRoute(s, a.id, {}, ctx(user));
  ck.markArrived(s, a.id, { gps: { lat: 21.4, lng: 39.8 } }, ctx(user));
  ck.confirmIdentity(s, a.id, { last4: last4 ?? s.travelers.find((t) => t.id === a.traveler_id).passport.slice(-4), photoOk: true }, ctx(user));
}
/** Weigh all + scan airline tag & internal label for every bag. */
function weighAndTag(a, user, kg = 20) {
  const bags = ck.activeBags(s, a);
  ck.recordWeights(s, a.id, Object.fromEntries(bags.map((b) => [b.id, kg])), ctx(user));
  for (const b of bags) {
    if (b.airline_tag_no) expect(ck.scanTag(s, a.id, b.id, 'AIRLINE', hand(b.airline_tag_no, 'HANDHELD', 'ITF'), ctx(user)).ok).toBe(true);
    expect(ck.scanTag(s, a.id, b.id, 'INTERNAL', hand(b.tag_no, 'HANDHELD', 'CODE128'), ctx(user)).ok).toBe(true);
  }
}

beforeEach(() => {
  s = createStore({ storage: null, baseAccounts: false }).get();
  seedDeparture(s, { now: NOW });
  BE = s.users.find((u) => u.id === 'BE-001');
  CHK1 = s.users.find((u) => u.id === 'CHK-001'); // Aziziyah
  CHK2 = s.users.find((u) => u.id === 'CHK-002'); // Al-Awali
});

describe('assignment list', () => {
  it('shows only my area, grouped by slot, with P-rank, boarding pass, address and a maps link', () => {
    const groups = ck.listAssignments(s, CHK1, { now: NOW });
    const items = groups.flatMap((g) => g.items);
    expect(items.map((i) => i.traveler.nusuk_id).sort()).toEqual(['2000000001', '2000000007']); // Siti (SV), Rizwan (PK) — Aziziyah
    const siti = items.find((i) => i.traveler.nusuk_id === '2000000001');
    expect(siti).toMatchObject({ priority: 1, boardingPass: 'Verified', bags: expect.any(Array) });
    expect(siti.bags).toHaveLength(2);
    expect(siti.mapsUrl).toMatch(/maps\?q=21\.42/);
    expect(items.find((i) => i.traveler.nusuk_id === '2000000007').priority).toBe(3);
    expect(ck.listAssignments(s, CHK2, { now: NOW }).flatMap((g) => g.items).map((i) => i.traveler.nusuk_id)).toEqual(['2000000002']);
  });
  it('sorts by flight priority within a slot and groups slots by time', () => {
    const t7 = asg('2000000007');
    const t1 = asg('2000000001');
    // force both into the same slot: P1 (SV 1821) must come before P3 (PK 760)
    t7.slot_id = t1.slot_id;
    const g = ck.listAssignments(s, CHK1, { now: NOW });
    expect(g).toHaveLength(1);
    expect(g[0].items.map((i) => i.priority)).toEqual([1, 3]);
  });
  it('released tags ready are shown per traveler', () => {
    prepare('SV 1821', 'sv');
    const item = ck.listAssignments(s, CHK1, { now: NOW }).flatMap((g) => g.items).find((i) => i.traveler.nusuk_id === '2000000001');
    expect(item.releasedTags).toBe(2);
  });
  it('nearest-neighbour route order', () => {
    const ord = ck.routeOrder({ lat: 0, lng: 0 }, [{ id: 'far', lat: 0, lng: 0.3 }, { id: 'near', lat: 0, lng: 0.05 }, { id: 'mid', lat: 0, lng: 0.15 }, { id: 'nopos' }]);
    expect(ord).toEqual(['near', 'mid', 'far', 'nopos']);
  });
  it('RBAC: a Check-in Staff cannot touch another area’s assignment', () => {
    expect(() => ck.startRoute(s, asg('2000000001').id, {}, ctx(CHK2))).toThrow(PermissionError);
  });
});

describe('route → arrived → identity', () => {
  it('start route sets En Route + ETA, notifies the traveler; arrived captures GPS; order is enforced', () => {
    const a = asg('2000000001');
    expect(() => ck.markArrived(s, a.id, {}, ctx(CHK1))).toThrowError(/Start the route/);
    ck.startRoute(s, a.id, { etaMinutes: 15 }, ctx(CHK1));
    expect(a).toMatchObject({ status: 'En Route', route_order: 1, check_in_staff_id: 'CHK-001' });
    expect(new Date(a.eta).getTime() - NOW).toBe(15 * 60e3);
    expect(s.notifications.some((n) => n.traveler_id === a.traveler_id && /on the way/.test(n.title))).toBe(true);
    expect(tv.trackingFor(s, a.traveler_id).collector).toMatchObject({ name: 'Omar' });
    ck.markArrived(s, a.id, { gps: { lat: 21.4231, lng: 39.8742, accuracy: 8 } }, ctx(CHK1));
    expect(a).toMatchObject({ status: 'Arrived', gps: { lat: 21.4231, lng: 39.8742 } });
    expect(a.arrived_at).toBeTruthy();
  });
  it('identity: verified-by-Backend → ok; wrong last 4 / no photo refused; 3 wrong attempts raise Data Mismatch', () => {
    be.matchAndVerify(s, trav('2000000001').id, ctx(BE));
    const a = asg('2000000001');
    ck.startRoute(s, a.id, {}, ctx(CHK1)); ck.markArrived(s, a.id, {}, ctx(CHK1));
    expect(() => ck.confirmIdentity(s, a.id, { last4: '4567', photoOk: false }, ctx(CHK1))).toThrowError(/photo/);
    for (let i = 0; i < 2; i++) expect(() => ck.confirmIdentity(s, a.id, { last4: '0000', photoOk: true }, ctx(CHK1))).toThrowError(/do not match/);
    expect(s.exceptions.some((e) => e.type === 'Data Mismatch')).toBe(false);
    expect(() => ck.confirmIdentity(s, a.id, { last4: '0000', photoOk: true }, ctx(CHK1))).toThrowError(/do not match/);
    expect(s.exceptions.some((e) => e.type === 'Data Mismatch' && e.assignment_id === a.id)).toBe(true);
    ck.confirmIdentity(s, a.id, { last4: '4567', photoOk: true }, ctx(CHK1));
    expect(a.identity.verified).toBe(true);
  });
  it('not verified by Backend → "call supervisor" and STOP; Ops is notified; nothing else works', () => {
    const a = asg('2000000001');
    ck.startRoute(s, a.id, {}, ctx(CHK1)); ck.markArrived(s, a.id, {}, ctx(CHK1));
    expect(() => ck.confirmIdentity(s, a.id, { last4: '4567', photoOk: true }, ctx(CHK1))).toThrowError(/call your supervisor/i);
    expect(a.supervisor_called).toBe(true);
    expect(s.notifications.some((n) => n.roles.includes('ops_manager') && /Supervisor needed/.test(n.title))).toBe(true);
    expect(() => ck.recordWeights(s, a.id, {}, ctx(CHK1))).toThrowError(/identity/);
  });
});

describe('traveler absent', () => {
  it('marks Traveler Absent, raises the exception, tells the traveler, and the staff can offer a new slot in the window', () => {
    const a = asg('2000000003'); // Fatima, SV 1821 (Shisha) — the demo absentee
    const chk3 = s.users.find((u) => u.id === 'CHK-003');
    expect(a.demo_absent).toBe(true);
    ck.startRoute(s, a.id, {}, ctx(chk3));
    const r = ck.markAbsent(s, a.id, ctx(chk3));
    expect(a.status).toBe('Traveler Absent');
    expect(s.exceptions.some((e) => e.type === 'Traveler Absent' && e.assignment_id === a.id)).toBe(true);
    expect(tv.trackingFor(s, a.traveler_id).banners.map((b) => b.kind)).toContain('absent');
    if (r.rescheduleOffered) {
      const slot = r.slots[0];
      ck.offerSlot(s, a.id, slot.id, ctx(chk3));
      expect(a).toMatchObject({ status: 'Rescheduled', slot_id: slot.id });
      expect(s.notifications.some((n) => n.traveler_id === a.traveler_id && /rescheduled/i.test(n.title))).toBe(true);
    }
    expect(r.opsNotified).toBe(!r.rescheduleOffered);
  });
  it('window closing (no slot left) → Ops is notified instead', () => {
    const a = asg('2000000001');
    ck.startRoute(s, a.id, {}, ctx(CHK1));
    for (const sl of s.collectionSlots) sl.booked_count = sl.capacity_travelers;
    const r = ck.markAbsent(s, a.id, ctx(CHK1));
    expect(r).toMatchObject({ rescheduleOffered: false, opsNotified: true });
    expect(s.notifications.some((n) => n.roles.includes('ops_manager') && /Window closing/.test(n.title))).toBe(true);
  });
  it('only a collection in progress can be marked absent', () => {
    expect(() => ck.markAbsent(s, asg('2000000001').id, ctx(CHK1))).toThrow(ServiceError);
  });
});

describe('weigh — airline criteria per row', () => {
  it('GA 21 kg is rejected (max 20), SV 21 kg is accepted (max 23); only the heavy row says "repack"', () => {
    prepare('GA 981', 'ga'); prepare('SV 1821', 'sv');
    const ga = bookAhmad(2);
    arrive(ga, CHK1);
    const gaBags = ck.activeBags(s, ga);
    const rows = ck.recordWeights(s, ga.id, { [gaBags[0].id]: 21, [gaBags[1].id]: 19.5 }, ctx(CHK1));
    expect(rows).toEqual([
      { bag_id: gaBags[0].id, weight_kg: 21, meets: false, max: 20, repack: true },
      { bag_id: gaBags[1].id, weight_kg: 19.5, meets: true, max: 20, repack: false },
    ]);
    const sv = asg('2000000001');
    arrive(sv, CHK1);
    const [b1] = ck.activeBags(s, sv);
    expect(ck.recordWeights(s, sv.id, { [b1.id]: 21 }, ctx(CHK1))[0]).toMatchObject({ meets: true, max: 23, repack: false });
  });
  it('repack: re-weighing a bag under the limit clears the block', () => {
    prepare('GA 981', 'ga');
    const a = bookAhmad(1); arrive(a, CHK1);
    const [b] = ck.activeBags(s, a);
    ck.recordWeights(s, a.id, { [b.id]: 22 }, ctx(CHK1));
    expect(ck.countMatch(s, a.id).blockers.join()).toMatch(/repacking/);
    ck.recordWeights(s, a.id, { [b.id]: 18 }, ctx(CHK1));
    expect(b.meets_airline_criteria).toBe(true);
  });
  it('rejects nonsense weights', () => {
    prepare('SV 1821', 'sv'); const a = asg('2000000001'); arrive(a, CHK1);
    const [b] = ck.activeBags(s, a);
    for (const w of [0, -1, 'abc', 61]) expect(() => ck.recordWeights(s, a.id, { [b.id]: w }, ctx(CHK1))).toThrowError(/weight/i);
  });
});

describe('attach & scan tags', () => {
  it('a wrong-flight tag is BLOCKED, logged with its method, and raises Wrong Flight Tag', () => {
    prepare('SV 1821', 'sv'); prepare('GA 981', 'ga');
    const a = asg('2000000001'); arrive(a, CHK1);
    const [b] = ck.activeBags(s, a);
    const gaTag = s.bagTags.find((t) => t.lpn === '1260020001');
    const r = ck.scanTag(s, a.id, b.id, 'AIRLINE', hand(gaTag.lpn, 'CAMERA', 'ITF'), ctx(CHK1));
    expect(r).toMatchObject({ ok: false, result: 'WRONG_FLIGHT' });
    expect(r.message).toMatch(/different flight/);
    expect(r.exception.type).toBe('Wrong Flight Tag');
    expect(b.airline_scanned).toBeFalsy();
    expect(s.scanEvents.at(-1)).toMatchObject({ step: 'RESIDENCE_AIRLINE_TAG', method: 'CAMERA', symbology: 'ITF', result: 'WRONG_FLIGHT', raw_value: '1260020001', bag_id: b.id });
  });
  it('exact errors: invalid format, duplicate, not released, unknown', () => {
    prepare('SV 1821', 'sv');
    const a = asg('2000000001'); arrive(a, CHK1);
    const [b1, b2] = ck.activeBags(s, a);
    expect(ck.scanTag(s, a.id, b1.id, 'AIRLINE', hand('12345', 'MANUAL'), ctx(CHK1))).toMatchObject({ ok: false, result: 'INVALID_FORMAT', code: 'INVALID_FORMAT' });
    expect(ck.scanTag(s, a.id, b1.id, 'AIRLINE', hand('0659999999'), ctx(CHK1))).toMatchObject({ ok: false, result: 'UNKNOWN' });
    // spare tag from the same file is Imported (not released)
    expect(ck.scanTag(s, a.id, b1.id, 'AIRLINE', hand('0650012351'), ctx(CHK1))).toMatchObject({ ok: false, result: 'WRONG_STEP', code: 'NOT_RELEASED' });
    expect(s.exceptions.some((e) => e.type === 'Tag Not Released')).toBe(true);
    expect(ck.scanTag(s, a.id, b1.id, 'AIRLINE', hand(b1.airline_tag_no), ctx(CHK1)).ok).toBe(true);
    // scanning the same tag onto the other bag again → duplicate
    expect(ck.scanTag(s, a.id, b2.id, 'AIRLINE', hand(b1.airline_tag_no), ctx(CHK1))).toMatchObject({ ok: false, result: 'DUPLICATE' });
    expect(s.exceptions.some((e) => e.type === 'Duplicate Tag')).toBe(true);
    expect(s.exceptions.some((e) => e.type === 'Invalid Tag Format')).toBe(true);
  });
  it('binds tag + label to the bag being processed, swapping with the other bag when needed (no duplicates)', () => {
    prepare('SV 1821', 'sv');
    const a = asg('2000000001'); arrive(a, CHK1);
    const [b1, b2] = ck.activeBags(s, a);
    const t2 = b2.airline_tag_no; const l2 = b2.tag_no; const t1 = b1.airline_tag_no; const l1 = b1.tag_no;
    ck.scanTag(s, a.id, b1.id, 'AIRLINE', hand(t2), ctx(CHK1)); // row 1 gets bag 2's tag → swap
    ck.scanTag(s, a.id, b1.id, 'INTERNAL', hand(l2), ctx(CHK1));
    expect([b1.airline_tag_no, b1.tag_no, b2.airline_tag_no, b2.tag_no]).toEqual([t2, l2, t1, l1]);
    expect(b1.tag_verified).toBe(true);
    expect(s.bagTags.find((t) => t.lpn === t2).bag_id).toBe(b1.id);
    expect(s.bagTags.find((t) => t.tag_type === 'INTERNAL' && t.tag_no === l2).bag_id).toBe(b1.id);
    expect(ck.scanTag(s, a.id, b2.id, 'INTERNAL', hand(l2), ctx(CHK1))).toMatchObject({ ok: false, result: 'DUPLICATE' });
  });
  it('another traveler’s label is refused; a non-Rabel code is unknown', () => {
    prepare('SV 1821', 'sv');
    const a = asg('2000000001'); arrive(a, CHK1);
    const [b] = ck.activeBags(s, a);
    const other = bagsOf('2000000002')[0];
    other.tag_no ||= 'RBL-D-999999';
    expect(ck.scanTag(s, a.id, b.id, 'INTERNAL', hand(other.tag_no), ctx(CHK1)).message).toMatch(/another traveler/);
    expect(ck.scanTag(s, a.id, b.id, 'INTERNAL', hand('HELLO'), ctx(CHK1)).message).toMatch(/not a Rabel label/);
  });
  it('bags that Backend has not released yet cannot be scanned', () => {
    const a = asg('2000000001'); arrive_unverified(a);
    function arrive_unverified(x) { be.matchAndVerify(s, trav('2000000001').id, ctx(BE)); arrive(x, CHK1); }
    const [b] = ck.activeBags(s, a);
    expect(ck.scanTag(s, a.id, b.id, 'INTERNAL', hand('RBL-D-000001'), ctx(CHK1))).toMatchObject({ ok: false, code: 'NOT_RELEASED' });
  });
  it('a flight with no airline tags runs on the internal label only', () => {
    const t = trav('2000000014'); // GA 7005: no airline list
    be.mapResidence(s, t.id, 'AREA-AL-AWALI', ctx(BE));
    const slot = tv.availableSlots(s, t.id, { now: NOW })[0];
    const a = tv.bookCollection(s, t.id, { bags: 1, slotId: slot.id }, { now: NOW }).assignment;
    be.matchAndVerify(s, t.id, ctx(BE));
    tags.issueInternalOnly(s, 'GA 7005', ctx(BE));
    arrive(a, CHK2);
    const [b] = ck.activeBags(s, a);
    expect(ck.needsAirlineScan(b)).toBe(false);
    expect(ck.scanTag(s, a.id, b.id, 'AIRLINE', hand('1260020001'), ctx(CHK2))).toMatchObject({ ok: false, code: 'NO_AIRLINE_TAG' });
    ck.recordWeights(s, a.id, { [b.id]: 15 }, ctx(CHK2));
    expect(ck.scanTag(s, a.id, b.id, 'INTERNAL', hand(b.tag_no), ctx(CHK2)).ok).toBe(true);
    expect(b.tag_verified).toBe(true);
    expect(ck.countMatch(s, a.id).ok).toBe(true);
  });
  it('damaged tag → request to Backend → void & replace closes the request', () => {
    prepare('SV 1821', 'sv');
    const a = asg('2000000001'); arrive(a, CHK1);
    const [b] = ck.activeBags(s, a);
    const old = b.airline_tag_no;
    const exc = ck.requestDamagedTag(s, b.id, 'Torn handle', ctx(CHK1));
    expect(exc).toMatchObject({ type: 'Damaged Tag', status: 'Open', value: old });
    expect(s.notifications.some((n) => n.roles.includes('backend') && /Replacement tag/.test(n.title))).toBe(true);
    const { replacement } = tags.voidAndReplace(s, exc.tag_id, 'Torn handle', ctx(BE));
    expect(s.exceptions.find((e) => e.id === exc.id).status).toBe('Resolved');
    expect(b.airline_tag_no).toBe(replacement.lpn);
    expect(ck.scanTag(s, a.id, b.id, 'AIRLINE', hand(replacement.lpn), ctx(CHK1)).ok).toBe(true);
  });
});

describe('count match → complete → receipt → hand to transport', () => {
  it('the button logic stays blocked until declared = weighed = tags scanned', () => {
    prepare('SV 1821', 'sv');
    const a = asg('2000000001'); arrive(a, CHK1);
    expect(ck.countMatch(s, a.id)).toMatchObject({ declared: 2, weighed: 0, tagged: 0, ok: false });
    expect(() => ck.completeCheckin(s, a.id, ctx(CHK1))).toThrowError(/not weighed/);
    const [b1, b2] = ck.activeBags(s, a);
    ck.recordWeights(s, a.id, { [b1.id]: 20, [b2.id]: 20 }, ctx(CHK1));
    ck.scanTag(s, a.id, b1.id, 'AIRLINE', hand(b1.airline_tag_no), ctx(CHK1));
    ck.scanTag(s, a.id, b1.id, 'INTERNAL', hand(b1.tag_no), ctx(CHK1));
    expect(ck.countMatch(s, a.id)).toMatchObject({ weighed: 2, tagged: 1, ok: false });
    expect(() => ck.completeCheckin(s, a.id, ctx(CHK1))).toThrowError(/without tags scanned/);
    ck.scanTag(s, a.id, b2.id, 'AIRLINE', hand(b2.airline_tag_no), ctx(CHK1));
    ck.scanTag(s, a.id, b2.id, 'INTERNAL', hand(b2.tag_no), ctx(CHK1));
    expect(ck.countMatch(s, a.id)).toMatchObject({ declared: 2, weighed: 2, tagged: 2, ok: true, blockers: [] });
  });
  it('complete check-in → every bag Checked-in via advanceBag, tags Scanned, receipt + SMS, assignment Collected; then hand-off', () => {
    prepare('SV 1821', 'sv');
    const a = asg('2000000001'); arrive(a, CHK1); weighAndTag(a, CHK1, 21);
    ck.completeCheckin(s, a.id, ctx(CHK1));
    expect(a.status).toBe('Collected');
    expect(ck.activeBags(s, a).every((b) => b.status === 'Checked-in' && b.status_history.at(-1).role === 'checkin')).toBe(true);
    expect(s.bagTags.filter((t) => t.status === 'Scanned' && t.tag_type === 'IATA_LPN' && t.flight_id === 'FLT-SV-1821')).toHaveLength(2);
    expect(a.receipt.bags.map((x) => x.airline_tag_no).sort()).toEqual(['0650012345', '0650012346']);
    const tr = tv.trackingFor(s, a.traveler_id);
    expect(tr.receipt.bags).toHaveLength(2);
    expect(s.notifications.some((n) => n.channel === 'sms' && /checked in/.test(n.body) && /0650012345/.test(n.body))).toBe(true);
    const area = s.collectionAreas.find((x) => x.id === 'AREA-AZIZIYAH');
    const before = area.pending_pickups || 0;
    const h = ck.handToTransport(s, a.id, ctx(CHK1));
    expect(h.bags).toBe(2);
    expect(a.status).toBe('Handed to Transport');
    expect(area.pending_pickups).toBe(before + 2);
    expect(() => ck.handToTransport(s, a.id, ctx(CHK1))).toThrowError(/Complete check-in/);
    // a later seed run recomputes pending pickups from the data (never double counts)
    seedDeparture(s, { now: NOW });
    expect(area.pending_pickups).toBe(2);
  });
  it('a repack-required bag blocks completion until fixed', () => {
    const a = bookAhmad(2);
    prepare('GA 981', 'ga');
    arrive(a, CHK1);
    const bags = ck.activeBags(s, a);
    ck.recordWeights(s, a.id, { [bags[0].id]: 21, [bags[1].id]: 19 }, ctx(CHK1));
    for (const b of bags) { ck.scanTag(s, a.id, b.id, 'AIRLINE', hand(b.airline_tag_no), ctx(CHK1)); ck.scanTag(s, a.id, b.id, 'INTERNAL', hand(b.tag_no), ctx(CHK1)); }
    expect(() => ck.completeCheckin(s, a.id, ctx(CHK1))).toThrowError(/repacking/);
    ck.recordWeights(s, a.id, { [bags[0].id]: 19.9 }, ctx(CHK1));
    ck.completeCheckin(s, a.id, ctx(CHK1));
    expect(bags.every((b) => b.status === 'Checked-in')).toBe(true);
  });
});

describe('bag count vs allowance', () => {
  it('fewer bags presented → the missing ones are left out + Count Mismatch', () => {
    prepare('SV 1821', 'sv');
    const a = asg('2000000001'); arrive(a, CHK1);
    const r = ck.checkBagCount(s, a.id, { presented: 1 }, ctx(CHK1));
    expect(r).toMatchObject({ outcome: 'fewer', withdrawn: 1 });
    expect(ck.activeBags(s, a)).toHaveLength(1);
    expect(a.bags_declared).toBe(1);
    expect(s.exceptions.some((e) => e.type === 'Count Mismatch')).toBe(true);
  });
  it('more than declared but within the airline’s extra limit → extra bag declared + tag request to Backend → Backend issues it', () => {
    prepare('SV 1821', 'sv');
    const a = asg('2000000001'); arrive(a, CHK1);
    const r = ck.checkBagCount(s, a.id, { presented: 3 }, ctx(CHK1)); // SV: 2 + 2 extra allowed
    expect(r).toMatchObject({ outcome: 'extra_requested', extraRequested: 1, allowed: 4 });
    expect(a).toMatchObject({ bags_declared: 3, extra_approval: 'Requested' });
    expect(s.notifications.some((n) => n.roles.includes('backend') && /Extra tag request/.test(n.title))).toBe(true);
    expect(tags.extraBagRequests(s)).toHaveLength(1);
    const extra = ck.activeBags(s, a).find((b) => b.extra);
    expect(extra.status).toBe('Declared');
    expect(ck.scanTag(s, a.id, extra.id, 'INTERNAL', hand('RBL-D-000001'), ctx(CHK1)).code).toBe('NOT_RELEASED');
    expect(tags.issueExtraBagTags(s, a.traveler_id, ctx(BE))).toEqual({ issued: 1, waiting: 0 });
    expect(extra).toMatchObject({ status: 'Tag Assigned' });
    expect(['0650012351', '0650012352']).toContain(extra.airline_tag_no);
    expect(tags.extraBagRequests(s)).toHaveLength(0);
  });
  it('beyond the limit → the extra bag stays with the traveler + Over Airline Limit; PK allows no extras', () => {
    prepare('SV 1821', 'sv');
    const a = asg('2000000001'); arrive(a, CHK1);
    expect(ck.checkBagCount(s, a.id, { presented: 5 }, ctx(CHK1))).toMatchObject({ extraRequested: 2, leftWithTraveler: 1 });
    expect(s.exceptions.some((e) => e.type === 'Over Airline Limit')).toBe(true);
    // PK 760, Rizwan: allowed 2, declared 2, presents 3
    for (const r of be.dataRows(s)) if (r.flight === 'PK 760' && r.match.status === 'matched') be.matchAndVerify(s, r.traveler.id, ctx(BE));
    const pk = asg('2000000007'); arrive(pk, CHK1);
    expect(ck.checkBagCount(s, pk.id, { presented: 3 }, ctx(CHK1))).toMatchObject({ outcome: 'over_limit', extraRequested: 0, leftWithTraveler: 1 });
    expect(ck.activeBags(s, pk)).toHaveLength(2);
  });
  it('a bag without a tag can be left with the traveler (reason required)', () => {
    prepare('SV 1821', 'sv');
    const a = asg('2000000001'); arrive(a, CHK1);
    ck.checkBagCount(s, a.id, { presented: 3 }, ctx(CHK1));
    const extra = ck.activeBags(s, a).find((b) => b.extra);
    expect(() => ck.withdrawBag(s, extra.id, '', ctx(CHK1))).toThrowError(/reason/);
    ck.withdrawBag(s, extra.id, 'Backend has not issued the tag', ctx(CHK1));
    expect(a.bags_declared).toBe(2);
  });
});

describe('scanService + scan filter', () => {
  it('every scan is saved with a valid method; bad enums are refused; RBAC applies', () => {
    expect(() => recordScan(s, { step: 'X', method: 'TELEPATHY', raw_value: '1', result: 'OK' }, ctx(CHK1))).toThrowError(/method/);
    expect(() => recordScan(s, { step: 'X', method: 'MANUAL', raw_value: '1', result: 'MAYBE' }, ctx(CHK1))).toThrowError(/result/);
    expect(() => recordScan(s, { step: 'X', method: 'MANUAL', symbology: 'PDF417', raw_value: '1', result: 'OK' }, ctx(CHK1))).toThrowError(/symbology/);
    const ops = s.users.find((u) => u.id === 'OPS-001');
    expect(() => recordScan(s, { step: 'X', method: 'MANUAL', raw_value: '1', result: 'OK' }, ctx(ops))).toThrow(PermissionError);
    prepare('SV 1821', 'sv');
    const a = asg('2000000001'); arrive(a, CHK1); weighAndTag(a, CHK1);
    ck.scanTag(s, a.id, ck.activeBags(s, a)[0].id, 'INTERNAL', hand('nope', 'MANUAL'), ctx(CHK1));
    expect(s.scanEvents.length).toBeGreaterThan(4);
    expect(s.scanEvents.every((e) => ['HANDHELD', 'CAMERA', 'MANUAL'].includes(e.method) && e.device_id !== undefined)).toBe(true);
    expect(s.scanEvents.at(-1)).toMatchObject({ method: 'MANUAL', result: 'UNKNOWN' });
  });
  it('camera ITF needs 2 identical consecutive reads; other symbologies accept at once; pause after accept', () => {
    const f = createReadFilter({ pauseMs: 1000 });
    expect(f.feed('0650012345', 'ITF', 0)).toBeNull();
    expect(f.feed('0650012345', 'ITF', 100)).toBe('0650012345');
    expect(f.feed('0650012345', 'ITF', 200)).toBeNull(); // paused
    expect(f.feed('0650012345', 'ITF', 1300)).toBeNull();
    expect(f.feed('0650012345', 'ITF', 1400)).toBe('0650012345');
    const g = createReadFilter();
    expect(g.feed('0650012345', 'ITF', 0)).toBeNull();
    expect(g.feed('0650012346', 'ITF', 50)).toBeNull(); // a different value restarts the count
    expect(g.feed('0650012346', 'ITF', 80)).toBe('0650012346');
    expect(createReadFilter().feed('RBL-D-000001', 'CODE128', 0)).toBe('RBL-D-000001');
    expect(createReadFilter().feed('TRK-101', 'QR', 0)).toBe('TRK-101');
    const slow = createReadFilter({ consecutiveWindowMs: 500 });
    slow.feed('0650012345', 'ITF', 0);
    expect(slow.feed('0650012345', 'ITF', 900)).toBeNull(); // too slow to count as consecutive
  });
  it('symbology helpers', () => {
    expect(inferSymbology('0650012345')).toBe('ITF');
    expect(inferSymbology('RBL-D-000123')).toBe('CODE128');
    expect(inferSymbology('TRK-101')).toBe('QR');
    expect(symbologyFromFormat('ITF')).toBe('ITF');
    expect(symbologyFromFormat('CODE_128')).toBe('CODE128');
    expect(symbologyFromFormat('QR_CODE')).toBe('QR');
  });
});
