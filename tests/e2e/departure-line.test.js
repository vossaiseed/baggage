/**
 * The departure line, end to end: one bag from "Declared" to "Loaded on Aircraft" through every
 * role and every real service — the regression check the v7 plan asks for (§6).
 *
 * It asserts three things that no single-phase test can:
 *   1. the bag's own history is exactly the 13 statuses, in order, with no step skipped;
 *   2. each step was set by the role shared/rbac.js says may set it, and by no other;
 *   3. every scan recorded along the way carries its method (HANDHELD / CAMERA / MANUAL).
 *
 * It runs against the shared services, not a browser: the rules live in `shared/`, and this is
 * where a regression in them shows up. The browser side is covered by tests/e2e/apps.spec.js
 * (Playwright), which needs browsers installed.
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
import * as fl from '../../shared/services/flightService.js';
import * as mon from '../../shared/services/monitorService.js';
import { validateState } from '../../shared/seed/validate.js';
import { BAG_STATUSES, SCAN_METHODS } from '../../shared/constants.js';
import { rolesThatCanAdvanceTo, PermissionError } from '../../shared/rbac.js';

const NOW = new Date('2026-06-01T06:00:00Z').getTime();
const AZIZIYAH = 'AREA-AZIZIYAH';
const WH = 'WH-MAKKAH';
const SEAL = 'SEAL-4471';
const FLIGHT = 'SV 1821';

let s; const U = {};
const ctx = (user, now = NOW) => ({ user, now });
const trav = (nid) => s.travelers.find((t) => t.nusuk_id === nid);
const asg = (nid) => s.collectionAssignments.find((a) => a.traveler_id === trav(nid).id);
const bagById = (id) => s.bags.find((b) => b.id === id);
const label = (bag) => ({ value: bag.tag_no, method: 'HANDHELD', symbology: 'CODE128' });

beforeEach(() => {
  s = createStore({ storage: null, baseAccounts: false }).get();
  seedDeparture(s, { now: NOW });
  for (const id of ['BE-001', 'CHK-001', 'TM-001', 'TS-001', 'WM-001', 'APC-001', 'OPS-001', 'MON-001']) {
    U[id] = s.users.find((u) => u.id === id);
  }
});

/** Drive the whole line for one traveler. @returns {{ bagIds: string[], flightId: string }} */
function runTheLine() {
  const nid = '2000000001';
  const t = trav(nid);
  const a = asg(nid);

  // 1 · Backend verifies the Nusuk/airline match → Data Verified (+ internal labels)
  be.matchAndVerify(s, t.id, ctx(U['BE-001']));
  // 2 · Backend imports, assigns and releases the airline's tags → Tag Assigned
  tags.importTagBatch(s, { csv: SAMPLE_TAG_FILES.find((f) => f.id === 'sv').csv }, ctx(U['BE-001']));
  tags.assignTags(s, FLIGHT, ctx(U['BE-001']));
  tags.releaseTags(s, FLIGHT, ctx(U['BE-001']));

  // 3 · Check-in Staff at the residence → Checked-in
  ck.startRoute(s, a.id, {}, ctx(U['CHK-001']));
  ck.markArrived(s, a.id, { gps: { lat: 21.4, lng: 39.8 } }, ctx(U['CHK-001']));
  ck.confirmIdentity(s, a.id, { last4: t.passport.slice(-4), photoOk: true }, ctx(U['CHK-001']));
  const bags = ck.activeBags(s, a);
  ck.recordWeights(s, a.id, Object.fromEntries(bags.map((b) => [b.id, 20])), ctx(U['CHK-001']));
  for (const b of bags) {
    ck.scanTag(s, a.id, b.id, 'AIRLINE', { value: b.airline_tag_no, method: 'HANDHELD', symbology: 'ITF' }, ctx(U['CHK-001']));
    ck.scanTag(s, a.id, b.id, 'INTERNAL', label(b), ctx(U['CHK-001']));
  }
  ck.completeCheckin(s, a.id, ctx(U['CHK-001']));
  ck.handToTransport(s, a.id, ctx(U['CHK-001']));

  // 4 · Transport: pickup point → warehouse → Loaded to Collection Truck
  const trip = tr.dispatchCollectionTrip(s, AZIZIYAH, { driverId: 'DRV-001', truckId: 'TRK-001' }, ctx(U['TM-001']));
  tr.loadCollectionTrip(s, trip.id, { presented: bags.length }, ctx(U['TS-001']));
  tr.departTrip(s, trip.id, ctx(U['TS-001']));
  tr.arriveAtWarehouse(s, trip.id, ctx(U['TS-001']));
  const bagIds = [...trip.bag_ids];

  // 5 · Warehouse: receive → screen → load the airport truck
  wh.startReceiving(s, trip.id, { value: trip.truck_id, method: 'HANDHELD', symbology: 'QR' }, ctx(U['WM-001']));
  for (const id of bagIds) wh.scanBagAtWarehouse(s, trip.id, label(bagById(id)), ctx(U['WM-001']));
  wh.completeReceiving(s, trip.id, ctx(U['WM-001']));
  wh.screenBags(s, bagIds, ctx(U['WM-001']));
  wh.requestAirportTruck(s, { warehouseId: WH }, ctx(U['WM-001']));
  const run = tr.dispatchAirportTrip(s, { warehouseId: WH, driverId: 'DRV-002', truckId: 'TRK-002', staffId: 'TS-001' }, ctx(U['TM-001']));
  for (const id of bagIds) wh.scanBagToAirportTruck(s, run.id, label(bagById(id)), ctx(U['WM-001']));
  wh.closeAirportLoad(s, run.id, ctx(U['WM-001']));

  // 6 · Transport Staff drive it → In Transit to Airport
  tr.departForAirport(s, run.id, { sealNo: SEAL }, ctx(U['TS-001']));
  tr.arriveAtAirport(s, run.id, ctx(U['TS-001']));

  // 7 · Airport Coordinator: seal → offload → hand over → voucher
  ap.checkSeal(s, run.id, { sealNo: SEAL, intact: true }, ctx(U['APC-001']));
  for (const id of bagIds) ap.scanBagAtAirport(s, run.id, label(bagById(id)), ctx(U['APC-001']));
  ap.completeOffload(s, run.id, ctx(U['APC-001']));
  const flightId = bagById(bagIds[0]).flight_id;
  const h = ap.startHandover(s, flightId, ctx(U['APC-001']));
  const { voucher } = ap.completeHandover(s, h.id, { officer: 'A. Officer', signature: 'data:sig' }, ctx(U['APC-001']));
  ap.acceptVoucher(s, voucher.id, ctx(U['APC-001']));

  // 8 · Backend confirms the airline manifest → Loaded on Aircraft
  be.confirmLoaded(s, flightId, {}, ctx(U['BE-001']));

  return { bagIds, flightId };
}

