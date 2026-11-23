import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from '../../shared/store.js';
import { seedDeparture } from '../../shared/seed/departure.js';
import * as ar from '../../shared/services/areaService.js';
import * as ex from '../../shared/services/exceptionService.js';
import * as rep from '../../shared/services/reportService.js';
import { PermissionError } from '../../shared/rbac.js';

const NOW = new Date('2026-06-01T06:00:00Z').getTime();
const H = 3600e3;
const SV = 'FLT-SV-1821';
const AZIZIYAH = 'AREA-AZIZIYAH';

let s; let CHK1; let WM; let OPS; let MON;
const ctx = (user, now = NOW) => ({ user, now });

beforeEach(() => {
  s = createStore({ storage: null, baseAccounts: false }).get();
  seedDeparture(s, { now: NOW });
  CHK1 = s.users.find((u) => u.id === 'CHK-001');
  WM = s.users.find((u) => u.id === 'WM-001');
  OPS = s.users.find((u) => u.id === 'OPS-001');
  MON = s.users.find((u) => u.id === 'MON-001');
});

describe('collection areas', () => {
  it('lists each area with its staff, residences, slots and open collections', () => {
    const rows = ar.listAreas(s, OPS, { now: NOW });
    expect(rows).toHaveLength(3);
    const az = rows.find((r) => r.area.id === AZIZIYAH);
    expect(az.warehouse.id).toBe('WH-MAKKAH');
    expect(az.checkinStaff).toBe(1);
    expect(az.transportStaff).toBe(1);
    expect(az.residences).toBeGreaterThan(0);
    expect(az.slots.total).toBeGreaterThan(0);
    expect(az.slots.capacity).toBeGreaterThanOrEqual(az.slots.booked);
  });

  it('creates an area with the id format the rest of the system uses, and its live flights’ slots', () => {
    const live = s.flights.filter((f) => f.cut_off_at && !['Cancelled', 'Completed'].includes(f.status)).length;
    const { area, slotsCreated } = ar.createArea(s, { name: 'Al Kakiyah', warehouse_id: 'WH-MAKKAH', lat: 21.41, lng: 39.85 }, ctx(OPS));
    expect(area.id).toBe('AREA-AL-KAKIYAH');
    expect(slotsCreated).toBe(live * 4); // 4 two-hour slots per 8 h collection window
    expect(ar.listAreas(s, OPS, { now: NOW }).some((r) => r.area.id === area.id)).toBe(true);
  });

  it('refuses a duplicate area, an unknown warehouse and a non-Ops user', () => {
    expect(() => ar.createArea(s, { name: 'Aziziyah' }, ctx(OPS))).toThrowError(expect.objectContaining({ code: 'DUPLICATE' }));
    expect(() => ar.createArea(s, { name: 'Nowhere', warehouse_id: 'WH-NOPE' }, ctx(OPS))).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => ar.createArea(s, { name: 'Sneaky' }, ctx(CHK1))).toThrow(PermissionError);
  });

  it('renaming an area keeps its id, because bags, users and scans point at it', () => {
    const area = ar.updateArea(s, AZIZIYAH, { name: 'Aziziyah North', lat: 21.43 }, ctx(OPS));
    expect(area.id).toBe(AZIZIYAH);
    expect(area.name).toBe('Aziziyah North');
    expect(area.lat).toBe(21.43);
    expect(s.users.find((u) => u.id === 'CHK-001').area_id).toBe(AZIZIYAH);
  });
});

