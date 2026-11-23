/**
 * Phase 6 — the airport run (Transport Staff) and the Airport Coordinator:
 * seal → offload (count match) → SGS handover → voucher.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from '../../shared/store.js';
import { seedDeparture, SAMPLE_TAG_FILES } from '../../shared/seed/departure.js';
import * as be from '../../shared/services/backendService.js';
import * as tags from '../../shared/services/tagService.js';
import * as ck from '../../shared/services/checkinService.js';
import * as tr from '../../shared/services/transportService.js';
import * as wh from '../../shared/services/warehouseService.js';
import * as ap from '../../shared/services/airportService.js';
import { PermissionError } from '../../shared/rbac.js';
import { ServiceError } from '../../shared/services/errors.js';

const NOW = new Date('2026-06-01T06:00:00Z').getTime();
const AZIZIYAH = 'AREA-AZIZIYAH';
const WH = 'WH-MAKKAH';
const SEAL = 'SEAL-4471';

let s; let BE; let CHK1; let TM; let TS1; let TS2; let WM; let APC; let OPS;
const ctx = (user, now = NOW) => ({ user, now });
const trav = (nid) => s.travelers.find((t) => t.nusuk_id === nid);
const asg = (nid) => s.collectionAssignments.find((a) => a.traveler_id === trav(nid).id);
const csv = (id) => SAMPLE_TAG_FILES.find((f) => f.id === id).csv;
const label = (bag) => ({ value: bag.tag_no, method: 'HANDHELD', symbology: 'CODE128' });
const airlineTag = (bag) => ({ value: bag.airline_tag_no, method: 'HANDHELD', symbology: 'ITF' });
const bagById = (id) => s.bags.find((b) => b.id === id);

function prepare(code, file) {
  for (const r of be.dataRows(s)) if (r.flight === code && r.match.status === 'matched' && !r.traveler.data_verified) be.matchAndVerify(s, r.traveler.id, ctx(BE));
  tags.importTagBatch(s, { csv: csv(file) }, ctx(BE));
  tags.assignTags(s, code, ctx(BE));
  tags.releaseTags(s, code, ctx(BE));
}

function fullCheckin(nid, user) {
  const a = asg(nid);
  const t = trav(nid);
  ck.startRoute(s, a.id, {}, ctx(user));
  ck.markArrived(s, a.id, { gps: { lat: 21.4, lng: 39.8 } }, ctx(user));
  ck.confirmIdentity(s, a.id, { last4: t.passport.slice(-4), photoOk: true }, ctx(user));
  const bags = ck.activeBags(s, a);
  ck.recordWeights(s, a.id, Object.fromEntries(bags.map((b) => [b.id, 20])), ctx(user));
  for (const b of bags) {
    if (b.airline_tag_no) ck.scanTag(s, a.id, b.id, 'AIRLINE', airlineTag(b), ctx(user));
    ck.scanTag(s, a.id, b.id, 'INTERNAL', label(b), ctx(user));
  }
  ck.completeCheckin(s, a.id, ctx(user));
  ck.handToTransport(s, a.id, ctx(user));
  return a;
}

/** Residence → collection truck → warehouse → screened. @returns {string[]} the bag ids */
function screened(nid = '2000000001') {
  fullCheckin(nid, CHK1);
  const trip = tr.dispatchCollectionTrip(s, AZIZIYAH, { driverId: 'DRV-001', truckId: 'TRK-001' }, ctx(TM));
  tr.loadCollectionTrip(s, trip.id, { presented: 2 }, ctx(TS1));
  tr.departTrip(s, trip.id, ctx(TS1));
  tr.arriveAtWarehouse(s, trip.id, ctx(TS1));
  wh.startReceiving(s, trip.id, { value: trip.truck_id, method: 'HANDHELD', symbology: 'QR' }, ctx(WM));
  for (const id of [...trip.bag_ids]) wh.scanBagAtWarehouse(s, trip.id, label(bagById(id)), ctx(WM));
  wh.completeReceiving(s, trip.id, ctx(WM));
  wh.screenBags(s, trip.bag_ids, ctx(WM));
  return [...trip.bag_ids];
}

