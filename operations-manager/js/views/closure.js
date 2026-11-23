/**
 * Closure — a flight closes only when every bag is accounted for (on the aircraft, held,
 * rebooked or returned) and no High/Critical exception is still open. Lower-severity
 * exceptions are shown as warnings and do not block it.
 */
import { run, read, chip, severityColor } from '../data.js';
import * as fl from '../../../shared/services/flightService.js';
import { esc, fmtDateTime, openDrawer, closeDrawer, emptyState, confirmDialog } from '../ui.js';
import { navigate } from '../router.js';

let el = null;
let selected = null;

export function render(params, app) { el = app; selected = params?.flightId || selected; draw(); return { destroy, refresh: draw, poll: draw }; }
export function destroy() { el = null; }

function candidateRow(r) {
  const f = r.flight;
  return `<tr>
    <td>${esc(f.code)}</td>
    <td>${esc(fmtDateTime(f.cut_off_at))}</td>
    <td>${chip(f.status, f.status === 'Cancelled' ? 'red' : f.status === 'Completed' ? 'green' : 'blue')}</td>
    <td class="num">${r.counts.total}</td>
    <td class="num">${r.counts.accounted}</td>
    <td class="num">${r.counts.toMove}</td>
    <td>${f.status === 'Completed' ? esc(fmtDateTime(f.completed_at)) : `<button type="button" class="btn btn-secondary" data-pick="${esc(f.id)}">Checklist</button>`}</td>
  </tr>`;
}

function checklistHtml(c) {
  const closed = c.flight.status === 'Completed';
  // A closed flight is not "not ready" — it is done; its only blocker is that it is already closed.
  const blockers = closed ? [] : c.blockers;
  return `
    <div class="stack gap-3">
      <div class="row gap-2 wrap">
        ${chip(c.flight.status, c.flight.status === 'Cancelled' ? 'red' : closed ? 'green' : 'blue')}
        ${closed ? '' : chip(c.canClose ? 'Ready to close' : 'Not ready', c.canClose ? 'green' : 'red')}
      </div>
      <div class="fs-sm muted">cut-off ${esc(fmtDateTime(c.flight.cut_off_at))} · ${c.counts.total} bag(s)</div>
      <div class="stat-list">
        <div><span class="k">On the aircraft</span><span class="v">${c.counts.loaded}</span></div>
        <div><span class="k">Held (cancelled flight)</span><span class="v">${c.counts.held}</span></div>
        <div><span class="k">Rebooked</span><span class="v">${c.counts.rebooked}</span></div>
        <div><span class="k">Returned to traveler</span><span class="v">${c.counts.returned}</span></div>
        <div><span class="k">Not accounted for</span><span class="v">${c.outstanding.length}</span></div>
      </div>
      ${blockers.length ? `<ul class="stack gap-1">${blockers.map((b) => `<li class="level-red fs-sm">${esc(b)}</li>`).join('')}</ul>` : ''}
      ${c.alerts.map((a) => `<div class="fs-sm level-${a.level}">${esc(a.message)}</div>`).join('')}
      ${c.outstanding.length ? `<div class="table-wrap"><table><thead><tr><th>Bag</th><th>Traveler</th><th>Status</th></tr></thead>
        <tbody>${c.outstanding.map((o) => `<tr><td class="mono">${esc(o.bag.tag_no || o.bag.id)}</td><td>${esc(o.traveler?.name || '—')}</td><td>${esc(o.bag.status)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${c.exceptions.length ? `<div class="stack gap-1">${c.exceptions.map((e) => `<div class="fs-sm">${chip(e.severity, severityColor(e.severity))} ${esc(e.type)} <span class="mono fs-xs muted">${esc(e.id)}</span> ${esc(e.notes || '')}</div>`).join('')}
        <a class="fs-sm" href="#/exceptions">Work the exceptions</a></div>` : ''}
    </div>`;
}

function draw() {
  if (!el) return;
  const rows = read((s, u) => fl.listFlights(s, u, { now: Date.now() }), []) || [];
  // Cancelled and closed flights always belong here; a live one only once it is past its
  // cut-off with nothing left to move (a future flight with no bags yet is not "ready").
  const now = Date.now();
  const closable = rows.filter((r) => ['Cancelled', 'Completed'].includes(r.flight.status)
    || (r.counts.total > 0 && r.counts.toMove === 0 && r.flight.cut_off_at && new Date(r.flight.cut_off_at).getTime() <= now));
  const c = selected ? read((s, u) => fl.closureChecklist(s, selected, u, { now: Date.now() }), null) : null;
  el.innerHTML = `
    <div class="page-header">
      <div><h1 class="page-title">Closure</h1><p class="page-subtitle">A flight closes when every bag is accounted for and nothing High or Critical is open</p></div>
    </div>
    ${c ? `<section class="card mb">
      <h2 class="section-title">${esc(c.flight.code)}</h2>
      ${checklistHtml(c)}
      <div class="row gap-2 wrap mt">
        ${c.flight.status === 'Completed'
    ? `${chip(`Closed ${fmtDateTime(c.flight.completed_at)}`, 'green')}${c.flight.closure_note ? `<span class="fs-sm muted">${esc(c.flight.closure_note)}</span>` : ''}`
    : `<button type="button" class="btn btn-primary" id="close-go" ${c.canClose ? '' : 'disabled'}>Close flight</button>`}
        <button type="button" class="btn btn-ghost" id="clear">Pick another flight</button>
      </div>
    </section>` : ''}
    <section class="card">
      <h2 class="section-title">Flights ready for closure</h2>
      <div class="table-wrap"><table><thead><tr><th>Flight</th><th>Cut-off</th><th>Status</th><th class="num">Bags</th><th class="num">Accounted</th><th class="num">Outstanding</th><th></th></tr></thead>
        <tbody>${closable.map(candidateRow).join('') || `<tr><td colspan="7">${emptyState({ message: 'No flight is ready for closure yet.' })}</td></tr>`}</tbody></table></div>
    </section>`;

  el.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => { selected = b.getAttribute('data-pick'); draw(); }));
  el.querySelector('#clear')?.addEventListener('click', () => { selected = null; navigate('#/closure'); draw(); });
  el.querySelector('#close-go')?.addEventListener('click', () => openClose(selected, c.flight.code));
}

function openClose(id, code) {
  const d = openDrawer({
    title: `Close ${code}`,
    bodyHtml: `
      <p class="text-2">Closing records the flight as complete. Its bags stay exactly as they are; nothing is deleted.</p>
      <div class="field"><label for="cl-note">Closing note</label><textarea id="cl-note" rows="3" placeholder="All bags accounted for; travelers contacted."></textarea></div>`,
    footerHtml: '<button type="button" class="btn btn-primary" id="cl-go">Close flight</button>',
  });
  d.el.querySelector('#cl-go').addEventListener('click', async () => {
    if (!(await confirmDialog({ title: `Close ${code}?`, body: 'The flight will be marked Completed.', confirmLabel: 'Close flight' }))) return;
    run((s, c) => fl.closeFlight(s, id, { note: /** @type {HTMLTextAreaElement} */ (d.el.querySelector('#cl-note')).value }, c),
      (res) => `${res.flight.code} closed.`, () => { closeDrawer(); draw(); });
  });
}
