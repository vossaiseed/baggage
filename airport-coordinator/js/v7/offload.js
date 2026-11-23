/**
 * Departure — Offload: one Rabel internal-label scan per bag as it comes off the airport truck.
 * Nothing changes status until the count matches what the warehouse loaded; a short count raises a
 * High Count Mismatch and blocks the receipt. Cancelled-flight bags that reached the airport are
 * held here instead of being handed to the Authority.
 */
import { S, user, run, runScan, chip, esc, blockedHtml } from './data.js';
import * as ap from '../../../shared/services/airportService.js';
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
  const rows = ap.offloadQueue(S(), user(), { now: Date.now() });
  const cancelled = ap.cancelledAtAirport(S(), user());
  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">Offload</h1>
      <p class="page-subtitle">${rows.length} truck(s) open and ready to unload</p></div></div>
    ${rows.length ? `<div class="grid grid-cols-2 gap-3">${rows.map((r) => `
      <div class="card stack gap-2 ${r.trip.seal_check?.intact === false ? 'alert-red' : ''}">
        <div class="row gap-2 wrap" style="align-items:center"><strong class="fs-md">${esc(r.trip.truck_id)}</strong>
          ${r.trip.seal_check?.intact === false ? chip('Seal problem', 'red') : chip('Seal checked', 'green')}
          ${r.priority <= 3 ? chip(`P${r.priority}`, 'blue') : ''}</div>
        <div class="fs-sm">${esc(r.warehouse?.name || 'Warehouse')} · <strong>${r.trip.bag_ids.length}</strong> bag(s) · ${esc(r.flights.join(', ') || '—')}</div>
        <div class="fs-xs muted">${(r.trip.offload?.scanned_bag_ids || []).length} already scanned off · arrived ${esc(fmtDateTime(r.trip.arrived_at))}</div>
        <button type="button" class="btn btn-primary" data-open="${esc(r.trip.id)}">Offload this truck</button>
      </div>`).join('')}</div>`
    : '<div class="state-block"><p>Nothing to unload. A truck appears here once its seal has been checked — see <a href="#/dep/seal">Seal check</a>.</p></div>'}
    ${cancelled.length ? holdingHtml(cancelled) : ''}`;

  el.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => navigate(`#/dep/offload/${/** @type {HTMLElement} */ (b).dataset.open}`)));
  wireHolding();
}

/* ───────── cancelled flights standing here ───────── */

function holdingHtml(bags) {
  return `<h2 class="section-title" style="margin-block-start:var(--s6)">Cancelled flights at the airport</h2>
    <div class="card stack gap-3">
      <p class="fs-sm muted">These bags belong to a cancelled flight, so they are never handed to the Authority. Hold them together and record where, so they can go back on the return truck.</p>
      <div class="table-wrap"><table>
        <thead><tr><th><input type="checkbox" id="hold-all" aria-label="Select all" /></th><th>Rabel label</th><th>Airline tag</th><th>Flight</th></tr></thead>
        <tbody>${bags.map((b) => `<tr>
          <td><input type="checkbox" class="hold-pick" value="${esc(b.id)}" aria-label="Hold ${esc(b.tag_no)}" /></td>
          <td class="mono fs-sm">${esc(b.tag_no || '—')}</td><td class="mono fs-sm">${esc(b.airline_tag_no || 'No airline tag')}</td>
          <td>${esc(S().flights.find((f) => f.id === b.flight_id)?.code || '—')}</td></tr>`).join('')}</tbody></table></div>
      <div class="row gap-2 wrap">
        <input type="text" id="hold-rack" placeholder="Where are they held? e.g. Bay A rack 12" />
        <button type="button" class="btn btn-secondary" id="hold-go">Hold the selected bags</button>
      </div>
    </div>`;
}

function wireHolding() {
  const all = el.querySelector('#hold-all');
  all?.addEventListener('change', () => el.querySelectorAll('.hold-pick').forEach((c) => { /** @type {HTMLInputElement} */ (c).checked = /** @type {HTMLInputElement} */ (all).checked; }));
  el.querySelector('#hold-go')?.addEventListener('click', () => {
    const ids = [...el.querySelectorAll('.hold-pick')].filter((c) => /** @type {HTMLInputElement} */ (c).checked).map((c) => /** @type {HTMLInputElement} */ (c).value);
    const rack = /** @type {HTMLInputElement} */ (el.querySelector('#hold-rack')).value;
    run((s, c) => ap.holdCancelledBags(s, ids, { rack }, c), (r) => `${r.held} bag(s) held.`, draw);
  });
}

