import * as v7 from './api.js';
import { esc, toast, fmtDateTime } from '../ui.js';
import { navigate } from '../router.js';
import { residenceHtml, maskPassport, slotLabel, bannersHtml } from './format.js';
import { statusChip } from '../components/status-chip.js';

let appEl = null;

export function render(params, app) {
  appEl = app;
  draw();
  return { destroy, refresh: draw, poll: draw, activeBagId: () => null };
}
export function destroy() { appEl = null; }

function draw() {
  if (!appEl) return;
  let t; let tr; let pol;
  try { t = v7.me(); tr = v7.tracking(); pol = v7.policy(); } catch (err) { appEl.innerHTML = `<div class="state-block error-state"><p>${esc(err.message)}</p></div>`; return; }
  const res = tr.residence;
  const a = tr.assignment;
  appEl.innerHTML = `
    <div class="stack gap-1" style="margin-block-end:var(--s5)">
      <p class="greeting">Welcome, ${esc(t.name.split(' ')[0])}</p>
      <p class="muted fs-sm">${esc(tr.flight?.code || '')} · ${esc(tr.flight?.route || '')}</p>
    </div>
    ${bannersHtml(tr.banners)}
    <div class="stack gap-5">
      <div class="card stack gap-3" id="nusuk-card">
        <div class="row" style="justify-content:space-between;gap:var(--s2)">
          <h2 class="section-title" style="margin:0">Synced from Nusuk</h2>
          ${t.nusuk_id ? `<button type="button" class="btn btn-secondary" id="sync-btn">Sync again</button>` : '<span class="chip chip-amber">Airline booking</span>'}
        </div>
        <p class="fs-xs muted">${t.nusuk_synced_at ? `Last synced ${esc(fmtDateTime(t.nusuk_synced_at))}` : 'Not synced yet'}</p>
        <dl class="kv">
          <div><dt>Name</dt><dd>${esc(t.name)}</dd></div>
          <div><dt>Passport</dt><dd>${esc(maskPassport(t.passport))}</dd></div>
          <div><dt>Flight</dt><dd>${esc(tr.flight?.code || '—')} · ${esc(tr.airline?.name || '')}</dd></div>
          <div><dt>Residence</dt><dd>${residenceHtml(res)}</dd></div>
        </dl>
        <p class="fs-sm">Bag allowance: <strong>${pol.bags_allowed}</strong>${pol.extra_bags_max ? ` (+${pol.extra_bags_max} extra with airline approval)` : ''} · up to <strong>${pol.max_bag_weight_kg} kg</strong> per bag (${esc(pol.airline.name)} policy).</p>
      </div>

      <div class="card stack gap-3">
        <h2 class="section-title" style="margin:0">Your collection</h2>
        ${a ? `
          <div class="row gap-2 wrap">${statusChip(a.status)} <span class="fs-sm">${esc(slotLabel(tr.slot))}</span></div>
          <p class="fs-sm">${a.bags_declared} bag${a.bags_declared === 1 ? '' : 's'}${a.extra_bags ? ` · ${a.extra_bags} extra — airline approval ${esc(String(a.extra_approval || '').toLowerCase())}` : ''}</p>
          <div class="row gap-2 wrap"><button type="button" class="btn btn-primary" data-go="#/track">Track my bags</button>
          <button type="button" class="btn btn-secondary" data-go="#/booking/${esc(a.id)}">Booking details</button></div>`
          : tr.flight?.status === 'Cancelled'
            ? '<p class="fs-sm muted">Your flight was cancelled. Collection cannot be booked.</p>'
            : `<p class="fs-sm muted">Choose a time and we will collect your bags from your residence.</p>
               <button type="button" class="btn btn-primary btn-lg" data-go="#/book">Book bag collection</button>`}
      </div>

      <form class="card stack gap-3" id="contact-form" novalidate>
        <h2 class="section-title" style="margin:0">Check your contact details</h2>
        <p class="fs-xs muted">You can correct only the flat number, landmark and phone. Every change is logged.</p>
        <div class="field"><label for="flat_no">Flat number</label><input id="flat_no" value="${esc(res?.flat_no || '')}" ${res ? '' : 'disabled'} /></div>
        <div class="field"><label for="landmark">Landmark</label><input id="landmark" value="${esc(res?.landmark || '')}" ${res ? '' : 'disabled'} /></div>
        <div class="field"><label for="contact_phone">Contact phone</label><input id="contact_phone" inputmode="tel" value="${esc(res?.contact_phone || '')}" ${res ? '' : 'disabled'} /></div>
        <div id="contact-msg" class="fs-sm" role="status"></div>
        <button type="submit" class="btn btn-secondary" ${res ? '' : 'disabled'}>Save changes</button>
        ${res?.change_log?.length ? `<p class="fs-xs muted">${res.change_log.length} change${res.change_log.length === 1 ? '' : 's'} logged — last ${esc(fmtDateTime(res.change_log.at(-1).at))}.</p>` : ''}
      </form>
    </div>`;
  appEl.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.go)));
  appEl.querySelector('#sync-btn')?.addEventListener('click', () => {
    try { v7.sync(); toast('Synced from Nusuk.', 'success'); draw(); } catch (err) { toast(err.message, 'error'); }
  });
  appEl.querySelector('#contact-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = appEl.querySelector('#contact-msg');
    try {
      const r = v7.saveContact({ flat_no: appEl.querySelector('#flat_no').value, landmark: appEl.querySelector('#landmark').value, contact_phone: appEl.querySelector('#contact_phone').value });
      toast(r.changed ? `${r.changed} change${r.changed === 1 ? '' : 's'} saved.` : 'Nothing changed.', r.changed ? 'success' : 'info');
      draw();
    } catch (err) { msg.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
  });
}