/** …then loaded onto an airport truck and closed. @returns {object} the airport trip */
function loadedAirportTruck(staffId = 'TS-001') {
  const ids = screened();
  const trip = tr.dispatchAirportTrip(s, { warehouseId: WH, driverId: 'DRV-002', truckId: 'TRK-002', staffId }, ctx(TM));
  for (const id of ids) wh.scanBagToAirportTruck(s, trip.id, label(bagById(id)), ctx(WM));
  wh.closeAirportLoad(s, trip.id, ctx(WM));
  return s.trips.find((t) => t.id === trip.id);
}

/** …sealed, driven and parked at the airport gate. */
function truckAtAirport(staffId = 'TS-001') {
  const trip = loadedAirportTruck(staffId);
  const staff = s.users.find((u) => u.id === staffId);
  tr.departForAirport(s, trip.id, { sealNo: SEAL }, ctx(staff));
  tr.arriveAtAirport(s, trip.id, ctx(staff));
  return trip;
}

/** …seal checked and every bag scanned off. */
function offloaded() {
  const trip = truckAtAirport();
  ap.checkSeal(s, trip.id, { sealNo: SEAL, intact: true }, ctx(APC));
  for (const id of trip.bag_ids) ap.scanBagAtAirport(s, trip.id, label(bagById(id)), ctx(APC));
  ap.completeOffload(s, trip.id, ctx(APC));
  return trip;
}

beforeEach(() => {
  s = createStore({ storage: null, baseAccounts: false }).get();
  seedDeparture(s, { now: NOW });
  BE = s.users.find((u) => u.id === 'BE-001');
  CHK1 = s.users.find((u) => u.id === 'CHK-001');
  TM = s.users.find((u) => u.id === 'TM-001');
  TS1 = s.users.find((u) => u.id === 'TS-001');
  TS2 = s.users.find((u) => u.id === 'TS-002');
  WM = s.users.find((u) => u.id === 'WM-001');
  APC = s.users.find((u) => u.id === 'APC-001');
  OPS = s.users.find((u) => u.id === 'OPS-001');
  prepare('SV 1821', 'sv');
});

describe('dispatching the airport run', () => {
  it('needs the Transport Staff member who will drive it', () => {
    screened();
    expect(() => tr.dispatchAirportTrip(s, { warehouseId: WH, driverId: 'DRV-002', truckId: 'TRK-002' }, ctx(TM)))
      .toThrow(/Transport Staff/);
    expect(() => tr.dispatchAirportTrip(s, { warehouseId: WH, driverId: 'DRV-002', truckId: 'TRK-002', staffId: 'CHK-001' }, ctx(TM)))
      .toThrow(ServiceError);
    const trip = tr.dispatchAirportTrip(s, { warehouseId: WH, driverId: 'DRV-002', truckId: 'TRK-002', staffId: 'TS-001' }, ctx(TM));
    expect(trip.staff_id).toBe('TS-001');
    expect(s.notifications.some((n) => n.user_id === 'TS-001' && /Airport run/.test(n.title))).toBe(true);
  });

  it('shows the run to the staff member it was assigned to, and to nobody else', () => {
    loadedAirportTruck('TS-001');
    expect(tr.listMyAirportTrips(s, TS1).map((t) => t.type)).toEqual(['Airport']);
    expect(tr.listMyAirportTrips(s, TS2)).toHaveLength(0);
    // the collection list is unaffected
    expect(tr.listMyTrips(s, TS1, { includeDone: true }).every((t) => t.type === 'Collection')).toBe(true);
  });
});

