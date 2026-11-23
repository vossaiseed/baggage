/**
 * 24-hour forecast — flights whose cut-off falls in the next 24 h, most urgent first
 * (earliest cut-off; tie → more bags still to move). Recomputed every 5 minutes, as the
 * time rules require, and on every visit.
 */
import { read, chip, levelColor, untilText } from '../data.js';
import * as fl from '../../../shared/services/flightService.js';
import { WINDOW } from '../../../shared/constants.js';
import { esc, fmtDateTime, fmtTime, emptyState } from '../ui.js';

let el = null;
let timer = null;
let lastAt = null;

export function render(params, app) {
  el = app;
  draw();
  timer = setInterval(draw, WINDOW.forecastRefreshMin * 60000);
  return { destroy, refresh: draw, poll: draw };
}
export function destroy() { el = null; if (timer) clearInterval(timer); timer = null; }

function row(r) {
  const f = r.flight;
  const w = r.window;
  return `<article class="board-row ${r.level !== 'green' ? `alert-${r.level}` : ''}">
    <div class="board-top">
      <div>
        <strong class="fs-lg">${esc(f.code)}</strong> <span class="fs-sm muted">${esc(f.route || '')}</span>
        <div class="fs-sm muted">cut-off ${esc(fmtDateTime(f.cut_off_at))} · ${esc(untilText(f.cut_off_at))}</div>
      </div>
      <div class="row gap-2 wrap">
        ${chip(`P${r.priorityRank}`, 'blue')}
        ${chip(`${r.bagsToMove} still to move`, r.bagsToMove ? 'grey' : 'green')}
        ${chip(r.level === 'red' ? 'Red' : r.level === 'amber' ? 'Amber' : 'On schedule', levelColor(r.level === 'green' ? null : r.level))}
      </div>
    </div>
    ${w ? `<div class="fs-sm muted">Collection ${esc(fmtTime(w.collection.start))}–${esc(fmtTime(w.collection.end))} ·
      warehouse ${esc(fmtTime(w.warehouse.start))}–${esc(fmtTime(w.warehouse.end))} ·
      drive ${esc(fmtTime(w.drive.start))}–${esc(fmtTime(w.drive.end))} · at the airport by ${esc(fmtTime(w.redAt))}</div>` : ''}
    <div class="fs-sm">${r.counts.withTraveler} with travelers · ${r.counts.inTransit} in the line · ${r.counts.atAirport} at the airport · ${r.counts.loaded} on the aircraft</div>
    ${r.worstAlert ? `<div class="fs-sm level-${r.worstAlert.level}">${esc(r.worstAlert.message)}</div>` : ''}
    <div><a class="btn btn-ghost" href="#/flights/${esc(f.id)}">Bags &amp; details</a></div>
  </article>`;
}

function draw() {
  if (!el) return;
  const rows = read((s, u) => fl.forecastBoard(s, u, { now: Date.now() }), []) || [];
  lastAt = new Date();
  const red = rows.filter((r) => r.level === 'red').length;
  const amber = rows.filter((r) => r.level === 'amber').length;
  el.innerHTML = `
    <div class="page-header">
      <div><h1 class="page-title">24-hour forecast</h1>
        <p class="page-subtitle">Cut-off inside the next ${WINDOW.forecastHours} h · earliest first, then most bags still to move</p></div>
      <span class="last-updated">Recomputed every ${WINDOW.forecastRefreshMin} min · last ${esc(lastAt.toLocaleTimeString())}</span>
    </div>
    ${red || amber ? `<div class="critical-banner mb">${red ? `${red} flight(s) red` : ''}${red && amber ? ' · ' : ''}${amber ? `${amber} flight(s) amber` : ''}</div>` : ''}
    <div class="stack gap-3">${rows.map(row).join('') || emptyState({ message: 'No flight has a cut-off in the next 24 hours.' })}</div>`;
}
