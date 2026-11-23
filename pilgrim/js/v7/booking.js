import * as v7 from './api.js';
import { esc } from '../ui.js';
import { navigate } from '../router.js';
import { residenceHtml, slotLabel } from './format.js';

let appEl = null;
export function render(params, app) {
  appEl = app;
  const tr = v7.tracking();
  const a = tr.assignment && tr.assignment.id === params.id ? tr.assignment : tr.assignment;
  if (!a) { app.innerHTML = '<div class="state-block"><p>Booking not found.</p></div>'; return { destroy }; }
  app.innerHTML = `
    <div class="banner-alert green" role="status"><span class="icon">✓</span><div><strong>Booking confirmed</strong><br>Keep your bags ready at your residence at <strong>${esc(slotLabel(tr.slot))}</strong>.</div></div>
    <div class="card stack gap-3">
      <h2 class="section-title" style="margin:0">Booking summary</h2>
      <dl class="kv">
        <div><dt>Booking</dt><dd>${esc(a.id)}</dd></div>
        <div><dt>Flight</dt><dd>${esc(tr.flight?.code || '')} · ${esc(tr.flight?.route || '')}</dd></div>
        <div><dt>Bags</dt><dd>${a.bags_declared}${a.extra_bags ? ` (${a.extra_bags} extra — airline approval ${esc(String(a.extra_approval || '').toLowerCase())})` : ''}</dd></div>
        <div><dt>Collection slot</dt><dd>${esc(slotLabel(tr.slot))}</dd></div>
        <div><dt>Address</dt><dd>${residenceHtml(tr.residence)}</dd></div>
      </dl>
      <p class="fs-sm muted">A confirmation SMS was sent to ${esc(tr.residence?.contact_phone || 'your phone')} (simulated). A collector will visit your residence — you do not need a QR code.</p>
      <p class="fs-sm">Bag weight: up to <strong>${v7.policy().max_bag_weight_kg} kg</strong> per bag.</p>
      <button type="button" class="btn btn-primary" id="to-track">Track my bags</button>
    </div>`;
  app.querySelector('#to-track').addEventListener('click', () => navigate('#/track'));
  return { destroy, activeBagId: () => null };
}
export function destroy() { appEl = null; }
