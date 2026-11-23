/**
 * Window Monitor app shell (departure v7). One screen: the 12-hour-window wall board.
 * The role is read-only (shared/rbac.js `readOnly: true`); the only action on the board is
 * raising a flight to Ops.
 */
import { isAuthed, getSession } from './session.js';
import { logout, user } from './data.js';
import { route, setGuard, setNotFound, startRouter, navigate, getCurrent } from './router.js';
import { icon, esc } from './ui.js';
import * as loginView from './views/login.js';
import * as boardView from './views/board.js';

let shellMounted = false;

function mountShell() {
  if (shellMounted) return;
  shellMounted = true;
  const s = getSession();
  document.body.innerHTML = `
    <a href="#main" class="skip-link">Skip to the board</a>
    <div id="app-shell" class="wb-shell">
      <header class="topbar wb-topbar">
        <div class="row gap-3 wrap">
          <span class="brand-name">Rabel</span>
          <span class="badge-env">DEMO</span>
          <span class="fs-sm fw-semibold">${esc(s?.name || '')}</span>
          <span class="fs-sm muted">${esc(user()?.employee_id || '')}</span>
          <span class="fs-sm muted">Read-only board</span>
        </div>
        <div class="row gap-2">
          <button type="button" class="btn btn-ghost" id="fullscreen">${icon('maximize', 16)} Full screen</button>
          <button type="button" class="btn btn-secondary" id="logout">${icon('log-out', 16)} Sign out</button>
        </div>
      </header>
      <main id="app" tabindex="-1"></main>
    </div>
    <div id="toast-root" aria-live="polite" aria-atomic="true"></div>`;
  document.getElementById('logout').addEventListener('click', () => { logout(); navigate('#/login'); });
  document.getElementById('fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => { /* blocked without a gesture */ });
  });
  window.lucide?.createIcons?.();
}

route('/login', (params) => {
  shellMounted = false;
  document.body.innerHTML = '<div id="bare-root"><main id="app" tabindex="-1"></main></div><div id="toast-root" aria-live="polite" aria-atomic="true"></div>';
  return loginView.render(params, document.getElementById('app'));
});
route('/', (params) => {
  mountShell();
  const r = boardView.render(params, document.getElementById('app'));
  window.lucide?.createIcons?.();
  return r;
});

setNotFound((app) => {
  mountShell();
  app.innerHTML = '<div class="state-block"><h1 class="fs-xl">404 — Page not found</h1><a class="btn btn-primary" href="#/">Back to the board</a></div>';
});

setGuard((p) => {
  if (p !== '/login' && (!isAuthed() || !user())) return '#/login';
  if (p === '/login' && isAuthed() && user()) return '#/';
  if (p !== '/login' && p !== '/') return '#/';
  return true;
});

startRouter();

/** The board is left running on a wall: refresh it on a timer, never mid-dialog. */
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (document.querySelector('.overlay, .drawer-overlay')) return;
  getCurrent()?.poll?.();
}, 30000);
