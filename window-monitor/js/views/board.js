/**
 * The wall board. Read-only, built for a screen on the wall: big type, colour from the time
 * rules (amber = a stage is past its slot, red = bags not at the airport by cut-off − 30 min),
 * and a countdown per flight. Redraws every minute; the forecast itself is recomputed every
 * 5 minutes by the rules, which is what the header line says.
 */
import { read, run, chip, levelColor, untilText } from '../data.js';
import * as mon from '../../../shared/services/monitorService.js';
import { esc, fmtTime, openDrawer, closeDrawer, emptyState } from '../ui.js';

let el = null;
let timer = null;

export function render(params, app) {
  el = app;
  draw();
  timer = setInterval(draw, 60000);
  return { destroy, refresh: draw, poll: draw };
}
export function destroy() { el = null; if (timer) clearInterval(timer); timer = null; }

/** Bar segments, in line order; `side` gathers the bags that left the line (held, rebooked, returned). */
const SEGMENTS = [['withTraveler', 'seg-declared'], ['inTransit', 'seg-moving'], ['atAirport', 'seg-airport'], ['loaded', 'seg-done'], ['side', 'seg-side']];
const side = (c, k) => (k === 'side' ? c.held + c.rebooked + c.returned : c[k]);

function flightCard(f) {
  return `<article class="wb-flight level-${f.level}">
    <div class="wb-flight-head">
      <div>
        <span class="wb-code">${esc(f.flight.code)}</span>
        <span class="wb-route">${esc(f.flight.route || '')}</span>
      </div>
      <div class="wb-count">
        <span class="wb-until">${esc(untilText(f.flight.cut_off_at))}</span>
        <span class="wb-cutoff">cut-off ${esc(fmtTime(f.flight.cut_off_at))}</span>
      </div>
    </div>
    <div class="wb-bar">
      ${SEGMENTS.filter(([k]) => side(f.counts, k) > 0)
    .map(([k, cls]) => `<span class="${cls}" style="flex:${side(f.counts, k)}"></span>`).join('') || '<span class="seg-empty" style="flex:1"></span>'}
    </div>
    <div class="wb-nums">
      <span><b>${f.counts.withTraveler}</b> with travelers</span>
      <span><b>${f.counts.inTransit}</b> in the line</span>
      <span><b>${f.counts.atAirport}</b> at the airport</span>
      <span><b>${f.counts.loaded}</b> loaded</span>
      ${side(f.counts, 'side') ? `<span><b>${side(f.counts, 'side')}</b> held / rebooked</span>` : ''}
      <span class="wb-pri">P${f.priorityRank}</span>
    </div>
    ${f.worstAlert ? `<div class="wb-alert">${esc(f.worstAlert.message)}</div>` : ''}
    <button type="button" class="btn btn-ghost wb-raise" data-raise="${esc(f.flight.id)}" data-code="${esc(f.flight.code)}">Raise to Ops</button>
  </article>`;
}

function areaChip(a) {
  return `<div class="wb-area ${a.alertLevel ? `level-${a.alertLevel}` : ''}">
    <span class="wb-area-name">${esc(a.area.name)}</span>
    <span class="wb-area-num"><b>${a.pendingPickups}</b> waiting</span>
    <span class="fs-xs muted">${a.assignmentsOpen} collection(s) · ${a.activeTrips} trip(s)</span>
  </div>`;
}

function draw() {
  if (!el) return;
  const b = read((s, u) => mon.wallBoard(s, u, { now: Date.now() }), null);
  if (!b) return;
  const at = new Date(b.at);
  el.innerHTML = `
    <div class="wb-head level-${b.worstLevel}">
      <div>
        <h1 class="wb-title">12-hour window</h1>
        <p class="wb-sub">${b.totals.flights} flight(s) in the next 24 h · ${b.totals.bagsToMove} bag(s) still to move ·
          recomputed every ${b.refreshMin} min · ${esc(at.toLocaleTimeString())}</p>
      </div>
      <div class="wb-status">
        ${b.totals.red ? `<span class="wb-pill red">${b.totals.red} red</span>` : ''}
        ${b.totals.amber ? `<span class="wb-pill amber">${b.totals.amber} amber</span>` : ''}
        ${!b.totals.red && !b.totals.amber ? '<span class="wb-pill green">All on schedule</span>' : ''}
      </div>
    </div>

    <div class="wb-grid">${b.flights.map(flightCard).join('') || emptyState({ message: 'No flight has a cut-off in the next 24 hours.' })}</div>

    <section class="wb-strip">
      <h2 class="wb-strip-title">Collection areas</h2>
      <div class="wb-areas">${b.areas.map(areaChip).join('')}</div>
    </section>

    <section class="wb-strip">
      <h2 class="wb-strip-title">Right now</h2>
      <div class="wb-areas">
        <div class="wb-area"><span class="wb-area-name">Trucks on the road</span><span class="wb-area-num"><b>${b.trips.active}</b></span>
          <span class="fs-xs muted">${b.trips.collection} collection · ${b.trips.airport} airport</span></div>
        <div class="wb-area ${b.exceptions.bySeverity.Critical + b.exceptions.bySeverity.High ? 'level-red' : ''}">
          <span class="wb-area-name">Open exceptions</span><span class="wb-area-num"><b>${b.exceptions.open}</b></span>
          <span class="fs-xs muted">${b.exceptions.bySeverity.Critical} critical · ${b.exceptions.bySeverity.High} high</span></div>
        <div class="wb-area"><span class="wb-area-name">Unassigned</span><span class="wb-area-num"><b>${b.exceptions.unassigned}</b></span>
          <span class="fs-xs muted">${b.exceptions.oldest ? `oldest ${b.exceptions.oldest.ageMinutes} min` : 'nothing waiting'}</span></div>
      </div>
      ${[...b.exceptions.critical, ...b.exceptions.high].length ? `<ul class="wb-exc">
        ${[...b.exceptions.critical, ...b.exceptions.high].slice(0, 6).map((r) => `<li>${chip(r.exception.severity, levelColor('red'))}
          <strong>${esc(r.exception.type)}</strong> ${esc(r.flight?.code || r.area?.name || '')} — ${esc(r.exception.notes || r.exception.value || '')}</li>`).join('')}
      </ul>` : ''}
    </section>`;

  el.querySelectorAll('[data-raise]').forEach((btn) => btn.addEventListener('click', () => openRaise(btn.getAttribute('data-raise'), btn.getAttribute('data-code'))));
}

function openRaise(flightId, code) {
  const d = openDrawer({
    title: `Raise ${code} to Ops`,
    bodyHtml: `
      <p class="text-2">The board changes nothing itself. This sends the Operations Manager a critical notification.</p>
      <div class="field"><label for="r-msg">What should Ops look at? <span class="req">*</span></label>
        <textarea id="r-msg" rows="4" placeholder="Three bags still at the residence with 40 minutes to the cut-off."></textarea></div>`,
    footerHtml: '<button type="button" class="btn btn-primary" id="r-go">Send to Ops</button>',
  });
  d.el.querySelector('#r-go').addEventListener('click', () => run(
    (s, c) => mon.alertOps(s, { flightId, message: /** @type {HTMLTextAreaElement} */ (d.el.querySelector('#r-msg')).value }, c),
    'Ops has been notified.', () => { closeDrawer(); draw(); },
  ));
}
