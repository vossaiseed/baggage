import * as v7 from './api.js';
import { esc } from '../ui.js';
import { maskPassport } from './format.js';

export function render(params, app) {
  const t = v7.me();
  app.innerHTML = `
    <h1 class="page-title" style="margin-block-end:var(--s4)">Profile</h1>
    <div class="card stack gap-3">
      <dl class="kv"><div><dt>Name</dt><dd>${esc(t.name)}</dd></div><div><dt>Nusuk ID</dt><dd>${esc(t.nusuk_id || '—')}</dd></div>
        <div><dt>Booking reference</dt><dd>${esc(t.booking_ref || '—')}</dd></div><div><dt>Passport</dt><dd>${esc(maskPassport(t.passport))}</dd></div></dl>
      <button type="button" class="btn btn-secondary" id="logout">Log out</button>
    </div>`;
  app.querySelector('#logout').addEventListener('click', () => { v7.logout(); window.location.href = '../index.html'; });
  return { destroy };
}
export function destroy() { /* no-op */ }