/* ───────── one truck ───────── */

function progressHtml() {
  const p = ap.offloadProgress(S(), tripId, user());
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
  if (!t) { el.innerHTML = '<div class="state-block"><p>Truck not found.</p><a class="btn btn-primary" href="#/dep/offload">Back to offload</a></div>'; return; }
  const warehouse = S().warehouses.find((w) => w.id === t.warehouse_id);
  const done = !!t.offload?.completed_at;
  const sealProblem = t.seal_check?.intact === false;

  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">${esc(t.truck_id)}</h1>
      <p class="page-subtitle">${esc(warehouse?.name || 'Warehouse')} → ${esc(t.airport_id || '')} · ${t.bag_ids.length} bag(s) on board ·
        ${chip(done ? 'Offloaded' : 'Unloading', done ? 'green' : 'amber')}</p></div></div>
    ${!t.seal_check ? `<div class="card alert-red stack gap-2"><h2 class="section-title">Check the seal first</h2>
        <p class="fs-sm">Nothing comes off ${esc(t.truck_id)} until its seal has been checked.</p>
        <a class="btn btn-primary" href="#/dep/seal">Go to the seal check</a></div>`
    : done ? `<div class="card stack gap-2"><h2 class="section-title">Offloaded</h2>
        <p class="fs-sm">${t.bag_ids.length} bag(s) are at the airport, received ${esc(fmtDateTime(t.offload.completed_at))}. The driver and truck are free again.</p>
        <div class="row gap-2 wrap"><a class="btn btn-primary" href="#/dep/handover">Hand over to the Authority</a>
        <button type="button" class="btn btn-secondary" id="return-trip">Send the empty truck back</button></div></div>`
      : `${sealProblem ? `<div class="card alert-red stack gap-1" style="margin-block-end:var(--s4)">
          <strong>Seal problem recorded${t.seal_check.exception_id ? ` (${esc(t.seal_check.exception_id)})` : ''}</strong>
          <span class="fs-sm">Ops has been told. Unload anyway, keep these bags together and do not mix them with another truck.</span></div>` : ''}
      <div class="card stack gap-3">
        <h2 class="section-title">Scan each Rabel label</h2>
        <p class="fs-sm muted">One scan per bag as it comes off. Duplicates and labels from another truck are refused.</p>
        <div id="scanner-host"></div>
      </div>
      <div class="card stack gap-2" style="margin-block-start:var(--s4)">
        <div id="progress-host">${progressHtml()}</div>
        <div class="row gap-2 wrap"><button type="button" class="btn btn-primary btn-lg" id="complete">Receive the bags at the airport</button>
        <span class="fs-xs muted">Advances every bag to “Received at Airport”. A short count is blocked.</span></div>
      </div>`}
    <a class="btn btn-ghost mt" href="#/dep/offload">&larr; Back to offload</a>`;

  el.querySelector('#return-trip')?.addEventListener('click', () => run((s, c) => ap.requestReturnTrip(s, tripId, {}, c), 'Transport has been asked to collect the empty truck.'));
  if (done || !t.seal_check) return;

  scanner = createScanner(el.querySelector('#scanner-host'), {
    hint: 'Scan Rabel label',
    onScan: (scan) => {
      const r = runScan((s, c) => ap.scanBagAtAirport(s, tripId, scan, c));
      const host = el?.querySelector('#progress-host');
      if (host) host.innerHTML = progressHtml();
      return { ok: r.ok, message: r.message };
    },
  });

  el.querySelector('#complete')?.addEventListener('click', () => {
    const r = run((s, c) => ap.completeOffload(s, tripId, c));
    if (!r) return;
    toast(r.ok ? `${r.received} bag(s) received at the airport.` : r.message, r.ok ? 'success' : 'error');
    drawTruck();
  });
}

function draw() {
  if (!el) return;
  const blocked = blockedHtml('No airport is assigned to this account, so no trucks arrive here.');
  if (blocked) { el.innerHTML = blocked; return; }
  try { if (tripId) drawTruck(); else drawQueue(); } catch (err) {
    el.innerHTML = `<div class="state-block error-state"><p>${esc(err.message)}</p><a class="btn btn-primary" href="#/dep/offload">Back to offload</a></div>`;
  }
}
