/** Window board: read-only 12-hour-window status per collection area (amber/red time-rule alerts). */
import { S, user, chip } from '../../data.js';
import * as tr from '../../../../shared/services/transportService.js';
import { esc } from '../../ui.js';

let el = null;
let timer = null;
export function render(params, app) { el = app; draw(); timer = setInterval(draw, 60000); return { destroy, refresh: draw, poll: draw }; }
export function destroy() { el = null; if (timer) clearInterval(timer); timer = null; }

function row(r) {
  const alertClass = r.alertLevel ? `alert-${r.alertLevel}` : '';
  return `<div class="board-row ${alertClass}">
    <div class="board-top">
      <strong>${esc(r.area.name)}</strong>
      <span class="row gap-2 wrap">
        ${r.priorityRank < 99 ? chip(`P${r.priorityRank}`, 'blue') : chip('No live flights', 'grey')}
        ${r.alertLevel ? chip(r.alertLevel === 'red' ? 'Red — not on schedule' : 'Amber — running late', r.alertLevel) : chip('On schedule', 'green')}
      </span>
    </div>
    <div class="fs-sm muted">${r.pendingPickups} bag(s) waiting for pickup · ${r.openTrips.length} active trip(s)</div>
  </div>`;
}

function draw() {
  if (!el) return;
  let board;
  try { board = tr.windowBoard(S(), user(), { now: Date.now() }); }
  catch (err) { el.innerHTML = `<div class="state-block error-state"><p>${esc(err.message)}</p></div>`; return; }
  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">Window board</h1><p class="page-subtitle">Live status per collection area against the 12-hour window</p></div></div>
    <div class="stack gap-3">${board.map(row).join('')}</div>`;
}
