import { S, user } from '../data.js';
import { dashboardTiles } from '../../../shared/services/backendService.js';
import { esc, fmtRelative } from '../ui.js';
import { navigate } from '../router.js';

let el = null;
export function render(params, app) { el = app; draw(); return { destroy, refresh: draw, poll: draw }; }
export function destroy() { el = null; }

function draw() {
  if (!el) return;
  const t = dashboardTiles(S());
  const tone = (n, bad = 'warn') => (n === 0 ? 'ok' : bad);
  const tile = (n, label, tone2, link) => `<button type="button" class="tile ${tone2}" data-go="${link}" style="text-align:start;cursor:pointer"><span class="n">${n}</span><span class="l">${label}</span></button>`;
  const mine = S().notifications.filter((n) => n.roles?.includes('backend') || n.user_id === user()?.id).slice(-5).reverse();
  const noList = S().flights.filter((f) => f.no_airline_tag && !['Cancelled', 'Completed'].includes(f.status));
  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">Dashboard</h1><p class="page-subtitle">Departure data, tags and manifest at a glance</p></div></div>
    <div class="kpi-grid">
      ${tile(t.data_rows_pending, 'Data rows pending', tone(t.data_rows_pending), '#/data')}
      ${tile(t.unmapped_addresses, 'Unmapped addresses', tone(t.unmapped_addresses, 'bad'), '#/data')}
      ${tile(t.tags_to_release, 'Tags to release', tone(t.tags_to_release), '#/tags')}
      ${tile(t.boarding_passes_unverified, 'Boarding passes unverified', tone(t.boarding_passes_unverified), '#/boarding')}
      ${tile(t.manifest_gaps, 'Manifest gaps', tone(t.manifest_gaps, 'bad'), '#/manifest')}
    </div>
    ${noList.length ? `<div class="card" style="margin-block-end:var(--s5)"><strong>No airline tag list:</strong> ${noList.map((f) => `<span class="badge-noairline">${esc(f.code)}</span>`).join(' ')} <span class="muted fs-sm">— bags run on the Rabel internal tag only.</span></div>` : ''}
    <div class="card"><h2 class="section-title">Notifications</h2>
      ${mine.length ? `<ul class="stack gap-2">${mine.map((n) => `<li><strong class="fs-sm">${esc(n.title)}</strong> <span class="muted fs-xs">${esc(fmtRelative(n.at))}</span><div class="fs-sm">${esc(n.body)}</div></li>`).join('')}</ul>` : '<p class="muted fs-sm">Nothing new.</p>'}</div>`;
  el.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.go)));
}
