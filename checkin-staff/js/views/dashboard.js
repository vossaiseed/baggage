/**
 * Departure v7 home for Check-in Staff: today's residence collections for MY
 * collection area. (There is no counter any more.) The full assignment flow —
 * route, identity, weigh, tag scan, count match — is built in Phase 3; until
 * then this screen shows the assignments already in the shared v7 store and
 * clearly separates read-only Legacy data.
 */
import { getSession } from '../store.js';
import { getStore as getV7Store } from '../../../shared/store.js';
import { scopeFilter } from '../../../shared/rbac.js';
import { esc, icon } from '../ui.js';

let appEl = null;

export function render(params, app) {
  appEl = app;
  draw();
  return { destroy, poll: draw, refresh: draw };
}

export function destroy() { appEl = null; }

function draw() {
  if (!appEl) return;
  const session = getSession();
  const state = getV7Store().get();
  const me = state.users.find((u) => u.employee_id === session?.employeeId);
  const mine = me ? scopeFilter(me, 'collectionAssignments', state.collectionAssignments) : [];
  const legacyCount = (state.legacy.appointments || []).length;
  appEl.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">Assignments</h1>
      <p class="page-subtitle">Residence collections — ${esc(session?.areaName || 'no area assigned')}</p></div></div>
    <div class="card" style="margin-block-end:var(--s6)">
      <h2 class="section-title">Today's residence collections</h2>
      ${mine.length ? `<p class="fs-sm">${mine.length} assignment${mine.length === 1 ? '' : 's'} in your area.</p>` : `
        <p class="fs-sm muted">${icon('map-pin', 16)} No assignments yet. Travelers book a collection slot at their residence; you will see them here sorted by flight priority.</p>`}
    </div>
    <div class="card">
      <h2 class="section-title">Legacy centre data <span class="chip chip-grey">Legacy · read-only</span></h2>
      <p class="fs-sm muted">${legacyCount} pre-v7 check-in-centre appointment${legacyCount === 1 ? '' : 's'} are kept for reference. Centre, counter and appointment screens are retired in Departure v7.</p>
    </div>`;
}
