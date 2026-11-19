/**
 * Loading — screened bags onto the airport truck. One scan per hand-off: the Rabel internal label,
 * once, as each bag goes on. The truck itself is dispatched by the Transport Manager; the warehouse
 * asks for one here and closes the load when the truck is full.
 */
import { S, user, run, runScan, chip, esc } from '../data.js';
import * as wh from '../../../shared/services/warehouseService.js';
import { createScanner } from '../../../shared/ui/scanner.js';
import { fmtCountdown, fmtDateTime, openModal, toast } from '../ui.js';

let el = null;
let scanner = null;
let tripId = null;

export function render(params, app) { el = app; draw(); return { destroy, poll: () => { if (!tripId) draw(); }, refresh: draw }; }
export function destroy() { scanner?.destroy(); scanner = null; el = null; tripId = null; }

function waitingHtml(groups) {
  if (!groups.length) return '<div class="state-block"><p>No screened bags are waiting. Screen bags first — see <a href="#/screening">Screening</a>.</p></div>';
  return `<div class="stack gap-3">${groups.map((g) => `<div class="card stack gap-2">
    <div class="row gap-2 wrap" style="align-items:center">
      <strong>${esc(g.flight?.code || 'Unknown flight')}</strong>${g.priority <= 3 ? chip(`P${g.priority}`, 'blue') : ''}
      <span class="fs-sm muted">cut-off ${g.flight?.cut_off_at ? esc(fmtCountdown(g.flight.cut_off_at)) : '—'}</span>
      <span class="grow"></span>${chip(`${g.bags.length} screened`, 'green')}
    </div>
    <div class="fs-xs mono muted">${g.bags.map((b) => esc(b.tag_no)).join(' · ')}</div>
  </div>`).join('')}</div>`;
}

function truckHtml(trip) {
  const onBoard = S().bags.filter((b) => trip.bag_ids.includes(b.id));
  return `<div class="card stack gap-3">
    <div class="row gap-2 wrap" style="align-items:center">
      <h2 class="section-title" style="margin:0">${esc(trip.truck_id)} — airport run</h2>
      ${chip(trip.status === 'Loaded' ? 'Load closed' : 'Loading', trip.status === 'Loaded' ? 'green' : 'amber')}
      <span class="fs-sm muted">${esc(S().drivers.find((d) => d.id === trip.driver_id)?.name || '')} · dispatched ${esc(fmtDateTime(trip.dispatched_at))}</span>
    </div>
    ${trip.status === 'Dispatched' ? '<div id="scanner-host"></div>' : `<p class="fs-sm">Closed at ${esc(fmtDateTime(trip.loaded_at))}. Transport drives it to the airport.</p>`}
    <div id="onboard-host">${onBoardHtml(onBoard)}</div>
    ${trip.status === 'Dispatched' ? `<div class="row gap-2 wrap">
      <button type="button" class="btn btn-primary btn-lg" id="close-load" ${trip.bag_ids.length ? '' : 'disabled'}>Close the load (${trip.bag_ids.length})</button>
      <span class="fs-xs muted">Closing tells Transport and the Airport Coordinator what is on board.</span></div>` : ''}
  </div>`;
}

function onBoardHtml(onBoard) {
  if (!onBoard.length) return '<p class="fs-sm muted">Nothing on board yet. Scan a Rabel label to load the first bag.</p>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>#</th><th>Rabel label</th><th>Airline tag</th><th>Flight</th></tr></thead>
    <tbody>${onBoard.map((b, i) => `<tr><td class="num">${i + 1}</td><td class="mono fs-sm">${esc(b.tag_no)}</td>
      <td class="mono fs-sm">${esc(b.airline_tag_no || 'No airline tag')}</td>
      <td>${esc(S().flights.find((f) => f.id === b.flight_id)?.code || '—')}</td></tr>`).join('')}</tbody></table></div>`;
}

function draw() {
  if (!el) return;
  scanner?.destroy(); scanner = null;
  let q;
  try { q = wh.loadingQueue(S(), user(), { now: Date.now() }); } catch (err) {
    el.innerHTML = `<div class="state-block error-state"><p>${esc(err.message)}</p></div>`;
    return;
  }
  const trip = q.trips[0] || null;
  tripId = trip?.status === 'Dispatched' ? trip.id : null;
  el.innerHTML = `
    <div class="page-header">
      <div><h1 class="page-title">Loading</h1><p class="page-subtitle" id="waiting-count">${q.waiting} screened bag(s) waiting for the airport</p></div>
      ${trip ? '' : '<button type="button" class="btn btn-primary" id="request-truck">Request an airport truck</button>'}
    </div>
    ${trip ? truckHtml(trip) : ''}
    <h2 class="section-title" style="margin-block-start:var(--s6)">Waiting for the airport</h2>
    <div id="waiting-host">${waitingHtml(q.groups)}</div>`;

  el.querySelector('#request-truck')?.addEventListener('click', askForTruck);

  if (tripId) {
    scanner = createScanner(el.querySelector('#scanner-host'), {
      hint: 'Scan Rabel label',
      onScan: (scan) => {
        const r = runScan((s, c) => wh.scanBagToAirportTruck(s, tripId, scan, c));
        const t = S().trips.find((x) => x.id === tripId);
        const host = el?.querySelector('#onboard-host');
        if (host && t) host.innerHTML = onBoardHtml(S().bags.filter((b) => t.bag_ids.includes(b.id)));
        const btn = /** @type {HTMLButtonElement} */ (el?.querySelector('#close-load'));
        if (btn && t) { btn.disabled = !t.bag_ids.length; btn.textContent = `Close the load (${t.bag_ids.length})`; }
        // the loaded bag has left the waiting queue — keep that list honest without losing scanner focus
        const again = wh.loadingQueue(S(), user(), { now: Date.now() });
        const waitingHost = el?.querySelector('#waiting-host');
        if (waitingHost) waitingHost.innerHTML = waitingHtml(again.groups);
        const countEl = el?.querySelector('#waiting-count');
        if (countEl) countEl.textContent = `${again.waiting} screened bag(s) waiting for the airport`;
        return { ok: r.ok, message: r.message };
      },
    });
    el.querySelector('#close-load')?.addEventListener('click', () => {
      run((s, c) => wh.closeAirportLoad(s, tripId, c), (t) => `${t.bag_ids.length} bag(s) on their way to the airport.`, draw);
    });
  }
}

function askForTruck() {
  const close = openModal({
    title: 'Request an airport truck',
    bodyHtml: `<p class="fs-sm">Transport will dispatch a driver and truck to the dock. Add anything they need to know.</p>
      <div class="field"><label for="truck-note">Note (optional)</label><input id="truck-note" type="text" placeholder="e.g. Bay 2, 40 bags" /></div>
      <div class="modal-actions"><button type="button" class="btn btn-secondary" data-act="close">Cancel</button>
        <button type="button" class="btn btn-primary" id="send-request">Send the request</button></div>`,
    onMount: (overlay) => {
      overlay.querySelector('#send-request').addEventListener('click', () => {
        const note = /** @type {HTMLInputElement} */ (overlay.querySelector('#truck-note')).value;
        close();
        const r = run((s, c) => wh.requestAirportTruck(s, { note }, c));
        if (r) toast(`Transport notified — ${r.bags} bag(s) ready.`, 'success');
        draw();
      });
      /** @type {HTMLElement} */ (overlay.querySelector('#truck-note')).focus();
    },
  });
}