describe('collection slots', () => {
  it('lists future slots for an area, with what is booked into them', () => {
    const rows = ar.listSlots(s, OPS, { areaId: AZIZIYAH, flightId: SV, now: NOW });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.slot.collection_area_id === AZIZIYAH)).toBe(true);
    expect(rows.every((r) => !r.past)).toBe(true);
    const booked = rows.find((r) => r.booked > 0);
    expect(booked.assignments.length).toBe(booked.booked);
    expect(booked.remaining).toBe(booked.slot.capacity_travelers - booked.booked);
  });

  it('capacity can be raised and lowered, but never below what is already booked', () => {
    const booked = ar.listSlots(s, OPS, { areaId: AZIZIYAH, now: NOW }).find((r) => r.booked > 0);
    const id = booked.slot.id;
    expect(ar.setSlotCapacity(s, id, 10, ctx(OPS)).capacity_travelers).toBe(10);
    expect(() => ar.setSlotCapacity(s, id, booked.booked - 1, ctx(OPS))).toThrowError(expect.objectContaining({ code: 'BELOW_BOOKED' }));
    expect(() => ar.setSlotCapacity(s, id, 2.5, ctx(OPS))).toThrowError(expect.objectContaining({ code: 'INVALID' }));
    expect(() => ar.setSlotCapacity(s, id, 8, ctx(WM))).toThrow(PermissionError);
  });

  it('generateSlots only adds what is missing and never shrinks a slot', () => {
    const area = ar.createArea(s, { name: 'Raised Capacity' }, ctx(OPS)).area;
    const first = ar.generateSlots(s, { flightId: SV, areaId: area.id, capacity: 12 }, ctx(OPS));
    expect(first.created).toBe(0); // createArea already made them
    const svSlots = () => ar.listSlots(s, OPS, { areaId: area.id, flightId: SV, now: NOW, includePast: true });
    expect(svSlots()).toHaveLength(4);
    expect(svSlots().every((r) => r.slot.capacity_travelers === 12)).toBe(true);
    const again = ar.generateSlots(s, { flightId: SV, areaId: area.id, capacity: 6 }, ctx(OPS));
    expect(again.created).toBe(0);
    expect(svSlots().every((r) => r.slot.capacity_travelers === 12)).toBe(true); // never shrunk
  });

  it('refuses slots for a cancelled flight or one without a cut-off', () => {
    expect(() => ar.generateSlots(s, { flightId: 'FLT-SV-1944' }, ctx(OPS))).toThrowError(expect.objectContaining({ code: 'FLIGHT_CLOSED' }));
    expect(() => ar.generateSlots(s, { flightId: 'NOPE' }, ctx(OPS))).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});

