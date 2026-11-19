/**
 * Receiving — one scan per hand-off, as the rule says: the truck's QR once, then every Rabel internal
 * label once as the bags come off. Nothing changes status until the count matches the truck's load;
 * a short count raises a Count Mismatch exception and blocks the receipt.
 */
import { S, user, run, runScan, chip, esc } from '../data.js';
import * as wh from '../../../shared/services/warehouseService.js';
import { createScanner } from '../../../shared/ui/scanner.js';
import { fmtDateTime, toast } from '../ui.js';
import { navigate } from '../router.js';

let el = null;
let tripId = null;
let scanner = null;

export function render(params, app) {
  el = app;
  tripId = params.id || null;
  draw();
  return { destroy, poll: () => { if (!tripId) draw(); }, refresh: draw };
}
export function destroy() { scanner?.destroy(); scanner = null; el = null; tripId = null; }

const trip = () => S().trips.find((t) => t.id === tripId);

/* ───────── queue ───────── */

function drawQueue() {
  const rows = wh.receivingQueue(S(), user(), { now: Date.now() });
  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">Receiving</h1>
      <p class="page-subtitle">${rows.length} truck(s) at the gate</p></div></div>
    ${rows.length ? `<div class="grid grid-cols-2 gap-3">${rows.map((r) => `
      <div class="card stack gap-2">
        <div class="row gap-2" style="align-items:center"><strong class="fs-md">${esc(r.trip.truck_id)}</strong>${chip('At the gate', 'amber')}${r.priority <= 3 ? chip(`P${r.priority}`, 'blue') : ''}</div>
        <div class="fs-sm">${esc(r.area?.name || '')} · <strong>${r.bags}</strong> bag(s) · ${esc(r.driver?.name || '')}</div>
        <div class="fs-xs muted">Arrived ${esc(fmtDateTime(r.trip.arrived_at))}</div>
        <button type="button" class="btn btn-primary" data-open="${esc(r.trip.id)}">Start receiving</button>
      </div>`).join('')}</div>`
      : '<div class="state-block"><p>No trucks waiting. Trucks appear here once Transport marks them arrived at the gate — see <a href="#/upcoming">Upcoming</a>.</p></div>'}`;
  el.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => navigate(`#/receiving/${/** @type {HTMLElement} */ (b).dataset.open}`)));
}

/* ───────── one truck ───────── */

function progressHtml() {
  const p = wh.receivingProgress(S(), tripId, user());
  return `
    <div class="row gap-3 wrap mb">
      <strong class="fs-lg">${p.scanned.length} / ${p.expected.length}</strong>
      <span class="fs-sm muted">labels scanned off the truck</span>
      ${p.missing.length ? chip(`${p.missing.length} still on board`, 'amber') : chip('Count matches', 'green')}
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Rabel label</th><th>Airline tag</th><th>Flight</th><th>Status</th></tr></thead>
      <tbody>${p.expected.map((b) => {
    const done = p.scanned.some((x) => x.id === b.id);
    return `<tr><td class="mono fs-sm">${esc(b.tag_no || '—')}</td><td class="mono fs-sm">${esc(b.airline_tag_no || 'No airline tag')}</td>
      <td>${esc(S().flights.find((f) => f.id === b.flight_id)?.code || '—')}</td>
      <td>${done ? chip('Off the truck', 'green') : chip('Not scanned', 'grey')}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function drawTruck() {
  scanner?.destroy(); scanner = null;
  const t = trip();
  if (!t) { el.innerHTML = '<div class="state-block"><p>Truck not found.</p><a class="btn btn-primary" href="#/receiving">Back to receiving</a></div>'; return; }
  const area = S().collectionAreas.find((a) => a.id === t.area_from);
  const truckScanned = !!t.receiving?.truck_scan_at;
  const done = !!t.receiving?.completed_at;

  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">${esc(t.truck_id)}</h1>
      <p class="page-subtitle">${esc(area?.name || '')} → warehouse · ${t.bag_ids.length} bag(s) on board · ${chip(done ? 'Received' : truckScanned ? 'Unloading' : 'At the gate', done ? 'green' : 'amber')}</p></div></div>
    ${done ? `<div class="card stack gap-2"><h2 class="section-title">Received</h2>
        <p class="fs-sm">${t.bag_ids.length} bag(s) are in the warehouse. The 2-hour warehouse clock started at ${esc(fmtDateTime(t.receiving.completed_at))}.</p>
        <div class="row gap-2"><a class="btn btn-primary" href="#/screening">Go to screening</a><a class="btn btn-secondary" href="#/receiving">Next truck</a></div></div>`
    : `<div class="card stack gap-3">
        <h2 class="section-title">${truckScanned ? 'Scan each Rabel label' : 'Scan the truck QR code'}</h2>
        <p class="fs-sm muted">${truckScanned
      ? 'One scan per bag as it comes off. Duplicates and labels from another truck are refused.'
      : `Confirm this is ${esc(t.truck_id)} before anything comes off — bags are never counted against the wrong truck.`}</p>
        <div id="scanner-host"></div>
      </div>
      ${truckScanned ? `<div class="card stack gap-2" style="margin-block-start:var(--s4)"><div id="progress-host">${progressHtml()}</div>
        <div class="row gap-2 wrap"><button type="button" class="btn btn-primary btn-lg" id="complete">Receive the bags</button>
        <span class="fs-xs muted">Receiving advances every bag to “Received at Warehouse”. A short count is blocked.</span></div></div>` : ''}`}
    <a class="btn btn-ghost mt" href="#/receiving">&larr; Back to receiving</a>`;

  if (done) return;
  const host = el.querySelector('#scanner-host');
  scanner = createScanner(host, {
    hint: truckScanned ? 'Scan Rabel label' : 'Scan truck QR',
    onScan: (scan) => {
      if (!truckScanned) {
        const r = runScan((s, c) => wh.startReceiving(s, tripId, scan, c));
        if (r.ok) setTimeout(drawTruck, 600);
        return { ok: r.ok, message: r.message };
      }
      const r = runScan((s, c) => wh.scanBagAtWarehouse(s, tripId, scan, c));
      const ph = el?.querySelector('#progress-host');
      if (ph) ph.innerHTML = progressHtml();
      return { ok: r.ok, message: r.message };
    },
  });

  el.querySelector('#complete')?.addEventListener('click', () => {
    const r = run((s, c) => wh.completeReceiving(s, tripId, c));
    if (!r) return;
    toast(r.ok ? `${r.received} bag(s) received.` : r.message, r.ok ? 'success' : 'error');
    drawTruck();
  });
}

function draw() {
  if (!el) return;
  try { if (tripId) drawTruck(); else drawQueue(); } catch (err) {
    el.innerHTML = `<div class="state-block error-state"><p>${esc(err.message)}</p><a class="btn btn-primary" href="#/receiving">Back to receiving</a></div>`;
  }
}
