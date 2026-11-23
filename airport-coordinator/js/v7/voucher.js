/**
 * Departure — Voucher: the receipt the Airport Authority (SGS) issues for a handover. Accepting one
 * is the bags' last Rabel step, "SGS Voucher Accepted"; from there the airline's own manifest takes
 * over (Backend reconciles it). A tag the Authority did not count raises an SGS Voucher Mismatch
 * and moves nothing.
 */
import { S, user, run, chip, esc, blockedHtml } from './data.js';
import * as ap from '../../../shared/services/airportService.js';
import { fmtDateTime, toast } from '../ui.js';

let el = null;
export function render(params, app) { el = app; draw(); return { destroy, refresh: draw, poll: draw }; }
export function destroy() { el = null; }

const STATUS_COLOR = { Pending: 'amber', Accepted: 'green', Mismatch: 'red' };

function voucherCard(v) {
  const bags = S().bags.filter((b) => v.bag_ids.includes(b.id));
  const waiting = bags.filter((b) => b.status === 'Handed to Airport Authority').length;
  return `<div class="card stack gap-3 ${v.status === 'Mismatch' ? 'alert-red' : ''}">
    <div class="row gap-2 wrap" style="align-items:center">
      <strong class="fs-md mono">${esc(v.voucher_no)}</strong>
      ${chip(v.status, STATUS_COLOR[v.status] || 'grey')}
      <span class="mono fs-sm">${esc(v.flight?.code || '—')}</span>
    </div>
    <div class="fs-sm">${v.bag_ids.length} bag(s) handed over · ${v.counted_tags.length} on the Authority's count${waiting ? ` · ${waiting} still awaiting clearance` : ''}</div>
    <div class="fs-xs muted">Issued ${esc(fmtDateTime(v.issued_at))}${v.handover ? ` · handover ${esc(v.handover.id)} signed by ${esc(v.handover.officer || '—')}` : ''}
      ${v.accepted_at ? ` · accepted ${esc(fmtDateTime(v.accepted_at))}` : ''}</div>
    ${v.missing_tags.length ? `<div class="fs-sm" style="color:var(--danger)">Not on the voucher: <span class="mono">${esc(v.missing_tags.join(', '))}</span>.
      Ops has been told — do not close the flight.</div>` : ''}
    ${v.status !== 'Accepted' ? `<div class="row gap-2 wrap">
      <button type="button" class="btn btn-primary" data-accept="${esc(v.id)}">${v.status === 'Mismatch' ? 'Re-check and accept' : 'Accept the voucher'}</button>
      <span class="fs-xs muted">Clears ${waiting} bag(s) to “SGS Voucher Accepted”.</span></div>` : ''}
  </div>`;
}

function draw() {
  if (!el) return;
  const blocked = blockedHtml('No airport is assigned to this account, so there are no vouchers here.');
  if (blocked) { el.innerHTML = blocked; return; }
  let vouchers;
  try { vouchers = ap.listVouchers(S(), user()); } catch (err) { el.innerHTML = `<div class="state-block error-state"><p>${esc(err.message)}</p></div>`; return; }
  const open = vouchers.filter((v) => v.status !== 'Accepted');
  const done = vouchers.filter((v) => v.status === 'Accepted');

  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">Voucher</h1>
      <p class="page-subtitle">${open.length} voucher(s) waiting to be accepted</p></div></div>
    ${open.length ? `<div class="grid grid-cols-2 gap-3">${open.map(voucherCard).join('')}</div>`
    : '<div class="state-block"><p>No voucher is waiting. A voucher is issued the moment a manifest is handed to the Authority — see <a href="#/dep/handover">SGS handover</a>.</p></div>'}
    ${done.length ? `<h2 class="section-title" style="margin-block-start:var(--s6)">Accepted</h2>
      <div class="grid grid-cols-2 gap-3">${done.map(voucherCard).join('')}</div>` : ''}`;

  el.querySelectorAll('[data-accept]').forEach((b) => b.addEventListener('click', () => {
    const r = run((s, c) => ap.acceptVoucher(s, /** @type {HTMLElement} */ (b).dataset.accept, c));
    if (!r) return;
    toast(r.message, r.ok ? 'success' : 'error');
    draw();
  }));
}