describe('exception lifecycle', () => {
  const raise = (over = {}) => ex.raiseException(s, { type: 'Count Mismatch', severity: 'Medium', bag_id: 'BAG-000001', flight_id: SV, area_id: AZIZIYAH, notes: 'One bag short', ...over }, ctx(CHK1));

  it('dedupes an identical exception while it is still being worked, not after it is resolved', () => {
    const a = raise();
    expect(raise().id).toBe(a.id);
    ex.assignException(s, a.id, { owner: 'OPS-001' }, ctx(OPS));
    expect(raise().id).toBe(a.id); // Assigned still counts as open
    ex.resolveException(s, a.id, { resolution: 'Bag found in the truck.' }, ctx(OPS));
    expect(raise().id).not.toBe(a.id); // it came back: a new row
  });

  it('runs Open -> Assigned -> Resolved -> Closed, keeping a log of every step', () => {
    const e = raise();
    expect(e.status).toBe('Open');
    ex.assignException(s, e.id, { owner: 'WM-001', dueAt: NOW + H }, ctx(OPS));
    expect(e.status).toBe('Assigned');
    expect(e.owner).toBe('WM-001');
    expect(s.notifications.some((n) => n.user_id === 'WM-001' && /assigned to you/i.test(n.title))).toBe(true);
    ex.addExceptionNote(s, e.id, 'Called the driver.', ctx(OPS));
    ex.resolveException(s, e.id, { resolution: 'Bag was on the next truck.' }, ctx(OPS));
    expect(e.status).toBe('Resolved');
    expect(e.resolved_by).toBe('OPS-001');
    ex.closeException(s, e.id, ctx(OPS));
    expect(e.status).toBe('Closed');
    expect(e.updates.map((u) => u.text)).toEqual([
      expect.stringContaining('Assigned to WM-001'), 'Called the driver.',
      expect.stringContaining('Resolved:'), 'Closed',
    ]);
    expect(s.auditLog.some((a) => a.action === 'exception.close' && a.entity_id === e.id)).toBe(true);
  });

  it('escalating raises the severity one step and tells Ops', () => {
    const e = raise({ severity: 'Medium' });
    ex.escalateException(s, e.id, 'Flight is 40 minutes from cut-off.', ctx(OPS));
    expect(e.severity).toBe('High');
    expect(e.status).toBe('Escalated');
    ex.escalateException(s, e.id, 'Still not found.', ctx(OPS));
    expect(e.severity).toBe('Critical');
    ex.escalateException(s, e.id, 'Nothing above Critical.', ctx(OPS));
    expect(e.severity).toBe('Critical'); // the ceiling
    expect(s.notifications.filter((n) => (n.roles || []).includes('ops_manager') && /escalated/i.test(n.title))).toHaveLength(3);
  });

  it('enforces the order of the lifecycle and the reasons it needs', () => {
    const e = raise();
    expect(() => ex.closeException(s, e.id, ctx(OPS))).toThrowError(expect.objectContaining({ code: 'NOT_RESOLVED' }));
    expect(() => ex.resolveException(s, e.id, { resolution: 'ok' }, ctx(OPS))).toThrowError(expect.objectContaining({ code: 'REASON_REQUIRED' }));
    expect(() => ex.escalateException(s, e.id, '', ctx(OPS))).toThrowError(expect.objectContaining({ code: 'REASON_REQUIRED' }));
    expect(() => ex.assignException(s, e.id, {}, ctx(OPS))).toThrowError(expect.objectContaining({ code: 'INVALID' }));
    expect(() => ex.assignException(s, e.id, { owner: 'NOPE-9' }, ctx(OPS))).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
    ex.resolveException(s, e.id, { resolution: 'Found it.' }, ctx(OPS));
    expect(() => ex.resolveException(s, e.id, { resolution: 'Again?' }, ctx(OPS))).toThrowError(expect.objectContaining({ code: 'ALREADY_RESOLVED' }));
    ex.closeException(s, e.id, ctx(OPS));
    ex.reopenException(s, e.id, 'The bag is missing again.', ctx(OPS));
    expect(e.status).toBe('Open');
    expect(e.resolution).toBeNull();
  });

  it('only Ops works an exception off; the roles that raise it can only read', () => {
    const e = raise();
    expect(() => ex.assignException(s, e.id, { owner: 'OPS-001' }, ctx(CHK1))).toThrow(PermissionError);
    expect(() => ex.resolveException(s, e.id, { resolution: 'I fixed it myself.' }, ctx(WM))).toThrow(PermissionError);
    expect(() => ex.closeException(s, e.id, ctx(MON))).toThrow(PermissionError);
    expect(ex.exceptionQueue(s, MON, { now: NOW }).some((r) => r.exception.id === e.id)).toBe(true);
  });

  it('the queue is severity-first and searchable; the summary counts what is still open', () => {
    const low = raise({ severity: 'Low', bag_id: 'BAG-000002' });
    const crit = raise({ severity: 'Critical', bag_id: 'BAG-000003', type: 'Seal Broken' });
    const rows = ex.exceptionQueue(s, OPS, { now: NOW });
    expect(rows[0].exception.id).toBe(crit.id);
    expect(rows.map((r) => r.exception.id)).toContain(low.id);
    expect(rows[0].flight.id).toBe(SV);
    expect(rows[0].raisedBy.id).toBe('CHK-001');
    expect(ex.exceptionQueue(s, OPS, { now: NOW, q: 'seal' }).map((r) => r.exception.id)).toEqual([crit.id]);
    expect(ex.exceptionQueue(s, OPS, { now: NOW, severity: 'Low' }).map((r) => r.exception.id)).toEqual([low.id]);

    const sum = ex.exceptionSummary(s, OPS, { now: NOW });
    expect(sum.open).toBe(2);
    expect(sum.unassigned).toBe(2);
    expect(sum.bySeverity.Critical).toBe(1);
    expect(sum.byType['Seal Broken']).toBe(1);
    expect(sum.oldest.exception.id).toBe(low.id);
    ex.resolveException(s, low.id, { resolution: 'Recounted, all present.' }, ctx(OPS));
    expect(ex.exceptionSummary(s, OPS, { now: NOW }).open).toBe(1);
    expect(ex.exceptionQueue(s, OPS, { now: NOW }).map((r) => r.exception.id)).not.toContain(low.id);
    expect(ex.exceptionQueue(s, OPS, { now: NOW, includeClosed: true }).map((r) => r.exception.id)).toContain(low.id);
  });
});

