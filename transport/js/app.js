/** Transport app shell: Manager (home "/") and Staff (home "/trips") share one console. */
import { isAuthed, getSession } from './session.js';
import { logout, user, isManager } from './data.js';
import { route, setGuard, setNotFound, startRouter, getCurrent } from './router.js';
import { icon, esc } from './ui.js';
import * as loginView from './views/login.js';
import * as dispatchView from './views/manager/dispatch.js';
import * as windowBoardView from './views/manager/windowBoard.js';
import * as staffView from './views/manager/staff.js';
import * as driversView from './views/manager/drivers.js';
import * as trucksView from './views/manager/trucks.js';
import * as reportsView from './views/manager/reports.js';
import * as tripsView from './views/staff/trips.js';
import * as tripView from './views/staff/trip.js';

const MANAGER_NAV = [
  { hash: '#/', match: '/', label: 'Dispatch', iconName: 'send' },
  { hash: '#/staff', match: '/staff', label: 'Staff', iconName: 'users' },
  { hash: '#/drivers', match: '/drivers', label: 'Drivers', iconName: 'id-card' },
  { hash: '#/trucks', match: '/trucks', label: 'Trucks', iconName: 'truck' },
  { hash: '#/window', match: '/window', label: 'Window board', iconName: 'layout-dashboard' },
  { hash: '#/reports', match: '/reports', label: 'Reports', iconName: 'bar-chart-3' },
];
const STAFF_NAV = [{ hash: '#/trips', match: '/trips', label: 'Trips', iconName: 'route' }];
const MANAGER_PATHS = ['/', '/staff', '/drivers', '/trucks', '/window', '/reports'];
const STAFF_PATHS = ['/trips'];

let shell = false;
const path = () => (location.hash.replace(/^#/, '') || '/').split('?')[0];
const renderIcons = () => window.lucide?.createIcons?.();

function navHtml() {
  const p = path();
  const nav = isManager() ? MANAGER_NAV : STAFF_NAV;
  return nav.map((n) => `<a class="nav-item" href="${n.hash}" ${(n.match === '/' ? p === '/' : p.startsWith(n.match)) ? 'aria-current="page"' : ''}>${icon(n.iconName, 20)}<span class="nav-label-text">${esc(n.label)}</span></a>`).join('');
}

function mountShell() {
  if (shell) { document.getElementById('nav-list').innerHTML = navHtml(); renderIcons(); return; }
  shell = true;
  const s = getSession();
  document.body.innerHTML = `
    <a href="#main" class="skip-link">Skip to main content</a>
    <div id="app-shell">
      <nav class="sidebar" aria-label="Primary"><div class="brand"><span class="brand-name">Rabel</span><span class="brand-ar">Transport</span></div><div class="stack gap-1" id="nav-list">${navHtml()}</div></nav>
      <header class="topbar"><div class="row gap-3"><span class="badge-env">DEMO</span><span class="fs-sm fw-semibold">${esc(s?.name || '')}</span><span class="fs-sm muted">${esc(user()?.id || '')}</span></div>
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
route('/', wrap(dispatchView));
route('/staff', wrap(staffView));
route('/drivers', wrap(driversView));
route('/trucks', wrap(trucksView));
route('/window', wrap(windowBoardView));
route('/reports', wrap(reportsView));
route('/trips', wrap(tripsView));
route('/trips/:id', wrap(tripView));

setNotFound((app) => { mountShell(); app.innerHTML = `<div class="state-block"><h1 class="fs-xl">404</h1><a class="btn btn-primary" href="${isManager() ? '#/' : '#/trips'}">Back</a></div>`; });

setGuard((p) => {
  if (p !== '/login' && (!isAuthed() || !user())) return '#/login';
  if (p === '/login' && isAuthed() && user()) return isManager() ? '#/' : '#/trips';
  if (p === '/login') return true;
  const allowed = isManager() ? MANAGER_PATHS : STAFF_PATHS;
  if (!allowed.some((a) => p === a || (a !== '/' && p.startsWith(`${a}/`)))) return isManager() ? '#/' : '#/trips';
  return true;
});

startRouter();
setInterval(() => { if (document.visibilityState === 'visible' && !document.querySelector('.overlay, .drawer-overlay') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) getCurrent()?.poll?.(); }, 15000);
