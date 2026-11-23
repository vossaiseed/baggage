import { describe, it, expect } from 'vitest';
import { windowFor, stageAt, collectionSlotWindows, slotInsideCollectionWindow, forecast, computeAlerts } from '../../shared/time/window.js';
import { makeFlight } from '../../shared/models.js';

const H = 3600e3;
const NOW = new Date('2026-06-01T06:00:00Z').getTime();
const at = (h) => new Date(NOW + h * H).toISOString();

describe('12-hour window', () => {
  it('splits into 8 h collection, 2 h warehouse, 2 h drive ending at cut-off', () => {
    const w = windowFor(at(12));
    expect(w.start).toBe(at(0));
    expect(w.collection).toEqual({ start: at(0), end: at(8) });
    expect(w.warehouse).toEqual({ start: at(8), end: at(10) });
    expect(w.drive).toEqual({ start: at(10), end: at(12) });
    expect(w.redAt).toBe(new Date(NOW + 11.5 * H).toISOString());
  });
  it('makeFlight derives window_start_at = cut-off − 12 h', () => {
    expect(makeFlight({ id: 'F', cut_off_at: at(12) }).window_start_at).toBe(at(0));
  });
  it('stageAt', () => {
    const c = at(12);
    expect([stageAt(at(-1), c), stageAt(at(1), c), stageAt(at(9), c), stageAt(at(11), c), stageAt(at(13), c)]).toEqual(['before', 'collection', 'warehouse', 'drive', 'after']);
  });
  it('offers four 2-hour slots, all inside the 8 h collection window', () => {
    const slots = collectionSlotWindows(at(12));
    expect(slots).toHaveLength(4);
    expect(slots.every((s) => slotInsideCollectionWindow(s, at(12)))).toBe(true);
    expect(slotInsideCollectionWindow({ start: at(7), end: at(9) }, at(12))).toBe(false);
  });
});

describe('24-hour forecast & priority', () => {
  const f = (id, h, extra = {}) => ({ id, cut_off_at: at(h), status: 'Scheduled', ...extra });
  const bags = (flight, n, status = 'Declared') => Array.from({ length: n }, (_, i) => ({ id: `${flight}-${i}`, flight_id: flight, status }));

  it('ranks earliest cut-off first, tie -> more bags still to move', () => {
    const r = forecast([f('C', 10), f('A', 5), f('B', 5)], [...bags('A', 2), ...bags('B', 7), ...bags('C', 1)], NOW);
    expect(r.map((x) => [x.id, x.priority_rank])).toEqual([['B', 1], ['A', 2], ['C', 3]]);
  });
  it('accounted bags do not count towards "still to move"', () => {
    const r = forecast([f('A', 5), f('B', 5)], [...bags('A', 5, 'Loaded on Aircraft'), ...bags('B', 1)], NOW);
    expect(r[0].id).toBe('B');
  });
  it('excludes flights beyond 24 h, in the past, cancelled and completed', () => {
    const r = forecast([f('far', 25), f('past', -1), f('x', 3, { status: 'Cancelled' }), f('y', 3, { status: 'Completed' }), f('ok', 24)], [], NOW);
    expect(r.map((x) => x.id)).toEqual(['ok']);
  });
});

describe('alerts', () => {
  const flight = { id: 'F', cut_off_at: at(12), status: 'Scheduled' };
  const bag = (status) => ({ id: Math.random().toString(), flight_id: 'F', status });

  it('no alert while on time', () => expect(computeAlerts(at(3), flight, [bag('Declared')])).toEqual([]));
  it('amber when collection is past its 8 h slot with bags not yet on a collection truck', () => {
    const a = computeAlerts(at(8.5), flight, [bag('Checked-in'), bag('Loaded to Collection Truck')]);
    expect(a).toEqual([expect.objectContaining({ level: 'amber', stage: 'collection', count: 1 })]);
  });
  it('red when bags are not at the airport by cut-off − 30 min', () => {
    expect(computeAlerts(at(11.4), flight, [bag('In Transit to Airport')]).some((x) => x.level === 'red')).toBe(false);
    const a = computeAlerts(at(11.5), flight, [bag('In Transit to Airport'), bag('Received at Airport')]);
    expect(a.find((x) => x.level === 'red')).toMatchObject({ count: 1 });
  });
  it('cancelled flights raise no alerts', () => expect(computeAlerts(at(11.9), { ...flight, status: 'Cancelled' }, [bag('Declared')])).toEqual([]));
});
