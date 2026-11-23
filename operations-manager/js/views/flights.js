/**
 * Flights — the Ops home. One row per flight with its 12-hour window, where its bags are and
 * what is late; plus the three things only Ops can do: add a flight, cancel one (which calls off
 * the collections that have not happened and tells everyone), and rebook held bags.
 */
import { S, run, read, chip, flightColor, levelColor, untilText } from '../data.js';
import * as fl from '../../../shared/services/flightService.js';
import { esc, fmtDateTime, openDrawer, closeDrawer, confirmDialog, emptyState } from '../ui.js';
import { navigate } from '../router.js';

let el = null;
let timer = null;
let filter = 'live';

export function render(params, app) {
  el = app;
  draw();
  timer = setInterval(draw, 60000);
  if (params?.id) setTimeout(() => openDetail(params.id), 0);
  return { destroy, refresh: draw, poll: draw };
}
export function destroy() { el = null; if (timer) clearInterval(timer); timer = null; }

const stageLabel = { before: 'Window not open', collection: 'Residence collection', warehouse: 'Warehouse', drive: 'Airport run', after: 'Past cut-off' };

function stageBar(c) {
  const parts = [
    { n: c.withTraveler, cls: 'seg-declared', label: 'with traveler' },
    { n: c.inTransit, cls: 'seg-moving', label: 'in the line' },
    { n: c.atAirport, cls: 'seg-airport', label: 'at the airport' },
    { n: c.loaded, cls: 'seg-done', label: 'on the aircraft' },
    { n: c.held + c.rebooked + c.returned, cls: 'seg-side', label: 'held / rebooked / returned' },
  ].filter((p) => p.n > 0);
  const total = parts.reduce((n, p) => n + p.n, 0) || 1;
  return `<div class="stage-bar" role="img" aria-label="${parts.map((p) => `${p.n} ${p.label}`).join(', ') || 'no bags'}">
    ${parts.map((p) => `<span class="${p.cls}" style="flex:${p.n / total}" title="${p.n} ${p.label}"></span>`).join('') || '<span class="seg-empty" style="flex:1"></span>'}
  </div>`;
}

function row(r) {
  const f = r.flight;
  const alert = r.alerts.find((a) => a.level === 'red') || r.alerts[0] || null;
  return `<article class="flight-row ${alert ? `alert-${alert.level}` : ''}">
    <div class="row wrap" style="justify-content:space-between;align-items:flex-start;gap:var(--s3)">
      <div>
        <h2 class="fs-lg" style="margin:0">${esc(f.code || f.id)}
          <span class="fs-sm muted fw-medium">${esc(f.route || '')}</span></h2>
        <div class="fs-sm muted">${esc(r.airline?.name || f.airline_code || '')} · cut-off ${esc(fmtDateTime(f.cut_off_at))} (${esc(untilText(f.cut_off_at))})</div>
      </div>
      <div class="row gap-2 wrap">
        ${chip(f.status, flightColor(f.status))}
        ${r.priorityRank ? chip(`P${r.priorityRank}`, 'blue') : ''}
        ${alert ? chip(alert.level === 'red' ? 'Red' : 'Amber', levelColor(alert.level)) : (f.cut_off_at && !['Cancelled', 'Completed'].includes(f.status) ? chip('On schedule', 'green') : '')}
      </div>
    </div>
    ${stageBar(r.counts)}
    <div class="fs-sm muted">
      ${r.counts.total} bag(s) · ${r.counts.withTraveler} with travelers · ${r.counts.inTransit} in the line · ${r.counts.atAirport} at the airport ·
      ${r.counts.loaded} on the aircraft${r.counts.held ? ` · ${r.counts.held} held` : ''}${r.counts.rebooked ? ` · ${r.counts.rebooked} awaiting re-tag` : ''}
      ${r.stage ? ` · stage: ${esc(stageLabel[r.stage])}` : ''}
    </div>
    ${alert ? `<div class="fs-sm level-${alert.level}">${esc(alert.message)}</div>` : ''}
    ${f.status === 'Cancelled' ? `<div class="fs-sm">${chip('Cancelled', 'red')} ${esc(f.cancel_reason || '')}</div>` : ''}
    <div class="row gap-2 wrap">
      <button type="button" class="btn btn-secondary" data-detail="${esc(f.id)}">Bags &amp; details</button>
      ${!['Cancelled', 'Completed'].includes(f.status) ? `<button type="button" class="btn btn-ghost" data-edit="${esc(f.id)}">Edit cut-off</button>` : ''}
      ${!['Cancelled', 'Completed'].includes(f.status) ? `<button type="button" class="btn btn-ghost" data-cancel="${esc(f.id)}">Cancel flight</button>` : ''}
      ${r.counts.held ? `<button type="button" class="btn btn-primary" data-rebook="${esc(f.id)}">Rebook ${r.counts.held} held bag(s)</button>` : ''}
      ${f.status === 'Cancelled' || (r.counts.total > 0 && r.counts.toMove === 0) ? `<a class="btn btn-ghost" href="#/closure/${esc(f.id)}">Closure</a>` : ''}
    </div>
  </article>`;
}

