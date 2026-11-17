import * as v7 from './api.js';
import { esc, toast } from '../ui.js';
import { navigate } from '../router.js';
import { residenceHtml, slotLabel } from './format.js';

let appEl = null;
export function render(params, app) { appEl = app; draw({}); return { destroy, refresh: () => draw({}), activeBagId: () => null }; }
export function destroy() { appEl = null; }

function draw(sel, error = '') {
  if (!appEl) return;
  const t = v7.me();
  const tr = v7.tracking();
  const pol = v7.policy();
  if (tr.flight?.status === 'Cancelled') { appEl.innerHTML = `<div class="banner-alert amber"><strong>Your flight was cancelled — collection cannot be booked.</strong></div>`; return; }
  if (tr.assignment && tr.assignment.status !== 'Traveler Absent') {
    appEl.innerHTML = `<div class="state-block"><p>You already have a collection booked.</p><button type="button" class="btn btn-primary" id="go-track">Track my bags</button></div>`;
    appEl.querySelector('#go-track').addEventListener('click', () => navigate('#/track'));
    return;
  }
  if (tr.assignment) { navigate('#/track'); return; } // absent → pick a new slot on the Track page
  const slots = v7.slots();
  const bags = sel.bags ?? pol.bags_allowed;
  const max = pol.bags_allowed + pol.extra_bags_max;
  appEl.innerHTML = `
    <h1 class="page-title" style="margin-block-end:var(--s4)">Book bag collection</h1>
    ${error ? `<div class="banner-alert amber" role="alert"><strong>${esc(error)}</strong></div>` : ''}
    <form class="stack gap-4" id="book-form" novalidate>
      <div class="card stack gap-1"><span class="fs-xs muted">Flight</span><strong>${esc(tr.flight?.code || '')} · ${esc(tr.flight?.route || '')}</strong></div>
      <div class="card stack gap-2">
        <label class="fw-semibold" for="bag-count">Number of bags</label>
        <div class="row gap-3"><button type="button" class="btn btn-secondary btn-icon" data-step="-1" aria-label="Fewer bags">−</button>
          <output id="bag-count" class="fs-xl fw-bold" style="min-width:2ch;text-align:center">${bags}</output>
          <button type="button" class="btn btn-secondary btn-icon" data-step="1" aria-label="More bags">+</button></div>
        <p class="fs-sm">${bags > pol.bags_allowed ? `<span class="chip chip-amber">${bags - pol.bags_allowed} extra — airline approval</span>` : `Within your ${pol.airline.code} allowance of ${pol.bags_allowed}.`}</p>
        <p class="fs-xs muted">${pol.extra_bags_max ? `Up to ${pol.extra_bags_max} extra bag${pol.extra_bags_max > 1 ? 's are' : ' is'} allowed with airline approval.` : 'This airline does not allow extra bags.'}</p>
        <p class="fs-sm">Bag weight: up to <strong>${pol.max_bag_weight_kg} kg</strong> per bag (${esc(pol.airline.name)} policy).</p>
      </div>
      <div class="card stack gap-1"><span class="fs-xs muted">Collection address (from Nusuk)</span>${residenceHtml(tr.residence)}</div>
      <fieldset class="card stack gap-2" style="border:1px solid var(--border)">
        <legend class="fw-semibold">Collection slot</legend>
        <p class="fs-xs muted">2-hour slots inside your flight's 8-hour collection window.</p>
        ${slots.length ? slots.map((s) => `
          <label class="slot-option ${s.full ? 'is-full' : ''}"><input type="radio" name="slot" value="${esc(s.id)}" ${s.full ? 'disabled' : ''} ${sel.slotId === s.id ? 'checked' : ''} />
            <span>${esc(slotLabel(s))}</span><span class="chip ${s.full ? 'chip-red' : s.remaining <= 2 ? 'chip-amber' : 'chip-green'}">${s.full ? 'Full' : `${s.remaining} left`}</span></label>`).join('')
          : '<p class="fs-sm muted">No slots are open right now. Contact support if your address is not linked to a collection area.</p>'}
      </fieldset>
      <button type="submit" class="btn btn-primary btn-lg btn-block" ${slots.some((s) => !s.full) ? '' : 'disabled'}>Confirm booking</button>
    </form>`;
  const form = appEl.querySelector('#book-form');
  const current = () => ({ bags, slotId: form.querySelector('input[name=slot]:checked')?.value });
  form.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
    const next = Math.min(max, Math.max(1, bags + Number(b.dataset.step)));
    draw({ ...current(), bags: next });
  }));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const c = current();
    if (!c.slotId) { draw(c, 'Choose a collection slot.'); return; }
    try {
      const r = v7.book(c.bags, c.slotId);
      toast('Collection booked.', 'success');
      navigate(`#/booking/${r.assignment.id}`);
    } catch (err) { draw(c, err.message); }
  });
  void t;
}
