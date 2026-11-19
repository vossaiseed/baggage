/**
 * Holding — the separate area where ONLY cancelled-flight bags are stored. From here a bag is either
 * returned to its traveler (ID check + signature) or, once Ops rebooks it and Backend issues a new
 * tag, released back onto the line at the stage it left.
 */
import { S, user, run, chip, esc } from '../data.js';
import * as wh from '../../../shared/services/warehouseService.js';
import { openModal, toast, fmtDateTime } from '../ui.js';

let el = null;
export function render(params, app) { el = app; draw(); return { destroy, poll: () => { if (!selected().length) draw(); }, refresh: draw }; }
export function destroy() { el = null; }

const flightCode = (b) => S().flights.find((f) => f.id === b.flight_id)?.code || '—';
const travelerName = (b) => S().travelers.find((t) => t.id === b.traveler_id)?.name || '—';
const selected = () => [...(el?.querySelectorAll('[data-bag]:checked') || [])].map((c) => /** @type {HTMLElement} */ (c).dataset.bag);

function toHoldSection(bags) {
  if (!bags.length) return '';
  return `<section class="card stack gap-3">
    <div class="row gap-2 wrap" style="align-items:center">
      <h2 class="section-title" style="margin:0">To move into holding</h2>${chip(`${bags.length} bag(s)`, 'amber')}
      <span class="grow"></span><button type="button" class="btn btn-ghost" id="select-all">Select all</button>
    </div>
    <p class="fs-sm muted">These bags belong to a cancelled flight. Store them on a rack in the holding area — they must not be screened or loaded.</p>
    <div class="table-wrap"><table>
      <thead><tr><th style="width:40px"></th><th>Rabel label</th><th>Flight</th><th>Traveler</th><th>Status</th></tr></thead>
      <tbody>${bags.map((b) => `<tr>
        <td><input type="checkbox" data-bag="${esc(b.id)}" aria-label="Hold ${esc(b.tag_no || b.id)}" /></td>
        <td class="mono fs-sm">${esc(b.tag_no || '—')}</td><td>${esc(flightCode(b))}</td>
        <td class="fs-sm">${esc(travelerName(b))}</td><td class="fs-sm">${esc(b.status)}</td></tr>`).join('')}</tbody></table></div>
    <div class="row gap-2 wrap"><button type="button" class="btn btn-primary" id="hold-btn" disabled>Move to holding</button>
      <span class="fs-xs muted" id="sel-count">0 selected</span></div>
  </section>`;
}

function heldSection(bags) {
  if (!bags.length) return '<div class="state-block"><p>The holding area is empty.</p></div>';
  return `<section class="card stack gap-3">
    <div class="row gap-2" style="align-items:center"><h2 class="section-title" style="margin:0">In holding</h2>${chip(`${bags.length} bag(s)`, 'blue')}</div>
    <div class="table-wrap"><table>
      <thead><tr><th>Rack</th><th>Rabel label</th><th>Flight</th><th>Traveler</th><th>Held</th><th></th></tr></thead>
      <tbody>${bags.map((b) => `<tr>
        <td><strong>${esc(b.holding_rack || '—')}</strong><div class="fs-xs muted">${esc(b.holding_area || '')}</div></td>
        <td class="mono fs-sm">${esc(b.tag_no || '—')}</td><td>${esc(flightCode(b))}</td>
        <td class="fs-sm">${esc(travelerName(b))}</td><td class="fs-xs muted">${esc(fmtDateTime(b.held_at))}</td>
        <td><button type="button" class="btn btn-secondary" data-return="${esc(b.id)}">Return to traveler</button></td></tr>`).join('')}</tbody></table></div>
    <p class="fs-xs muted">Rebooking a held bag onto another flight is the Operations Manager's call; Backend then issues the new tag.</p>
  </section>`;
}

function rebookedSection(awaiting, ready) {
  if (!awaiting.length && !ready.length) return '';
  return `<section class="card stack gap-3">
    <h2 class="section-title" style="margin:0">Rebooked</h2>
    ${awaiting.length ? `<div><p class="fs-sm">${awaiting.length} bag(s) have been rebooked by Ops and are waiting for Backend to issue a new tag.</p>
      <div class="fs-xs mono muted">${awaiting.map((b) => esc(b.tag_no || b.id)).join(' · ')}</div></div>` : ''}
    ${ready.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Rabel label</th><th>New flight</th><th>Held from</th><th></th></tr></thead>
      <tbody>${ready.map((b) => `<tr><td class="mono fs-sm">${esc(b.tag_no)}</td><td>${esc(flightCode(b))}</td>
        <td class="fs-sm">${esc(b.held_from_status || '—')}</td>
        <td><button type="button" class="btn btn-primary" data-release="${esc(b.id)}">Release back to the line</button></td></tr>`).join('')}</tbody></table></div>`
    : ''}
  </section>`;
}

function draw() {
  if (!el) return;
  let q;
  try { q = wh.holdingQueue(S(), user()); } catch (err) {
    el.innerHTML = `<div class="state-block error-state"><p>${esc(err.message)}</p></div>`;
    return;
  }
  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">Holding</h1>
      <p class="page-subtitle">Cancelled flights only · ${q.held.length} stored · ${q.toHold.length} to move in</p></div></div>
    <div class="stack gap-4">
      ${toHoldSection(q.toHold)}
      ${heldSection(q.held)}
      ${rebookedSection(q.awaitingRetag, q.readyToRelease)}
    </div>`;
  wire();
}

