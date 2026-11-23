/**
 * Departure — Seal check: the one thing that happens before a truck's doors open. The seal the
 * Transport Staff member fitted at the warehouse must be the seal on the door. A wrong or broken
 * seal raises a High "Seal Broken" exception and tells Ops — it does not block the offload, because
 * leaving bags on a truck past the cut-off is worse than unloading them under an open exception.
 */
import { S, user, run, chip, esc, blockedHtml } from './data.js';
import * as ap from '../../../shared/services/airportService.js';
import { fmtDateTime, toast } from '../ui.js';
import { navigate } from '../router.js';

let el = null;
export function render(params, app) { el = app; draw(); return { destroy, refresh: draw, poll: draw }; }
export function destroy() { el = null; }

function truckCard(r) {
  const t = r.trip;
  return `<div class="card stack gap-3">
    <div class="row gap-2 wrap" style="align-items:center">
      <strong class="fs-md">${esc(t.truck_id)}</strong>${chip('At the gate', 'amber')}
      ${r.priority <= 3 ? chip(`P${r.priority}`, 'blue') : ''}
    </div>
    <div class="fs-sm">${esc(r.warehouse?.name || 'Warehouse')} · <strong>${t.bag_ids.length}</strong> bag(s) · ${esc(r.flights.join(', ') || '—')}</div>
    <div class="fs-xs muted">${esc(r.driver?.name || '')} · arrived ${esc(fmtDateTime(t.arrived_at))}</div>
    <form class="stack gap-3" data-seal="${esc(t.id)}">
      <div class="field">
        <label for="seal-${esc(t.id)}">Seal number on the door <span class="req">*</span></label>
        <input id="seal-${esc(t.id)}" name="sealNo" type="text" autocomplete="off" placeholder="e.g. SEAL-4471" required />
        <div class="hint">Read it off the seal itself — do not copy it from the paperwork.</div>
      </div>
      <label class="checkbox-row"><input type="checkbox" name="broken" /> The seal is broken, cut or missing</label>
      <div class="field"><label for="note-${esc(t.id)}">Note (optional)</label><input id="note-${esc(t.id)}" name="note" type="text" placeholder="What you saw" /></div>
      <button type="submit" class="btn btn-primary btn-lg">Record the seal check</button>
    </form>
  </div>`;
}

function checkedCard(r) {
  const c = r.trip.seal_check;
  return `<div class="card stack gap-2 ${c.intact ? '' : 'alert-red'}">
    <div class="row gap-2 wrap" style="align-items:center"><strong class="fs-md">${esc(r.trip.truck_id)}</strong>
      ${c.intact ? chip('Seal matches', 'green') : chip('Seal problem — Ops told', 'red')}</div>
    <div class="fs-sm">Expected <span class="mono">${esc(c.expected || '—')}</span> · read <span class="mono">${esc(c.seen)}</span>${c.note ? ` · ${esc(c.note)}` : ''}</div>
    <div class="fs-xs muted">Checked ${esc(fmtDateTime(c.at))}${c.exception_id ? ` · exception ${esc(c.exception_id)}` : ''}</div>
    <div class="row gap-2"><a class="btn btn-primary" href="#/dep/offload/${esc(r.trip.id)}">Offload ${esc(r.trip.truck_id)}</a></div>
  </div>`;
}

function draw() {
  if (!el) return;
  const blocked = blockedHtml('No airport is assigned to this account, so no trucks arrive here.');
  if (blocked) { el.innerHTML = blocked; return; }
  let queue; let checked;
  try {
    const atGate = ap.incomingTrips(S(), user(), { now: Date.now() }).filter((r) => r.trip.status === 'Arrived');
    queue = atGate.filter((r) => !r.sealChecked);
    checked = atGate.filter((r) => r.sealChecked);
  } catch (err) { el.innerHTML = `<div class="state-block error-state"><p>${esc(err.message)}</p></div>`; return; }

  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">Seal check</h1>
      <p class="page-subtitle">${queue.length} truck(s) waiting to be opened</p></div></div>
    ${queue.length ? `<div class="grid grid-cols-2 gap-3">${queue.map(truckCard).join('')}</div>`
    : '<div class="state-block"><p>No sealed truck is waiting. Trucks appear here once Transport marks them arrived at the gate — see <a href="#/dep/incoming">Incoming trucks</a>.</p></div>'}
    ${checked.length ? `<h2 class="section-title" style="margin-block-start:var(--s6)">Checked, ready to offload</h2>
      <div class="grid grid-cols-2 gap-3">${checked.map(checkedCard).join('')}</div>` : ''}`;

  el.querySelectorAll('[data-seal]').forEach((form) => form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(/** @type {HTMLFormElement} */ (form));
    const tripId = /** @type {HTMLElement} */ (form).dataset.seal;
    const r = run((s, c) => ap.checkSeal(s, tripId, {
      sealNo: String(fd.get('sealNo') || ''), intact: !fd.get('broken'), note: String(fd.get('note') || ''),
    }, c));
    if (!r) return; // threw — run() already toasted it
    toast(r.message, r.ok ? 'success' : 'error');
    if (r.ok) navigate(`#/dep/offload/${tripId}`); else draw();
  }));
}
