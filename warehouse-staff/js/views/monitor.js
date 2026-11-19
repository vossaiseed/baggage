/**
 * Monitor — the warehouse at a glance. Tiles for each queue, then one row per flight with bags here:
 * how many at each stage, how long the oldest has been in the warehouse (amber 90 min, red 120 min)
 * and the flight's own window alerts.
 */
import { S, user, chip, esc, levelColor } from '../data.js';
import { monitorRows, warehouseSummary } from '../../../shared/services/warehouseService.js';
import { fmtCountdown } from '../ui.js';
import { navigate } from '../router.js';

let el = null;
export function render(params, app) { el = app; draw(); return { destroy, poll: draw, refresh: draw }; }
export function destroy() { el = null; }

const tile = (n, label, tone, link) => `<button type="button" class="kpi-tile ${tone}" data-go="${link}" style="text-align:start;cursor:pointer">
  <span class="fs-2xl fw-bold">${n}</span><span class="fs-sm muted">${esc(label)}</span></button>`;

function dwell(row) {
  if (row.dwellMinutes == null) return chip('—', 'grey');
  const h = Math.floor(row.dwellMinutes / 60);
  const m = row.dwellMinutes % 60;
  return chip(`${h ? `${h}h ` : ''}${m}m in warehouse`, levelColor(row.timerLevel));
}

function draw() {
  if (!el) return;
  const me = user();
  let rows; let sum;
  try { rows = monitorRows(S(), me, { now: Date.now() }); sum = warehouseSummary(S(), me, { now: Date.now() }); } catch (err) {
    el.innerHTML = `<div class="state-block error-state"><p>${esc(err.message)}</p></div>`;
    return;
  }
  el.innerHTML = `
    <div class="page-header">
      <div><h1 class="page-title">Monitor</h1>
        <p class="page-subtitle">The 2-hour warehouse stage${sum.worstTimer ? ` · <strong class="level-${sum.worstTimer}">${sum.worstTimer === 'red' ? 'Bags are overdue' : 'A flight is running late'}</strong>` : ' · on time'}</p></div>
    </div>
    <div class="grid grid-cols-4 gap-3 mb">
      ${tile(sum.atGate, 'Trucks at the gate', sum.atGate ? 'warn' : 'ok', '#/receiving')}
      ${tile(sum.toScreen, 'To screen', sum.toScreen ? 'warn' : 'ok', '#/screening')}
      ${tile(sum.toLoad, 'Screened, waiting for the airport', sum.toLoad ? 'warn' : 'ok', '#/loading')}
      ${tile(sum.held, 'In holding', 'ok', '#/holding')}
    </div>
    <div class="row gap-3 wrap mb fs-sm muted">
      <span>${sum.inbound} truck(s) inbound</span><span>·</span>
      <span>${sum.onAirportTruck} bag(s) on the airport truck</span><span>·</span>
      <a href="#/exceptions">${sum.openExceptions} open exception(s)</a>
    </div>
    ${rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Flight</th><th>Cut-off</th><th class="num">Received</th><th class="num">Screened</th><th class="num">On truck</th><th class="num">Held</th><th>Warehouse timer</th><th>Alerts</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><strong>${esc(r.flight?.code || '—')}</strong> ${r.priority <= 3 ? chip(`P${r.priority}`, 'blue') : ''}
          ${r.flight?.status === 'Cancelled' ? chip('Cancelled', 'red') : ''}</td>
        <td class="mono fs-sm">${r.flight?.cut_off_at ? esc(fmtCountdown(r.flight.cut_off_at)) : '—'}</td>
        <td class="num">${r.received}</td><td class="num">${r.screened}</td><td class="num">${r.loaded}</td><td class="num">${r.held}</td>
        <td>${dwell(r)}</td>
        <td class="fs-xs">${r.alerts.length ? r.alerts.map((a) => `<div class="level-${a.level}">${esc(a.message)}</div>`).join('') : '<span class="muted">—</span>'}</td>
      </tr>`).join('')}</tbody></table></div>`
      : '<div class="state-block"><p>No bags in the warehouse. Collection trucks appear under <a href="#/upcoming">Upcoming</a> as Transport dispatches them.</p></div>'}`;
  el.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => navigate(/** @type {HTMLElement} */ (b).dataset.go)));
}