function wire() {
  const btn = /** @type {HTMLButtonElement} */ (el.querySelector('#hold-btn'));
  const count = el.querySelector('#sel-count');
  const sync = () => {
    const n = selected().length;
    if (count) count.textContent = `${n} selected`;
    if (btn) btn.disabled = n === 0;
  };
  el.querySelectorAll('[data-bag]').forEach((c) => c.addEventListener('change', sync));
  el.querySelector('#select-all')?.addEventListener('click', () => {
    const rows = el.querySelectorAll('[data-bag]');
    const on = [...rows].some((c) => !(/** @type {HTMLInputElement} */ (c).checked));
    rows.forEach((c) => { /** @type {HTMLInputElement} */ (c).checked = on; });
    sync();
  });
  btn?.addEventListener('click', () => askRack(selected()));
  el.querySelectorAll('[data-return]').forEach((b) => b.addEventListener('click', () => askReturn(/** @type {HTMLElement} */ (b).dataset.return)));
  el.querySelectorAll('[data-release]').forEach((b) => b.addEventListener('click', () => {
    const bagId = /** @type {HTMLElement} */ (b).dataset.release;
    run((s, c) => wh.releaseRebooked(s, bagId, c), (bag) => `${bag.tag_no} is back on the line at “${bag.status}”.`, draw);
  }));
}

function askRack(ids) {
  const close = openModal({
    title: `Move ${ids.length} bag(s) to holding`,
    bodyHtml: `<p class="fs-sm">Record where they are stored so they can be found when the traveler asks or the flight is rebooked.</p>
      <div class="field"><label for="rack">Rack <span class="req">*</span></label><input id="rack" type="text" placeholder="e.g. R-04" /></div>
      <div class="field"><label for="area">Area</label><input id="area" type="text" value="Holding area" /></div>
      <div class="modal-actions"><button type="button" class="btn btn-secondary" data-act="close">Cancel</button>
        <button type="button" class="btn btn-primary" id="do-hold">Move to holding</button></div>`,
    onMount: (overlay) => {
      overlay.querySelector('#do-hold').addEventListener('click', () => {
        const rack = /** @type {HTMLInputElement} */ (overlay.querySelector('#rack')).value;
        const area = /** @type {HTMLInputElement} */ (overlay.querySelector('#area')).value;
        close();
        const r = run((s, c) => wh.holdBags(s, ids, { rack, area }, c));
        if (!r) return;
        toast(r.skipped.length ? `${r.held} held, ${r.skipped.length} skipped — ${r.skipped[0].reason}` : `${r.held} bag(s) moved to holding.`, r.skipped.length ? 'info' : 'success');
        draw();
      });
      /** @type {HTMLElement} */ (overlay.querySelector('#rack')).focus();
    },
  });
}

function askReturn(bagId) {
  const bag = S().bags.find((b) => b.id === bagId);
  const close = openModal({
    title: `Return ${bag?.tag_no || 'bag'} to the traveler`,
    bodyHtml: `<p class="fs-sm">${esc(travelerName(bag))} — check their ID and take a signature. Both are required.</p>
      <label class="checkbox-row"><input type="checkbox" id="id-checked" /> <span>I have checked the traveler's ID</span></label>
      <div class="field" style="margin-block-start:var(--s4)"><label for="sig">Signature (type the traveler's name) <span class="req">*</span></label>
        <input id="sig" type="text" autocomplete="off" /></div>
      <div class="modal-actions"><button type="button" class="btn btn-secondary" data-act="close">Cancel</button>
        <button type="button" class="btn btn-primary" id="do-return">Hand the bag over</button></div>`,
    onMount: (overlay) => {
      overlay.querySelector('#do-return').addEventListener('click', () => {
        const idChecked = /** @type {HTMLInputElement} */ (overlay.querySelector('#id-checked')).checked;
        const signature = /** @type {HTMLInputElement} */ (overlay.querySelector('#sig')).value.trim();
        close();
        run((s, c) => wh.returnBag(s, bagId, { idChecked, signature }, c), 'Bag returned to the traveler.', draw);
      });
    },
  });
}