function draw() {
  if (!el) return;
  const rows = read((s, u) => fl.listFlights(s, u, { now: Date.now() }), []) || [];
  const shown = rows.filter((r) => (filter === 'all' ? true
    : filter === 'live' ? !['Cancelled', 'Completed'].includes(r.flight.status)
      : r.flight.status === (filter === 'cancelled' ? 'Cancelled' : 'Completed')));
  el.innerHTML = `
    <div class="page-header">
      <div><h1 class="page-title">Flights</h1><p class="page-subtitle">Every flight against its 12-hour window — the last 2 hours are the drive to the airport</p></div>
      <button type="button" class="btn btn-primary" id="new-flight">New flight</button>
    </div>
    <div class="segmented" role="tablist" aria-label="Filter flights">
      ${[['live', 'Live'], ['cancelled', 'Cancelled'], ['completed', 'Closed'], ['all', 'All']].map(([k, label]) => `
        <button type="button" class="tab ${filter === k ? 'is-active' : ''}" role="tab" aria-selected="${filter === k}" data-filter="${k}">${label}</button>`).join('')}
    </div>
    <div class="stack gap-3 mt">${shown.map(row).join('') || emptyState({ message: 'No flights in this view.' })}</div>`;

  el.querySelector('#new-flight').addEventListener('click', openCreate);
  el.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { filter = b.getAttribute('data-filter'); draw(); }));
  el.querySelectorAll('[data-detail]').forEach((b) => b.addEventListener('click', () => openDetail(b.dataset.detail)));
  el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openEdit(b.dataset.edit)));
  el.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => openCancel(b.dataset.cancel)));
  el.querySelectorAll('[data-rebook]').forEach((b) => b.addEventListener('click', () => openRebook(b.dataset.rebook)));
}

/* ───────────────────────── new flight ───────────────────────── */

