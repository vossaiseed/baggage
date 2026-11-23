/** Exceptions raised in MY collection area (read-only list; Ops / Backend resolve them). */
import { S, me } from '../v7.js';
import { scopeFilter } from '../../../shared/rbac.js';
import { esc, fmtDateTime } from '../ui.js';

let el = null;
export function render(params, app) { el = app; draw(); return { destroy, poll: draw, refresh: draw }; }
export function destroy() { el = null; }

const SEV = { Low: 'grey', Medium: 'amber', High: 'red', Critical: 'red' };

function draw() {
  if (!el) return;
  const rows = scopeFilter(me(), 'exceptions', S().exceptions).sort((a, b) => String(b.time).localeCompare(String(a.time)));
  el.innerHTML = `<div class="page-wrap"><div class="page-header"><div><h1 class="page-title">Exceptions</h1><p class="page-subtitle">Raised in your collection area</p></div></div>
    ${rows.length ? `<div class="asg-list">${rows.map((e) => `<div class="step-card"><div class="asg-top"><strong>${esc(e.type)}</strong><span class="chip chip-${SEV[e.severity] || 'grey'}">${esc(e.severity)}</span><span class="chip chip-${e.status === 'Open' ? 'amber' : 'green'}">${esc(e.status)}</span></div>
      <p class="fs-sm">${esc(e.notes || '')}</p><p class="fs-xs muted">${esc(e.id)} · ${esc(fmtDateTime(e.time))}${e.resolution_notes ? ` · ${esc(e.resolution_notes)}` : ''}</p></div>`).join('')}</div>`
      : '<div class="state-block"><p>No exceptions in your area.</p></div>'}</div>`;
}