describe('driving the airport run (Transport Staff)', () => {
  it('seals the truck and moves every bag to In Transit to Airport', () => {
    const trip = loadedAirportTruck();
    expect(() => tr.departForAirport(s, trip.id, { sealNo: '' }, ctx(TS1))).toThrow(/seal number/i);
    const out = tr.departForAirport(s, trip.id, { sealNo: SEAL }, ctx(TS1));
    expect(out.status).toBe('En Route');
    expect(out.seal_no).toBe(SEAL);
    expect(trip.bag_ids.every((id) => bagById(id).status === 'In Transit to Airport')).toBe(true);
    expect(s.notifications.some((n) => n.roles.includes('airport_coordinator') && /en route/.test(n.title))).toBe(true);
  });

  it('cannot depart before the warehouse closes the load, and only the assigned staff may drive it', () => {
    const ids = screened();
    const trip = tr.dispatchAirportTrip(s, { warehouseId: WH, driverId: 'DRV-002', truckId: 'TRK-002', staffId: 'TS-001' }, ctx(TM));
    expect(() => tr.departForAirport(s, trip.id, { sealNo: SEAL }, ctx(TS1))).toThrow(/has not closed its load/);
    for (const id of ids) wh.scanBagToAirportTruck(s, trip.id, label(bagById(id)), ctx(WM));
    wh.closeAirportLoad(s, trip.id, ctx(WM));
    expect(() => tr.departForAirport(s, trip.id, { sealNo: SEAL }, ctx(TS2))).toThrow(PermissionError);
  });

  it('arrives at the airport and tells the Coordinator which seal to expect', () => {
    const trip = loadedAirportTruck();
    expect(() => tr.arriveAtAirport(s, trip.id, ctx(TS1))).toThrow(/Depart the warehouse/);
    tr.departForAirport(s, trip.id, { sealNo: SEAL }, ctx(TS1));
    const out = tr.arriveAtAirport(s, trip.id, ctx(TS1));
    expect(out.status).toBe('Arrived');
    expect(s.notifications.some((n) => n.roles.includes('airport_coordinator') && n.body.includes(SEAL))).toBe(true);
    // the truck is still Busy — it is not empty until the Coordinator offloads it
    expect(s.trucks.find((t) => t.id === 'TRK-002').status).toBe('Busy');
  });
});

describe('incoming + seal check (Airport Coordinator)', () => {
  it('lists trucks heading here with their flights and priority', () => {
    const trip = truckAtAirport();
    const rows = ap.incomingTrips(s, APC, { now: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ priority: 1, sealChecked: false, offloaded: false });
    expect(rows[0].flights).toEqual(['SV 1821']);
    expect(rows[0].trip.id).toBe(trip.id);
    expect(ap.sealQueue(s, APC, { now: NOW })).toHaveLength(1);
  });

  it('accepts a matching seal', () => {
    const trip = truckAtAirport();
    const r = ap.checkSeal(s, trip.id, { sealNo: SEAL, intact: true }, ctx(APC));
    expect(r).toMatchObject({ ok: true, matched: true });
    expect(s.trips.find((t) => t.id === trip.id).seal_check.intact).toBe(true);
    expect(ap.sealQueue(s, APC, { now: NOW })).toHaveLength(0);
    expect(() => ap.checkSeal(s, trip.id, { sealNo: SEAL, intact: true }, ctx(APC))).toThrow(/already been checked/);
  });

  it('a wrong or broken seal raises a High Seal Broken exception, tells Ops and still allows the offload', () => {
    const trip = truckAtAirport();
    const r = ap.checkSeal(s, trip.id, { sealNo: 'SEAL-0000', intact: true }, ctx(APC));
    expect(r.ok).toBe(false);
    const exc = s.exceptions.find((e) => e.type === 'Seal Broken');
    expect(exc).toMatchObject({ severity: 'High', status: 'Open' });
    expect(s.notifications.some((n) => n.roles.includes('ops_manager') && n.severity === 'critical')).toBe(true);
    // flagged, not blocked
    expect(ap.offloadQueue(s, APC, { now: NOW })).toHaveLength(1);
  });

  it('refuses a seal check before the truck is at the gate, and from the wrong role', () => {
    const trip = loadedAirportTruck();
    expect(() => ap.checkSeal(s, trip.id, { sealNo: SEAL }, ctx(APC))).toThrow(/not at the gate/);
    tr.departForAirport(s, trip.id, { sealNo: SEAL }, ctx(TS1));
    tr.arriveAtAirport(s, trip.id, ctx(TS1));
    expect(() => ap.checkSeal(s, trip.id, { sealNo: SEAL }, ctx(WM))).toThrow(PermissionError);
    expect(() => ap.checkSeal(s, trip.id, { sealNo: '' }, ctx(APC))).toThrow(/seal number/i);
  });
});