describe('reports', () => {
  it('rolls up flights, bags, exceptions and scans for a time range', () => {
    const r = rep.opsReport(s, OPS, { now: NOW, sinceHours: 24 });
    expect(r.range.hours).toBe(24);
    expect(r.totals.flights).toBe(5);
    expect(r.totals.flightsCancelled).toBe(1);
    expect(r.totals.bags).toBe(16); // 8 on the cancelled flight + 2 each for the 4 pre-booked collections
    expect(r.bags.byStatus['Received at Warehouse']).toBe(8);
    expect(r.bags.byStatus.Declared).toBe(8);
    expect(r.checkin.byStatus.Assigned).toBe(4);
    expect(r.warehouse.held).toBe(0);
    expect(r.flights[0].flight.id).toBe(SV); // earliest cut-off first
    expect(r.exceptions.total).toBe(0);
    expect(r.scans.total).toBe(0);
  });

  it('counts a resolved exception and its resolution time inside the range', () => {
    const e = ex.raiseException(s, { type: 'Count Mismatch', bag_id: 'BAG-000001', flight_id: SV }, ctx(CHK1));
    ex.resolveException(s, e.id, { resolution: 'Recounted.' }, { user: OPS, now: NOW + 30 * 60e3 });
    const r = rep.opsReport(s, OPS, { now: NOW + H, sinceHours: 24 });
    expect(r.exceptions.open).toBe(0);
    expect(r.exceptions.resolvedInRange).toBe(1);
    expect(r.exceptions.avgResolutionMin).toBe(30);
  });

  it('bagLedger and toCsv produce a flat, quoted CSV', () => {
    const rows = rep.bagLedger(s, OPS, { flightId: 'FLT-SV-1944' });
    expect(rows).toHaveLength(8);
    expect(rows[0]).toMatchObject({ status: 'Received at Warehouse', flight: 'SV 1944' });
    const csv = rep.toCsv(['bag_id', 'status', 'traveler'], rows);
    expect(csv.split('\r\n')).toHaveLength(9);
    expect(csv.startsWith('bag_id,status,traveler\r\n')).toBe(true);
    expect(rep.toCsv(['a'], [{ a: 'x,"y"' }])).toBe('a\r\n"x,""y"""');
  });

  it('only the roles with report:read may run one', () => {
    expect(() => rep.opsReport(s, CHK1, { now: NOW })).toThrow(PermissionError);
    expect(() => rep.opsReport(s, WM, { now: NOW })).toThrow(PermissionError);
    expect(() => rep.bagLedger(s, MON, {})).toThrow(PermissionError);
    const ADM = s.users.find((u) => u.id === 'ADM-001');
    expect(rep.opsReport(s, ADM, { now: NOW }).totals.bags).toBe(rep.opsReport(s, OPS, { now: NOW }).totals.bags);
    expect(rep.exceptionLedger(s, OPS)).toEqual([]);
  });
});
