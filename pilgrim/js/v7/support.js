import * as v7 from './api.js';
import { toast } from '../ui.js';

export function render(params, app) {
  app.innerHTML = `
    <h1 class="page-title" style="margin-block-end:var(--s4)">Contact support</h1>
    <form class="card stack gap-3" id="support-form" novalidate>
      <p class="fs-sm">Tell us what you need. Rabel Backend and Operations are notified immediately.</p>
      <div class="field"><label for="msg">Message</label><textarea id="msg" rows="4" maxlength="500" required></textarea></div>
      <div id="support-msg" class="fs-sm" role="status"></div>
      <button type="submit" class="btn btn-primary">Send</button>
      <p class="fs-xs muted">Support line: +966 12 000 0000 (demo)</p>
    </form>`;
  app.querySelector('#support-form').addEventListener('submit', (e) => {
    e.preventDefault();
    try { v7.support(app.querySelector('#msg').value); toast('Message sent to support.', 'success'); app.querySelector('#msg').value = ''; }
    catch (err) { app.querySelector('#support-msg').innerHTML = `<span style="color:var(--danger)">${err.message}</span>`; }
  });
  return { destroy, activeBagId: () => null };
}
export function destroy() { /* no-op */ }
