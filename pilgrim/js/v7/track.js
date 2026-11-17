import * as v7 from './api.js';
import { esc, toast, fmtTime, fmtDateTime } from '../ui.js';
import { navigate } from '../router.js';
import { slotLabel, bannersHtml } from './format.js';
import { statusChip } from '../components/status-chip.js';

let appEl = null;
export function render(params, app) { appEl = app; draw(); return { destroy, refresh: draw, poll: draw, activeBagId: () => null }; }
export function destroy() { appEl = null; }

function draw() {
  if (!appEl) return;
  const tr = v7.tracking();
  const a = tr.assignment;
  const absent = a?.status === 'Traveler Absent';
  appEl.innerHTML = `
    <h1 class="page-title" style="margin-block-end:var(--s4)">Track my bags</h1>
    ${bannersHtml(tr.banners)}
    ${tr.collector ? `<div class="banner-alert blue" role="status"><span class="icon">➜</span><div><strong>${esc(tr.collector.name)} is on the way</strong>${tr.collector.eta ? `<br>ETA ${esc(fmtTime(tr.collector.eta))}` : ''}</div></div>` : ''}
    ${a ? `<div class="card stack gap-1" style="margin-block-end:var(--s4)"><div class="row gap-2 wrap">${statusChip(a.status)}<span class="fs-sm">${esc(slotLabel(tr.slot))}</span></div></div>` : '<p class="muted">No collection booked yet.</p>'}
    ${absent ? slotPicker() : ''}
    ${tr.bags.length ? `
    <div class="card stack gap-3" style="margin-block-end:var(--s4)">
      <h2 class="section-title" style="margin:0">Progress</h2>
      ${tr.side ? `<p class="fs-sm">${statusChip(tr.side)}</p>` : ''}
      <ol class="v7-timeline">${tr.timeline.map((s) => `<li class="${s.done ? 'done' : ''} ${s.current ? 'current' : ''}"><span class="dot"></span><span>${esc(s.status)}</span></li>`).join('')}</ol>
    </div>
    <div class="card stack gap-2">
      <h2 class="section-title" style="margin:0">Your bags</h2>
      ${tr.bags.map((b, i) => `<div class="row" style="justify-content:space-between;gap:var(--s2)"><span>Bag ${i + 1}${b.extra ? ' <span class="chip chip-amber">Extra</span>' : ''}${b.tag_no ? ` <span class="fs-xs muted">${esc(b.tag_no)}</span>` : ''}</span>${statusChip(b.status)}</div>`).join('')}
      ${tr.receipt ? '<button type="button" class="btn btn-secondary" id="receipt-btn">View digital receipt</button>' : ''}
    </div>` : ''}
    <button type="button" class="btn btn-ghost btn-block" id="support-btn" style="margin-block-start:var(--s4)">Contact support</button>`;
  appEl.querySelector('#receipt-btn')?.addEventListener('click', () => navigate(`#/receipt/${tr.assignment?.id || 'r'}`));
  appEl.querySelector('#support-btn').addEventListener('click', () => navigate('#/support'));
  appEl.querySelector('#resched-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const slotId = appEl.querySelector('input[name=slot]:checked')?.value;
    if (!slotId) { toast('Choose a new slot.', 'error'); return; }
    try { v7.reschedule(a.id, slotId); toast('New slot booked.', 'success'); draw(); } catch (err) { toast(err.message, 'error'); }
  });
  void fmtDateTime;
}

function slotPicker() {
  const slots = v7.slots();
  return `<form class="card stack gap-2" id="resched-form" style="margin-block-end:var(--s4)"><h2 class="section-title" style="margin:0">Choose a new slot</h2>
    <p class="fs-xs muted">Slots inside your flight's collection window.</p>
    ${slots.length ? slots.map((s) => `<label class="slot-option ${s.full ? 'is-full' : ''}"><input type="radio" name="slot" value="${esc(s.id)}" ${s.full ? 'disabled' : ''}/><span>${esc(slotLabel(s))}</span><span class="chip ${s.full ? 'chip-red' : 'chip-green'}">${s.full ? 'Full' : `${s.remaining} left`}</span></label>`).join('')
      : '<p class="fs-sm muted">No slots are left inside the window. Support has been notified.</p>'}
    <button type="submit" class="btn btn-primary" ${slots.some((s) => !s.full) ? '' : 'disabled'}>Confirm new slot</button></form>`;
}