describe('offload (one label scan per bag, count match)', () => {
  it('will not open the truck before the seal is checked', () => {
    const trip = truckAtAirport();
    expect(() => ap.scanBagAtAirport(s, trip.id, label(bagById(trip.bag_ids[0])), ctx(APC))).toThrow(/Check the seal/);
  });

  it('scans each Rabel label once and refuses unknown, duplicate and wrong-truck labels', () => {
    const trip = truckAtAirport();
    ap.checkSeal(s, trip.id, { sealNo: SEAL }, ctx(APC));
    const first = bagById(trip.bag_ids[0]);
    expect(ap.scanBagAtAirport(s, trip.id, label(first), ctx(APC))).toMatchObject({ ok: true, scanned: 1, expected: 2 });
    expect(ap.scanBagAtAirport(s, trip.id, label(first), ctx(APC))).toMatchObject({ ok: false, result: 'DUPLICATE' });
    expect(ap.scanBagAtAirport(s, trip.id, { value: 'RBL-D-999999', method: 'MANUAL' }, ctx(APC))).toMatchObject({ ok: false, result: 'UNKNOWN' });
    const other = s.bags.find((b) => !trip.bag_ids.includes(b.id));
    const wrong = ap.scanBagAtAirport(s, trip.id, label(other), ctx(APC));
    expect(wrong).toMatchObject({ ok: false, result: 'WRONG_STEP' });
    expect(s.exceptions.some((e) => e.type === 'Count Mismatch')).toBe(true);
    expect(s.scanEvents.filter((e) => e.step === 'AIRPORT_OFFLOAD_LABEL')).toHaveLength(4);
    expect(s.scanEvents.filter((e) => e.step === 'AIRPORT_OFFLOAD_LABEL').every((e) => e.method)).toBe(true);
  });

  it('a short count raises a High Count Mismatch naming the labels and blocks the receipt', () => {
    const trip = truckAtAirport();
    ap.checkSeal(s, trip.id, { sealNo: SEAL }, ctx(APC));
    ap.scanBagAtAirport(s, trip.id, label(bagById(trip.bag_ids[0])), ctx(APC));
    const r = ap.completeOffload(s, trip.id, ctx(APC));
    expect(r).toMatchObject({ ok: false, expected: 2, scanned: 1 });
    expect(r.missing).toEqual([bagById(trip.bag_ids[1]).tag_no]);
    expect(s.exceptions.some((e) => e.type === 'Count Mismatch' && e.severity === 'High')).toBe(true);
    expect(bagById(trip.bag_ids[0]).status).toBe('In Transit to Airport');
  });

  it('a full count receives every bag at the airport and frees the driver and truck', () => {
    const trip = offloaded();
    expect(trip.bag_ids.every((id) => bagById(id).status === 'Received at Airport')).toBe(true);
    expect(trip.bag_ids.every((id) => bagById(id).received_at_airport_at)).toBe(true);
    expect(s.drivers.find((d) => d.id === 'DRV-002').status).toBe('Available');
    expect(s.trucks.find((t) => t.id === 'TRK-002').status).toBe('Available');
    expect(s.trips.find((t) => t.id === trip.id).offload.completed_at).toBeTruthy();
    expect(ap.incomingTrips(s, APC, { now: NOW })).toHaveLength(0);
    expect(() => ap.completeOffload(s, trip.id, ctx(APC))).toThrow(/already been offloaded/);
  });

  it('asks Transport to take the empty truck back, but only once it is empty', () => {
    const trip = truckAtAirport();
    expect(() => ap.requestReturnTrip(s, trip.id, {}, ctx(APC))).toThrow(/Finish the offload/);
    ap.checkSeal(s, trip.id, { sealNo: SEAL }, ctx(APC));
    for (const id of trip.bag_ids) ap.scanBagAtAirport(s, trip.id, label(bagById(id)), ctx(APC));
    ap.completeOffload(s, trip.id, ctx(APC));
    ap.requestReturnTrip(s, trip.id, { note: 'Bay 3' }, ctx(APC));
    expect(s.notifications.some((n) => n.roles.includes('transport_manager') && /is empty/.test(n.title))).toBe(true);
  });
});

