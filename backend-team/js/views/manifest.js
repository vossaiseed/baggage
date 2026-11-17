import { S, run, chip } from '../data.js';
import * as be from '../../../shared/services/backendService.js';
import { esc, openDrawer, closeDrawer } from '../ui.js';

let el = null;
export function render(params, app) { el = app; draw(); return { destroy, refresh: draw, poll: draw }; }
export function destroy() { el = null; }

function draw() {
  if (!el) return;
  const flights = S().flights.filter((f) => !f.legacy && f.status !== 'Cancelled');
  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">Manifest monitoring</h1><p class="page-subtitle">Airline manifest vs bags at “SGS Voucher Accepted”</p></div></div>
    <div class="grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:var(--s4)">
    ${flights.map((f) => {
      const m = be.manifestStatus(S(), f.id);
      return `<div class="card flight-card"><div class="row" style="justify-content:space-between"><h2 class="section-title" style="margin:0">${esc(f.code)}</h2>${chip(m.feed === 'Connected' ? 'Airline feed connected' : 'No airline feed', m.feed === 'Connected' ? 'green' : 'amber')}</div>
        <dl class="kv" style="display:grid;gap:4px;margin:0"><div class="row" style="justify-content:space-between"><dt class="muted fs-sm">Bags at SGS voucher accepted</dt><dd style="margin:0">${m.at_sgs}</dd></div>
        <div class="row" style="justify-content:space-between"><dt class="muted fs-sm">In airline manifest</dt><dd style="margin:0">${m.feed === 'Connected' ? m.manifest_count : '—'}</dd></div>
        <div class="row" style="justify-content:space-between"><dt class="muted fs-sm">Loaded on aircraft</dt><dd style="margin:0">${m.loaded} / ${m.total}</dd></div></dl>
        ${m.gap ? `<div class="banner-alert amber" role="alert"><strong>${m.gap} bag(s) missing from the airline manifest</strong></div>` : ''}
        <div class="row gap-2 wrap"><button type="button" class="btn btn-primary" data-confirm="${esc(f.id)}" ${m.at_sgs ? '' : 'disabled'}>Confirm loaded</button>
          ${m.gap ? `<button type="button" class="btn btn-secondary" data-notify="${esc(f.id)}">Notify Ops</button>` : ''}</div></div>`;
    }).join('')}</div>`;
  el.querySelectorAll('[data-confirm]').forEach((b) => b.addEventListener('click', () => confirmLoaded(b.dataset.confirm)));
  el.querySelectorAll('[data-notify]').forEach((b) => b.addEventListener('click', () => run((s, c) => be.notifyOpsManifestGap(s, b.dataset.notify, c), 'Ops notified of the manifest gap.', draw)));
}

function confirmLoaded(flightId) {
  const m = be.manifestStatus(S(), flightId);
  if (!m.no_feed && !m.gap) { run((s, c) => be.confirmLoaded(s, flightId, {}, c), (r) => `${r.loaded} bag(s) → Loaded on Aircraft.`, draw); return; }
  const d = openDrawer({ title: `Manual confirmation — ${m.flight.code}`, bodyHtml: `
    <p class="fs-sm">${m.no_feed ? 'There is no airline feed for this flight.' : `${m.gap} bag(s) are missing from the airline manifest.`} A manual confirmation needs a reason and is audit-logged.</p>
    <div class="field"><label for="why">Reason <span class="req">*</span></label><textarea id="why" rows="3"></textarea></div>`,
  footerHtml: '<button type="button" class="btn btn-primary" id="ok">Confirm loaded (manual)</button>' });
  d.el.querySelector('#ok').addEventListener('click', () => run((s, c) => be.confirmLoaded(s, flightId, { manualReason: d.el.querySelector('#why').value }, c), (r) => `${r.loaded} bag(s) → Loaded on Aircraft (manual).`, () => { closeDrawer(); draw(); }));
}
