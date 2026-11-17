import * as v7 from './api.js';
import { esc, fmtDateTime } from '../ui.js';

export function render(params, app) {
  const list = v7.notifications();
  app.innerHTML = `<h1 class="page-title" style="margin-block-end:var(--s4)">Notifications</h1>
    ${list.length ? `<div class="stack gap-2">${list.map((n) => `<div class="card stack gap-1"><strong class="fs-sm">${esc(n.title)}</strong><span class="fs-sm">${esc(n.body)}</span><span class="fs-xs muted">${esc(fmtDateTime(n.at))}</span></div>`).join('')}</div>` : '<div class="state-block"><p>No notifications.</p></div>'}`;
  v7.markRead('all');
  return { destroy };
}
export function destroy() { /* no-op */ }