describe('SGS handover', () => {
  it('opens one manifest per flight from the bags standing here', () => {
    const trip = offloaded();
    const q = ap.handoverQueue(s, APC, { now: NOW });
    expect(q).toHaveLength(1);
    expect(q[0].flight.code).toBe('SV 1821');
    expect(q[0].bags).toHaveLength(2);
    const h = ap.startHandover(s, 'FLT-SV-1821', ctx(APC));
    expect(h.bag_ids).toEqual(trip.bag_ids);
    expect(h.tags).toEqual(trip.bag_ids.map((id) => bagById(id).airline_tag_no));
    expect(() => ap.startHandover(s, 'FLT-SV-1821', ctx(APC))).toThrow(/already open/);
  });

  it('refuses a cancelled flight and a flight with no bags here', () => {
    offloaded();
    expect(() => ap.startHandover(s, 'FLT-SV-1944', ctx(APC))).toThrow(/cancelled/);
    expect(() => ap.startHandover(s, 'FLT-GA-981', ctx(APC))).toThrow(/No GA 981 bags/);
  });

  it('only disputed bags are scanned, and a scan clears the dispute', () => {
    const trip = offloaded();
    const h = ap.startHandover(s, 'FLT-SV-1821', ctx(APC));
    const bag = bagById(trip.bag_ids[0]);
    expect(() => ap.disputeBag(s, h.id, bag.id, { reason: '' }, ctx(APC))).toThrow(/disputes/);
    ap.disputeBag(s, h.id, bag.id, { reason: 'Not on the Authority count' }, ctx(APC));
    expect(ap.scanDisputedTag(s, h.id, airlineTag(bagById(trip.bag_ids[1])), ctx(APC))).toMatchObject({ ok: false, result: 'DUPLICATE' });
    const ok = ap.scanDisputedTag(s, h.id, airlineTag(bag), ctx(APC));
    expect(ok.ok).toBe(true);
    expect(h.disputed[0].resolved_at).toBeTruthy();
    expect(s.scanEvents.filter((e) => e.step === 'SGS_AIRLINE_TAG')).toHaveLength(2);
  });

  it('hands the manifest over, moving every bag to Handed to Airport Authority and issuing a voucher', () => {
    const trip = offloaded();
    const h = ap.startHandover(s, 'FLT-SV-1821', ctx(APC));
    expect(() => ap.completeHandover(s, h.id, { officer: 'A. Officer' }, ctx(APC))).toThrow(/signature/i);
    const r = ap.completeHandover(s, h.id, { officer: 'A. Officer', signature: 'sig' }, ctx(APC));
    expect(r.handed).toBe(2);
    expect(r.withheld).toEqual([]);
    expect(trip.bag_ids.every((id) => bagById(id).status === 'Handed to Airport Authority')).toBe(true);
    expect(h.status).toBe('Handed');
    expect(r.voucher.status).toBe('Pending');
    expect(r.voucher.counted_tags).toHaveLength(2);
    expect(() => ap.completeHandover(s, h.id, { officer: 'A', signature: 'sig' }, ctx(APC))).toThrow(/already closed/);
  });

  it('keeps the manifest as opened and records what actually crossed', () => {
    const trip = offloaded();
    const h = ap.startHandover(s, 'FLT-SV-1821', ctx(APC));
    const r = ap.completeHandover(s, h.id, { officer: 'A. Officer', signature: 'sig' }, ctx(APC));
    expect(h.bag_ids).toEqual(trip.bag_ids);
    expect(h.handed_bag_ids).toEqual(trip.bag_ids);
    expect(h.handed_tags).toEqual(trip.bag_ids.map((id) => bagById(id).airline_tag_no));
    expect(h.withdrawn).toEqual([]);
    expect(r.voucher.bag_ids).toEqual(trip.bag_ids);
  });

  it('a bag that leaves the manifest before signing stays on the record and goes to Ops', () => {
    const trip = offloaded();
    const h = ap.startHandover(s, 'FLT-SV-1821', ctx(APC));
    // The flight is cancelled while the manifest is open, so one bag is held instead of handed
    // over. It was never disputed — without `withdrawn` it would vanish from the handover.
    s.flights.find((f) => f.id === 'FLT-SV-1821').status = 'Cancelled';
    ap.holdCancelledBags(s, [trip.bag_ids[0]], { rack: 'R-09' }, ctx(APC));

    const r = ap.completeHandover(s, h.id, { officer: 'A. Officer', signature: 'sig' }, ctx(APC));
    expect(r.handed).toBe(1);
    expect(r.withheld).toEqual([]);
    expect(r.withdrawn).toHaveLength(1);
    expect(r.withdrawn[0]).toMatchObject({ bag_id: trip.bag_ids[0], status: 'Held – Cancelled Flight' });
    expect(h.bag_ids).toEqual(trip.bag_ids);                 // the sheet the officer read is intact
    expect(h.handed_bag_ids).toEqual([trip.bag_ids[1]]);     // only this one crossed
    expect(r.voucher.bag_ids).toEqual([trip.bag_ids[1]]);
    expect(r.voucher.counted_tags).toEqual([bagById(trip.bag_ids[1]).airline_tag_no]);
    expect(s.exceptions.some((e) => e.type === 'Count Mismatch' && /left the manifest before it was signed/.test(e.notes))).toBe(true);
  });

  it('withholds a bag whose dispute is unresolved and raises a Count Mismatch', () => {
    const trip = offloaded();
    const h = ap.startHandover(s, 'FLT-SV-1821', ctx(APC));
    ap.disputeBag(s, h.id, trip.bag_ids[0], { reason: 'Tag unreadable' }, ctx(APC));
    const r = ap.completeHandover(s, h.id, { officer: 'A. Officer', signature: 'sig' }, ctx(APC));
    expect(r.handed).toBe(1);
    expect(r.withheld).toEqual([trip.bag_ids[0]]);
    expect(bagById(trip.bag_ids[0]).status).toBe('Received at Airport');
    expect(s.exceptions.some((e) => e.type === 'Count Mismatch' && /disputed/.test(e.notes))).toBe(true);
  });
});

