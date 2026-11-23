/**
 * 12-hour window + 24-hour forecast rules (pure functions; pass `now` in).
 *
 *   cut-off −12h ─ collection 8h ─ −4h ─ warehouse 2h ─ −2h ─ drive 2h ─ cut-off
 */
import { WINDOW, BAG_STATUSES, ACCOUNTED_STATUSES } from '../constants.js';

const H = 3600e3;
const M = 60e3;
const ms = (d) => new Date(d).getTime();
const iso = (n) => new Date(n).toISOString();

/**
 * @param {string|Date} cutOffAt
 * @returns {{ cutOff:string, start:string, collection:{start:string,end:string}, warehouse:{start:string,end:string}, drive:{start:string,end:string}, redAt:string }}
 */
export function windowFor(cutOffAt) {
  const c = ms(cutOffAt);
  const start = c - WINDOW.totalHours * H;
  const colEnd = start + WINDOW.collectionHours * H;
  const whEnd = colEnd + WINDOW.warehouseHours * H;
  return {
    cutOff: iso(c), start: iso(start),
    collection: { start: iso(start), end: iso(colEnd) },
    warehouse: { start: iso(colEnd), end: iso(whEnd) },
    drive: { start: iso(whEnd), end: iso(c) },
    redAt: iso(c - WINDOW.redBeforeCutoffMin * M),
  };
}

/** @returns {'before'|'collection'|'warehouse'|'drive'|'after'} */
export function stageAt(now, cutOffAt) {
  const w = windowFor(cutOffAt);
  const t = ms(now);
  if (t < ms(w.start)) return 'before';
  if (t < ms(w.collection.end)) return 'collection';
  if (t < ms(w.warehouse.end)) return 'warehouse';
  if (t < ms(w.cutOff)) return 'drive';
  return 'after';
}

/**
 * 2-hour collection slots, only inside the flight's 8-hour collection window.
 * @param {string|Date} cutOffAt @returns {{start:string,end:string}[]}
 */
export function collectionSlotWindows(cutOffAt) {
  const w = windowFor(cutOffAt);
  const out = [];
  for (let t = ms(w.collection.start); t < ms(w.collection.end); t += WINDOW.slotHours * H) {
    out.push({ start: iso(t), end: iso(t + WINDOW.slotHours * H) });
  }
  return out;
}

/** Is a slot fully inside the collection window? */
export function slotInsideCollectionWindow(slot, cutOffAt) {
  const w = windowFor(cutOffAt);
  return ms(slot.start) >= ms(w.collection.start) && ms(slot.end) <= ms(w.collection.end);
}

/** Bags not yet accounted for / not yet past a given status. */
function stillToMove(bags) {
  return bags.filter((b) => !ACCOUNTED_STATUSES.includes(b.status)).length;
}

/**
 * 24-hour forecast: flights with a cut-off in the next 24 h (cancelled/completed excluded),
 * earliest cut-off first; tie -> more bags still to move; then id (stable).
 * @param {object[]} flights @param {object[]} bags @param {Date|string|number} now
 * @returns {object[]} flights with `priority_rank` (1 = most urgent) and `bags_to_move`
 */
export function forecast(flights, bags, now) {
  const t = ms(now);
  const toMove = new Map();
  for (const b of bags || []) {
    if (!toMove.has(b.flight_id)) toMove.set(b.flight_id, []);
    toMove.get(b.flight_id).push(b);
  }
  return (flights || [])
    .filter((f) => f.cut_off_at && !['Cancelled', 'Completed'].includes(f.status))
    .filter((f) => ms(f.cut_off_at) > t && ms(f.cut_off_at) <= t + WINDOW.forecastHours * H)
    .map((f) => ({ ...f, bags_to_move: stillToMove(toMove.get(f.id) || []) }))
    .sort((a, b) => ms(a.cut_off_at) - ms(b.cut_off_at) || b.bags_to_move - a.bags_to_move || String(a.id).localeCompare(String(b.id)))
    .map((f, i) => ({ ...f, priority_rank: i + 1 }));
}

/**
 * Stage deadlines: by the end of each stage, bags must have reached a status.
 * Amber = a stage is past its slot. Red = bags not at the airport by cut-off − 30 min.
 * @param {Date|string|number} now @param {object} flight @param {object[]} bags
 * @returns {{level:string, stage:string, count:number, message:string}[]}
 */
export function computeAlerts(now, flight, bags) {
  if (!flight?.cut_off_at || ['Cancelled', 'Completed'].includes(flight.status)) return [];
  const t = ms(now);
  const w = windowFor(flight.cut_off_at);
  const live = (bags || []).filter((b) => b.flight_id === flight.id && !ACCOUNTED_STATUSES.includes(b.status) && BAG_STATUSES.includes(b.status));
  const below = (status) => live.filter((b) => BAG_STATUSES.indexOf(b.status) < BAG_STATUSES.indexOf(status)).length;
  const out = [];
  const rules = [
    { stage: 'collection', at: w.collection.end, needs: 'Loaded to Collection Truck', label: 'Residence collection is past its 8 h slot' },
    { stage: 'warehouse', at: w.warehouse.end, needs: 'In Transit to Airport', label: 'Warehouse stage is past its 2 h slot' },
  ];
  for (const r of rules) {
    if (t > ms(r.at)) {
      const n = below(r.needs);
      if (n > 0) out.push({ level: 'amber', stage: r.stage, count: n, message: `${r.label} — ${n} bag(s) behind` });
    }
  }
  if (t >= ms(w.redAt)) {
    const n = below('Received at Airport');
    if (n > 0) out.push({ level: 'red', stage: 'airport', count: n, message: `${n} bag(s) not at the airport by cut-off − ${WINDOW.redBeforeCutoffMin} min` });
  } else if (t > ms(w.drive.start)) {
    const n = below('Received at Airport');
    if (n > 0) out.push({ level: 'amber', stage: 'drive', count: n, message: `Airport run is past its 2 h slot — ${n} bag(s) not yet at the airport` });
  }
  return out;
}
