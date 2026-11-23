/** Backend Team app shell: sidebar + routes. All data goes through ../../shared services. */
import { isAuthed, getSession } from './session.js';
import { logout, user } from './data.js';
import { route, setGuard, setNotFound, startRouter, getCurrent } from './router.js';
import { icon, esc } from './ui.js';
import * as loginView from './views/login.js';
import * as dashboardView from './views/dashboard.js';
import * as collectionView from './views/collection.js';
import * as tagsView from './views/tags.js';
import * as boardingView from './views/boarding.js';
import * as verificationView from './views/verification.js';
import * as manifestView from './views/manifest.js';

const NAV = [
  { hash: '#/', match: '/', label: 'Dashboard', iconName: 'layout-dashboard' },
  { hash: '#/data', match: '/data', label: 'Data collection', iconName: 'database' },
  { hash: '#/tags', match: '/tags', label: 'Tags', iconName: 'tag' },
  { hash: '#/boarding', match: '/boarding', label: 'Boarding pass', iconName: 'ticket' },
  { hash: '#/verification', match: '/verification', label: 'Tag verification', iconName: 'scan-barcode' },
  { hash: '#/manifest', match: '/manifest', label: 'Manifest', iconName: 'plane' },
];
let shell = false;
const path = () => (location.hash.replace(/^#/, '') || '/').split('?')[0];
const renderIcons = () => window.lucide?.createIcons?.();

function navHtml() {
  const p = path();
  return NAV.map((n) => `<a class="nav-item" href="${n.hash}" ${(n.match === '/' ? p === '/' : p.startsWith(n.match)) ? 'aria-current="page"' : ''}>${icon(n.iconName, 20)}<span class="nav-label-text">${esc(n.label)}</span></a>`).join('');
}
function mountShell() {
  if (shell) { document.getElementById('nav-list').innerHTML = navHtml(); renderIcons(); return; }
  shell = true;
  const s = getSession();
  document.body.innerHTML = `
    <a href="#main" class="skip-link">Skip to main content</a>
    <div id="app-shell">
      <nav class="sidebar" aria-label="Primary"><div class="brand"><span class="brand-name">Rabel</span><span class="brand-ar">Backend Team</span></div><div class="stack gap-1" id="nav-list">${navHtml()}</div></nav>
      <header class="topbar"><div class="row gap-3"><span class="badge-env">DEMO</span><span class="fs-sm fw-semibold">${esc(s?.name || '')}</span><span class="fs-sm muted">${esc(user()?.employee_id || '')}</span></div>
        <button type="button" class="btn btn-secondary" id="logout">${icon('log-out', 16)} Sign out</button></header>
      <main id="app" tabindex="-1"></main>
    </div><div id="toast-root" aria-live="polite" aria-atomic="true"></div>`;
  document.getElementById('logout').addEventListener('click', () => { logout(); location.hash = '#/login'; });
  renderIcons();
}
function mountBare() {
  shell = false;
  document.body.innerHTML = '<div id="bare-root"><main id="app" tabindex="-1"></main></div><div id="toast-root" aria-live="polite" aria-atomic="true"></div>';
}
const wrap = (view) => (params) => { mountShell(); const r = view.render(params, document.getElementById('app')); renderIcons(); return r || { destroy: view.destroy }; };

route('/login', () => { mountBare(); return loginView.render({}, document.getElementById('app')); });
route('/', wrap(dashboardView));
route('/data', wrap(collectionView));
route('/tags', wrap(tagsView));
route('/boarding', wrap(boardingView));
route('/verification', wrap(verificationView));
route('/manifest', wrap(manifestView));
setNotFound((app) => { mountShell(); app.innerHTML = '<div class="state-block"><h1 class="fs-xl">404</h1><a class="btn btn-primary" href="#/">Back to dashboard</a></div>'; });
setGuard((p) => {
  if (p !== '/login' && (!isAuthed() || !user())) return '#/login';
  if (p === '/login' && isAuthed() && user()) return '#/';
  return true;
});
startRouter();
setInterval(() => { if (document.visibilityState === 'visible' && !document.querySelector('.overlay, .drawer-overlay') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) getCurrent()?.poll?.(); }, 15000);