describe('the SGS voucher', () => {
  function handed() {
    const trip = offloaded();
    const h = ap.startHandover(s, 'FLT-SV-1821', ctx(APC));
    const { voucher } = ap.completeHandover(s, h.id, { officer: 'A. Officer', signature: 'sig' }, ctx(APC));
    return { trip, voucher };
  }

  it('accepting a matching voucher is the bags\' SGS Voucher Accepted step', () => {
    const { trip, voucher } = handed();
    const r = ap.acceptVoucher(s, voucher.id, ctx(APC));
    expect(r.ok).toBe(true);
    expect(r.accepted).toBe(2);
    expect(trip.bag_ids.every((id) => bagById(id).status === 'SGS Voucher Accepted')).toBe(true);
    expect(voucher.status).toBe('Accepted');
    expect(voucher.accepted_at).toBeTruthy();
    expect(() => ap.acceptVoucher(s, voucher.id, ctx(APC))).toThrow(/already been accepted/);
  });

  it('a tag the Authority did not count raises an SGS Voucher Mismatch and moves nothing', () => {
    const trip = offloaded();
    s.simulated = { ...(s.simulated || {}), voucherDrops: { 'FLT-SV-1821': [bagById(trip.bag_ids[1]).airline_tag_no] } };
    const h = ap.startHandover(s, 'FLT-SV-1821', ctx(APC));
    const { voucher } = ap.completeHandover(s, h.id, { officer: 'A. Officer', signature: 'sig' }, ctx(APC));
    const r = ap.acceptVoucher(s, voucher.id, ctx(APC));
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([bagById(trip.bag_ids[1]).airline_tag_no]);
    expect(voucher.status).toBe('Mismatch');
    expect(trip.bag_ids.every((id) => bagById(id).status === 'Handed to Airport Authority')).toBe(true);
    expect(s.exceptions.some((e) => e.type === 'SGS Voucher Mismatch' && e.severity === 'High')).toBe(true);
    expect(s.notifications.some((n) => n.roles.includes('ops_manager'))).toBe(true);
  });

  it('lists my airport\'s vouchers only', () => {
    const { voucher } = handed();
    expect(ap.listVouchers(s, APC).map((v) => v.id)).toEqual([voucher.id]);
    expect(() => ap.listVouchers(s, WM)).toThrow(PermissionError);
  });
});

