/**
 * Departure v7 home for Check-in Staff: today's residence collections for MY collection area, grouped by
 * 2-hour slot and sorted by flight priority (P1 first). There is no counter: this list IS the loop.
 */
import { S, me } from '../v7.js';
import { listAssignments } from '../../../shared/services/checkinService.js';
import { esc, icon, fmtTime, fmtDate } from '../ui.js';
import { navigate } from '../router.js';

let el = null;
export function render(params, app) { el = app; draw(); return { destroy, poll: draw, refresh: draw }; }
export function destroy() { el = null; }

const STATUS_COLOR = { Assigned: 'blue', Rescheduled: 'blue', 'En Route': 'amber', Arrived: 'amber', Collected: 'green', 'Handed to Transport': 'green', 'Traveler Absent': 'red' };
const BP_COLOR = { Verified: 'green', Flagged: 'red', 'Not verified': 'grey' };

function card(it) {
  const a = it.assignment;
  const r = it.residence;
  return `<div class="asg-card" role="button" tabindex="0" data-open="${esc(a.id)}">
    <div class="asg-top"><span class="prio p${it.priority > 3 ? 99 : it.priority}">${it.priority > 50 ? '—' : `P${it.priority}`}</span>
      <strong>${esc(it.traveler?.name || '')}</strong><span class="chip chip-${STATUS_COLOR[a.status] || 'grey'}">${esc(a.status)}</span>
      ${it.routeOrder ? `<span class="chip chip-grey">Stop ${it.routeOrder}</span>` : ''}</div>
    <div class="asg-meta">${esc(it.flight?.code || '')} · ${esc(r ? `${r.building}, flat ${r.flat_no}` : 'no residence')}${r?.landmark ? ` · ${esc(r.landmark)}` : ''}</div>
    <div class="chips">
      <span class="chip chip-blue">${it.bags.length} bag${it.bags.length === 1 ? '' : 's'}</span>
      ${a.extra_bags ? `<span class="chip chip-amber">${a.extra_bags} extra — approval ${esc(String(a.extra_approval || '').toLowerCase())}</span>` : ''}
      <span class="chip chip-${BP_COLOR[it.boardingPass]}">Boarding pass: ${esc(it.boardingPass)}</span>
      <span class="chip chip-${it.releasedTags ? 'green' : 'grey'}">${it.releasedTags} tag${it.releasedTags === 1 ? '' : 's'} ready</span>
    </div>
    ${it.mapsUrl ? `<a class="btn btn-secondary" href="${esc(it.mapsUrl)}" target="_blank" rel="noopener" data-maps>${icon('map-pin', 16)} Open in Maps</a>` : ''}
  </div>`;
}

function draw() {
  if (!el) return;
  let groups; let user;
  try { user = me(); groups = listAssignments(S(), user, { now: Date.now() }); } catch (err) { el.innerHTML = `<div class="state-block error-state"><p>${esc(err.message)}</p></div>`; return; }
  const area = S().collectionAreas.find((a) => a.id === user.area_id);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const done = S().collectionAssignments.filter((a) => a.collection_area_id === user.area_id && ['Collected', 'Handed to Transport'].includes(a.status)).length;
  el.innerHTML = `
    <div class="page-wrap">
    <div class="page-header"><div><h1 class="page-title">Assignments</h1>
      <p class="page-subtitle">${esc(area?.name || 'No area assigned')} · ${total} to collect · ${done} done</p></div></div>
    ${total ? groups.map((g) => `
      <div class="slot-head"><h2>${g.slot ? `${esc(fmtDate(g.slot.start))}, ${esc(fmtTime(g.slot.start))}–${esc(fmtTime(g.slot.end))}` : 'No slot'}</h2><span class="fs-sm muted">${g.items.length} stop${g.items.length === 1 ? '' : 's'}</span></div>
      <div class="asg-list">${g.items.map(card).join('')}</div>`).join('')
      : `<div class="state-block"><p>No open collections in your area. Travelers book a slot at their residence and appear here, ordered by flight priority.</p></div>`}
    </div>`;
  el.querySelectorAll('[data-open]').forEach((c) => {
    const open = () => navigate(`#/a/${c.dataset.open}`);
    c.addEventListener('click', (e) => { if (!e.target.closest('[data-maps]')) open(); });
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });
}
