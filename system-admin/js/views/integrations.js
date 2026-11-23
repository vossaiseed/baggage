/**
 * Integrations — which adapter each integration is running, what it has done in this demo, and
 * a connection test that actually asks the adapter for something. Also the "Reset demo data"
 * action, because rebuilding the store is platform plumbing, not an operational decision.
 */
import { S, run, read, chip, store, user } from '../data.js';
import * as adm from '../../../shared/services/adminService.js';
import { esc, fmtRelative, toast, confirmDialog, emptyState } from '../ui.js';

let el = null;

export function render(params, app) { el = app; draw(); return { destroy, refresh: draw, poll: draw }; }
export function destroy() { el = null; }

function row(r) {
  return `<article class="card integration-row">
    <div class="row wrap" style="justify-content:space-between;gap:var(--s3)">
      <div>
        <h2 class="fs-lg" style="margin:0">${esc(r.label)}</h2>
        <div class="fs-sm muted">${esc(r.what)}</div>
      </div>
      <div class="row gap-2 wrap">
        ${chip(r.mode === 'simulated' ? 'Simulated' : esc(r.mode), r.mode === 'simulated' ? 'blue' : 'green')}
        ${chip(r.adapter === 'wired' ? 'Adapter wired' : 'No adapter', r.adapter === 'wired' ? 'green' : 'red')}
      </div>
    </div>
    <div class="fs-sm"><b>${r.usage.n}</b> ${esc(r.usage.label)} in this demo</div>
    ${r.adapterError ? `<div class="fs-sm level-red">${esc(r.adapterError)}</div>` : ''}
    <div class="fs-sm muted">${r.lastCheck
    ? `Last test ${esc(fmtRelative(r.lastCheck.at))} by ${esc(r.lastCheck.by || 'unknown')} — ${r.lastCheck.ok ? '✓' : '✗'} ${esc(r.lastCheck.note)}`
    : 'Never tested.'}</div>
    <div><button type="button" class="btn btn-secondary" data-test="${esc(r.id)}">Test connection</button></div>
  </article>`;
}

function draw() {
  if (!el) return;
  const rows = read((s, u) => adm.integrationStatus(s, u), []) || [];
  el.innerHTML = `
    <div class="page-header">
      <div><h1 class="page-title">Integrations</h1>
        <p class="page-subtitle">Mode comes from <span class="mono">window.RABEL_CONFIG</span>; the keys a live deployment needs are documented in <span class="mono">.env.example</span> — never in the app</p></div>
    </div>
    <div class="stack gap-3">${rows.map(row).join('') || emptyState({ message: 'No integrations registered.' })}</div>

    <section class="card mt danger-zone">
      <h2 class="section-title">Demo data</h2>
      <p class="fs-sm">Rebuilds the departure store (<span class="mono">rabel_v7</span>) from the seed: migrations re-import the old
      <span class="mono">rabel_ui_*</span> keys read-only, then the demo scenario is laid down again. The arrival apps' own stores are not touched.</p>
      <p class="fs-sm muted">Everything the demo has done since the last reset — bookings, check-ins, trips, exceptions — is rebuilt from scratch.
      Currently holding ${S().flights.length} flight(s), ${S().travelers.length} traveler(s), ${S().bags.length} bag(s), ${S().auditLog.length} audit entries.</p>
      <button type="button" class="btn btn-danger" id="reset">Reset demo data</button>
    </section>`;

  el.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => run(
    (s, c) => adm.testIntegration(s, b.getAttribute('data-test'), c),
    (res) => `${res.ok ? 'OK' : 'Failed'} — ${res.note}`, draw)));
  el.querySelector('#reset').addEventListener('click', openReset);
}

async function openReset() {
  const ok = await confirmDialog({
    title: 'Reset the demo data?',
    body: 'The v7 store is rebuilt from the seed. Anything done in the demo since the last reset is gone. The arrival apps and the old per-app stores are untouched.',
    confirmLabel: 'Reset demo data',
    danger: true,
    requireText: 'RESET',
  });
  if (!ok) return;
  try {
    const next = adm.resetDemoData(store(), { user: user(), now: Date.now() });
    toast(`Demo data rebuilt — ${next.flights.length} flights, ${next.travelers.length} travelers, ${next.bags.length} bags.`, 'success');
    draw();
  } catch (err) {
    toast(err.message || String(err), 'error');
  }
}