describe('holding a cancelled flight at the airport', () => {
  it('offers only cancelled-flight bags and needs somewhere to put them', () => {
    const trip = offloaded();
    expect(ap.cancelledAtAirport(s, APC)).toHaveLength(0);
    s.flights.find((f) => f.id === 'FLT-SV-1821').status = 'Cancelled';
    const here = ap.cancelledAtAirport(s, APC);
    expect(here.map((b) => b.id)).toEqual(trip.bag_ids);
    expect(() => ap.holdCancelledBags(s, here.map((b) => b.id), { rack: '' }, ctx(APC))).toThrow(/where/i);
    const r = ap.holdCancelledBags(s, here.map((b) => b.id), { rack: 'A-12' }, ctx(APC));
    expect(r.held).toBe(2);
    expect(bagById(trip.bag_ids[0]).status).toBe('Held – Cancelled Flight');
    expect(bagById(trip.bag_ids[0]).holding_rack).toBe('A-12');
    // a cancelled flight is never handed over
    expect(ap.handoverQueue(s, APC, { now: NOW })).toHaveLength(0);
  });
});

describe('summary and exceptions', () => {
  it('counts each airport stage and keeps exceptions read-only for the Coordinator', () => {
    const trip = truckAtAirport();
    let sum = ap.airportSummary(s, APC, { now: NOW });
    expect(sum).toMatchObject({ enRoute: 0, atGate: 1, toOffload: 0, atAirport: 0 });
    ap.checkSeal(s, trip.id, { sealNo: SEAL }, ctx(APC));
    expect(ap.airportSummary(s, APC, { now: NOW })).toMatchObject({ atGate: 0, toOffload: 1 });
    for (const id of trip.bag_ids) ap.scanBagAtAirport(s, trip.id, label(bagById(id)), ctx(APC));
    ap.completeOffload(s, trip.id, ctx(APC));
    const h = ap.startHandover(s, 'FLT-SV-1821', ctx(APC));
    const { voucher } = ap.completeHandover(s, h.id, { officer: 'A', signature: 'sig' }, ctx(APC));
    sum = ap.airportSummary(s, APC, { now: NOW });
    expect(sum).toMatchObject({ atAirport: 0, awaitingVoucher: 2, openVouchers: 1 });
    ap.acceptVoucher(s, voucher.id, ctx(APC));
    expect(ap.airportSummary(s, APC, { now: NOW })).toMatchObject({ accepted: 2, openVouchers: 0 });
    expect(ap.airportExceptions(s, APC)).toEqual([]);
    expect(() => ap.airportSummary(s, OPS, { now: NOW })).not.toThrow();
  });
});