describe('one bag, all 13 statuses', () => {
  it('walks the line in order, never skipping or repeating a step', () => {
    const { bagIds } = runTheLine();
    for (const id of bagIds) {
      const bag = bagById(id);
      expect(bag.status).toBe('Loaded on Aircraft');
      const walked = bag.status_history.map((h) => h.to);
      expect(walked).toEqual(BAG_STATUSES);
    }
  });

  it('each step was set by a role rbac.js allows to set it', () => {
    const { bagIds } = runTheLine();
    const bag = bagById(bagIds[0]);
    for (const step of bag.status_history) {
      if (step.to === 'Declared') continue; // set when the traveler books
      expect(rolesThatCanAdvanceTo(step.to), `${step.to} was set by ${step.role}`).toContain(step.role);
    }
  });

  it('every scan carries its method, and every bag scan points at a real bag', () => {
    const { bagIds } = runTheLine();
    expect(s.scanEvents.length).toBeGreaterThan(0);
    for (const scan of s.scanEvents) {
      expect(SCAN_METHODS, `${scan.id} (${scan.step})`).toContain(scan.method);
      expect(scan.step).toBeTruthy();
      if (scan.bag_id) expect(bagById(scan.bag_id), `${scan.id} points at ${scan.bag_id}`).toBeTruthy();
    }
    // the hand-offs that must be one scan per bag
    const steps = s.scanEvents.filter((e) => e.result === 'OK').map((e) => e.step);
    for (const step of ['WAREHOUSE_INTERNAL_LABEL', 'WAREHOUSE_LOAD_LABEL']) {
      expect(steps.filter((x) => x === step)).toHaveLength(bagIds.length);
    }
  });

  it('leaves the store sound, and every step in the audit trail', () => {
    const { bagIds, flightId } = runTheLine();
    expect(validateState(s)).toEqual([]);
    const advances = s.auditLog.filter((a) => a.action === 'bag.advance' && a.entity_id === bagIds[0]);
    expect(advances.map((a) => a.after.status)).toEqual(BAG_STATUSES.slice(1));
    // and the flight can now be closed by Ops: every bag is accounted for
    const check = fl.closureChecklist(s, flightId, U['OPS-001'], { now: NOW });
    expect(check.outstanding.filter((o) => bagIds.includes(o.bag.id))).toEqual([]);
  });

  it('the consoles agree with each other at the end of the line', () => {
    const { bagIds, flightId } = runTheLine();
    const opsRow = fl.listFlights(s, U['OPS-001'], { now: NOW }).find((r) => r.flight.id === flightId);
    const board = mon.wallBoard(s, U['MON-001'], { now: NOW });
    const boardRow = board.flights.find((r) => r.flight.id === flightId);
    expect(opsRow.counts.loaded).toBeGreaterThanOrEqual(bagIds.length);
    expect(boardRow.counts).toEqual(opsRow.counts);
  });

  it('no role can take a step that belongs to another', () => {
    const { bagIds } = runTheLine();
    const other = s.bags.find((b) => !bagIds.includes(b.id) && b.status === 'Declared');
    // Check-in cannot verify data, Backend cannot check a bag in at the residence,
    // Transport cannot receive at the warehouse.
    expect(() => be.matchAndVerify(s, other.traveler_id, ctx(U['CHK-001']))).toThrow(PermissionError);
    expect(() => ck.completeCheckin(s, asg('2000000002').id, ctx(U['BE-001']))).toThrow(PermissionError);
    expect(() => wh.screenBags(s, [other.id], ctx(U['TS-001']))).toThrow(PermissionError);
  });
});
