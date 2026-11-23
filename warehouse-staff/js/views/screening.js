/**
 * Screening — received bags, grouped by flight, most urgent first. Screening is not a scan point
 * (the bags were scanned on the way in and are scanned again onto the airport truck), so it is a
 * selection: tick what has been through the scanner and screen it.
 * Cancelled-flight bags never appear here — they belong in Holding.
 */
import { S, user, run, chip, esc } from '../data.js';
import { screeningQueue, screenBags } from '../../../shared/services/warehouseService.js';
import { fmtCountdown, fmtWeight, toast } from '../ui.js';

let el = null;
/** Polling never re-draws while bags are ticked — it would wipe the selection. */
export function render(params, app) { el = app; draw(); return { destroy, poll: () => { if (!selected().length) draw(); }, refresh: draw }; }
export function destroy() { el = null; }

function group(g) {
  return `<section class="card stack gap-3" data-group="${esc(g.flight?.id || '')}">
    <div class="row gap-2 wrap" style="align-items:center">
      <h2 class="section-title" style="margin:0">${esc(g.flight?.code || 'Unknown flight')}</h2>
      ${g.priority <= 3 ? chip(`P${g.priority}`, 'blue') : ''}
      <span class="fs-sm muted">cut-off ${g.flight?.cut_off_at ? esc(fmtCountdown(g.flight.cut_off_at)) : '—'}</span>
      <span class="grow"></span>
      <button type="button" class="btn btn-ghost" data-all="${esc(g.flight?.id || '')}">Select all ${g.bags.length}</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th style="width:40px"></th><th>Rabel label</th><th>Airline tag</th><th>Weight</th><th>Traveler</th></tr></thead>
      <tbody>${g.bags.map((b) => `<tr>
        <td><input type="checkbox" data-bag="${esc(b.id)}" aria-label="Screen ${esc(b.tag_no || b.id)}" /></td>
        <td class="mono fs-sm">${esc(b.tag_no || '—')}</td>
        <td class="mono fs-sm">${esc(b.airline_tag_no || 'No airline tag')}</td>
        <td>${esc(fmtWeight(b.weight_kg))}</td>
        <td class="fs-sm">${esc(S().travelers.find((t) => t.id === b.traveler_id)?.name || '—')}</td>
      </tr>`).join('')}</tbody></table></div>
  </section>`;
}

function draw() {
  if (!el) return;
  let groups;
  try { groups = screeningQueue(S(), user(), { now: Date.now() }); } catch (err) {
    el.innerHTML = `<div class="state-block error-state"><p>${esc(err.message)}</p></div>`;
    return;
  }
  const total = groups.reduce((n, g) => n + g.bags.length, 0);
  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">Screening</h1>
      <p class="page-subtitle">${total} bag(s) waiting, most urgent flight first</p></div></div>
    ${total ? `<div class="stack gap-4">${groups.map(group).join('')}</div>
      <div class="save-bar"><span class="fs-sm" id="sel-count">0 selected</span>
        <button type="button" class="btn btn-primary btn-lg" id="screen-btn" disabled>Mark screened</button></div>`
      : '<div class="state-block"><p>Nothing to screen. Bags arrive here once a collection truck is received at the gate.</p></div>'}`;
  wire();
}

function selected() { return [...el.querySelectorAll('[data-bag]:checked')].map((c) => /** @type {HTMLElement} */ (c).dataset.bag); }

function wire() {
  const count = el.querySelector('#sel-count');
  const btn = /** @type {HTMLButtonElement} */ (el.querySelector('#screen-btn'));
  const sync = () => {
    const n = selected().length;
    if (count) count.textContent = `${n} selected`;
    if (btn) btn.disabled = n === 0;
  };
  el.querySelectorAll('[data-bag]').forEach((c) => c.addEventListener('change', sync));
  el.querySelectorAll('[data-all]').forEach((b) => b.addEventListener('click', () => {
    const id = /** @type {HTMLElement} */ (b).dataset.all;
    const rows = el.querySelectorAll(`[data-group="${id}"] [data-bag]`);
    const turnOn = [...rows].some((c) => !(/** @type {HTMLInputElement} */ (c).checked));
    rows.forEach((c) => { /** @type {HTMLInputElement} */ (c).checked = turnOn; });
    sync();
  }));
  btn?.addEventListener('click', () => {
    const ids = selected();
    const r = run((s, c) => screenBags(s, ids, c));
    if (!r) return;
    if (r.skipped.length) toast(`${r.screened} screened, ${r.skipped.length} skipped — ${r.skipped[0].reason}`, 'info');
    else toast(`${r.screened} bag(s) screened.`, 'success');
    draw();
  });
}