function openCreate() {
  const airlines = S().airlines;
  const d = openDrawer({
    title: 'New flight',
    bodyHtml: `
      <div class="field"><label for="f-code">Flight code <span class="req">*</span></label>
        <input id="f-code" placeholder="SV 1821" autocomplete="off" /><div class="fs-xs muted">Two letters or digits, then the number.</div></div>
      <div class="field"><label for="f-airline">Airline <span class="req">*</span></label>
        <select id="f-airline">${airlines.map((a) => `<option value="${esc(a.code)}">${esc(a.code)} — ${esc(a.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="f-route">Route</label><input id="f-route" placeholder="JED → CGK" /></div>
      <div class="field"><label for="f-cut">Baggage cut-off <span class="req">*</span></label>
        <input id="f-cut" type="datetime-local" />
        <div class="fs-xs muted">The 12-hour window ends here: 8 h collection, 2 h warehouse, 2 h drive.</div></div>`,
    footerHtml: '<button type="button" class="btn btn-primary" id="f-go">Create flight</button>',
  });
  d.el.querySelector('#f-go').addEventListener('click', () => {
    const cut = /** @type {HTMLInputElement} */ (d.el.querySelector('#f-cut')).value;
    run((s, c) => fl.createFlight(s, {
      code: /** @type {HTMLInputElement} */ (d.el.querySelector('#f-code')).value,
      airline_code: /** @type {HTMLSelectElement} */ (d.el.querySelector('#f-airline')).value,
      route: /** @type {HTMLInputElement} */ (d.el.querySelector('#f-route')).value,
      cut_off_at: cut ? new Date(cut).toISOString() : '',
    }, c), (res) => `${res.flight.code} created with ${res.slotsCreated} collection slot(s).`, () => { closeDrawer(); draw(); });
  });
}

/* ───────────────────────── edit cut-off ───────────────────────── */

function openEdit(id) {
  const f = S().flights.find((x) => x.id === id);
  const local = f.cut_off_at ? new Date(f.cut_off_at).toISOString().slice(0, 16) : '';
  const d = openDrawer({
    title: `Edit ${f.code}`,
    bodyHtml: `
      <div class="field"><label for="e-route">Route</label><input id="e-route" value="${esc(f.route || '')}" /></div>
      <div class="field"><label for="e-cut">Baggage cut-off</label><input id="e-cut" type="datetime-local" value="${esc(local)}" />
        <div class="fs-xs muted">Moving this moves the whole window. Any booked slot left outside it is reported, and those travelers are asked to pick a new one.</div></div>`,
    footerHtml: '<button type="button" class="btn btn-primary" id="e-go">Save</button>',
  });
  d.el.querySelector('#e-go').addEventListener('click', () => {
    const cut = /** @type {HTMLInputElement} */ (d.el.querySelector('#e-cut')).value;
    run((s, c) => fl.updateFlight(s, id, {
      route: /** @type {HTMLInputElement} */ (d.el.querySelector('#e-route')).value,
      ...(cut && new Date(cut).toISOString() !== f.cut_off_at ? { cut_off_at: new Date(cut).toISOString() } : {}),
    }, c), (res) => (res.slotsOutsideWindow.length
      ? `Saved. ${res.slotsOutsideWindow.length} collection(s) are outside the new window — those travelers were asked to re-pick.`
      : 'Saved.'), () => { closeDrawer(); draw(); });
  });
}

/* ───────────────────────── cancel ───────────────────────── */

function openCancel(id) {
  const f = S().flights.find((x) => x.id === id);
  const d = openDrawer({
    title: `Cancel ${f.code}`,
    bodyHtml: `
      <p class="text-2">Cancelling calls off every collection that has not happened yet, frees those slots, and notifies every role and every affected traveler.
      Bags already in the line are <strong>not</strong> moved here — they appear in the Warehouse Manager's holding queue to be racked.</p>
      <div class="field"><label for="c-why">Reason <span class="req">*</span></label>
        <textarea id="c-why" rows="3" placeholder="Airline cancelled the departure (operational)."></textarea></div>`,
    footerHtml: '<button type="button" class="btn btn-danger" id="c-go">Cancel flight</button>',
  });
  d.el.querySelector('#c-go').addEventListener('click', async () => {
    const reason = /** @type {HTMLTextAreaElement} */ (d.el.querySelector('#c-why')).value;
    if (!(await confirmDialog({ title: `Cancel ${f.code}?`, body: 'This cannot be undone from here.', confirmLabel: 'Cancel flight', danger: true, requireText: f.code }))) return;
    run((s, c) => fl.cancelFlight(s, id, { reason }, c),
      (res) => `${f.code} cancelled — ${res.assignmentsCancelled.length} collection(s) called off, ${res.bagsToHold.length} bag(s) to move to holding, ${res.travelersNotified} traveler(s) notified.`,
      () => { closeDrawer(); draw(); });
  });
}

/* ───────────────────────── rebook ───────────────────────── */

function openRebook(id) {
  const s = S();
  const held = s.bags.filter((b) => b.flight_id === id && b.status === 'Held – Cancelled Flight');
  const targets = s.flights.filter((f) => f.id !== id && !['Cancelled', 'Completed'].includes(f.status) && f.cut_off_at)
    .sort((a, b) => String(a.cut_off_at).localeCompare(String(b.cut_off_at)));
  const nameOf = (b) => s.travelers.find((t) => t.id === b.traveler_id)?.name || b.traveler_id;
  const d = openDrawer({
    title: 'Rebook held bags',
    large: true,
    bodyHtml: `
      <div class="field"><label for="r-flight">New flight <span class="req">*</span></label>
        <select id="r-flight">${targets.map((f) => `<option value="${esc(f.id)}">${esc(f.code)} — ${esc(f.route || '')} (cut-off ${esc(fmtDateTime(f.cut_off_at))})</option>`).join('')}</select></div>
      <p class="fs-sm muted">Each bag goes to <strong>Rebooked</strong> and needs a NEW tag from Backend before the warehouse can release it back to loading.</p>
      <div class="table-wrap"><table><thead><tr>
        <th><input type="checkbox" id="r-all" aria-label="Select every bag" checked /></th><th>Bag</th><th>Traveler</th><th>Rack</th></tr></thead>
        <tbody>${held.map((b) => `<tr>
          <td><input type="checkbox" data-bag="${esc(b.id)}" checked /></td>
          <td class="mono">${esc(b.tag_no || b.id)}</td><td>${esc(nameOf(b))}</td><td>${esc(b.holding_rack || '—')}</td></tr>`).join('')}</tbody></table></div>`,
    footerHtml: '<button type="button" class="btn btn-primary" id="r-go">Rebook selected</button>',
  });
  const all = /** @type {HTMLInputElement} */ (d.el.querySelector('#r-all'));
  all.addEventListener('change', () => d.el.querySelectorAll('[data-bag]').forEach((cb) => { /** @type {HTMLInputElement} */ (cb).checked = all.checked; }));
  d.el.querySelector('#r-go').addEventListener('click', () => {
    const bagIds = [...d.el.querySelectorAll('[data-bag]')].filter((cb) => /** @type {HTMLInputElement} */ (cb).checked).map((cb) => cb.getAttribute('data-bag'));
    run((st, c) => fl.rebookBags(st, { bagIds, newFlightId: /** @type {HTMLSelectElement} */ (d.el.querySelector('#r-flight')).value }, c),
      (res) => `${res.rebooked.length} bag(s) rebooked${res.skipped.length ? `, ${res.skipped.length} skipped` : ''}. Backend has been asked for new tags.`,
      () => { closeDrawer(); draw(); });
  });
}

/* ───────────────────────── detail ───────────────────────── */

function openDetail(id) {
  const d = read((s, u) => fl.flightDetail(s, id, u, { now: Date.now() }), null);
  if (!d) return;
  const f = d.flight;
  openDrawer({
    title: `${f.code} — ${d.counts.total} bag(s)`,
    large: true,
    bodyHtml: `
      <div class="stack gap-2">
        <div class="fs-sm muted">${esc(d.airline?.name || '')} · ${esc(f.route || '')} · cut-off ${esc(fmtDateTime(f.cut_off_at))}</div>
        ${d.window ? `<div class="fs-sm">Collection ${esc(fmtDateTime(d.window.collection.start))} → ${esc(fmtDateTime(d.window.collection.end))} · warehouse until ${esc(fmtDateTime(d.window.warehouse.end))} · at the airport by ${esc(fmtDateTime(d.window.redAt))}</div>` : ''}
        ${d.rebookedTo ? `<div class="fs-sm">${chip(`Rebooked to ${d.rebookedTo.code}`, 'amber')}</div>` : ''}
        ${d.alerts.map((a) => `<div class="fs-sm level-${a.level}">${esc(a.message)}</div>`).join('')}
        ${d.exceptions.length ? `<div class="fs-sm">${chip(`${d.exceptions.length} open exception(s)`, 'red')} <a href="#/exceptions">Work them</a></div>` : ''}
      </div>
      <div class="table-wrap mt"><table><thead><tr><th>Bag</th><th>Airline tag</th><th>Traveler</th><th>Area</th><th>Status</th></tr></thead>
        <tbody>${d.bags.map((b) => `<tr>
          <td class="mono">${esc(b.bag.tag_no || b.bag.id)}</td>
          <td class="mono">${esc(b.bag.airline_tag_no || '—')}</td>
          <td>${esc(b.traveler?.name || '—')}</td>
          <td>${esc(b.area?.name || '—')}</td>
          <td>${esc(b.bag.status)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No bags declared yet.</td></tr>'}</tbody></table></div>`,
    footerHtml: `<a class="btn btn-secondary" href="#/closure/${esc(f.id)}">Closure checklist</a>`,
    onClose: () => { if ((location.hash || '').startsWith('#/flights/')) navigate('#/'); return true; },
  });
}
