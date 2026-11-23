import * as v7 from './api.js';
import { esc, fmtDateTime } from '../ui.js';

export function render(params, app) {
  const tr = v7.tracking();
  if (!tr.receipt) { app.innerHTML = '<div class="state-block"><p>Your receipt appears here once your bags are checked in.</p></div>'; return { destroy }; }
  app.innerHTML = `
    <h1 class="page-title" style="margin-block-end:var(--s4)">Digital receipt</h1>
    <div class="card stack gap-3">
      <div class="row" style="justify-content:space-between"><strong>${esc(tr.receipt.no)}</strong><span class="fs-xs muted">${esc(fmtDateTime(tr.now))}</span></div>
      <p class="fs-sm">${esc(tr.traveler.name)} · ${esc(tr.flight?.code || '')}</p>
      <table class="v7-table"><thead><tr><th>Bag</th><th>Airline tag</th><th>Rabel label</th><th>Weight</th></tr></thead><tbody>
        ${tr.receipt.bags.map((b, i) => `<tr><td>${i + 1}</td><td>${esc(b.airline_tag_no || 'No airline tag')}</td><td>${esc(b.tag_no || '—')}</td><td>${b.weight_kg ? `${b.weight_kg} kg` : '—'}</td></tr>`).join('')}
      </tbody></table>
      <p class="fs-xs muted">Keep this receipt. Your bags travel to the airport separately — you collect them at your destination.</p>
    </div>`;
  return { destroy, activeBagId: () => null };
}
export function destroy() { /* no-op */ }
