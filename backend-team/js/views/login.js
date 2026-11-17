import { login } from '../data.js';
import { esc, toast } from '../ui.js';
import { navigate } from '../router.js';

export function render(params, app) {
  app.innerHTML = `
    <div class="login-shell"><div class="login-card">
      <div class="brand" style="margin-block-end:var(--s6)"><span class="brand-name fs-xl">Rabel</span><span class="brand-ar">رابل — خدمة أمتعة الحجاج</span></div>
      <h1 class="fs-lg">Backend Team sign in</h1>
      <p class="muted fs-sm" style="margin-block-end:var(--s5)">Nusuk &amp; airline data, airline tags, boarding passes and manifest.</p>
      <div id="login-alert" role="alert"></div>
      <form id="login-form" novalidate>
        <div class="field"><label for="employeeId">Employee ID <span class="req">*</span></label><input id="employeeId" type="text" autocomplete="username" placeholder="BE-001" required /></div>
        <div class="field"><label for="pin">PIN <span class="req">*</span></label><input id="pin" type="password" inputmode="numeric" maxlength="4" autocomplete="current-password" required /></div>
        <button type="submit" class="btn btn-primary btn-lg btn-block">Sign in</button>
      </form>
      <p class="fs-sm muted" style="margin-block-start:var(--s5)">Demo account</p>
      <div class="demo-chip-list"><button type="button" class="demo-chip" id="demo">Khalid · BE-001</button></div>
    </div></div>`;
  const form = app.querySelector('#login-form');
  app.querySelector('#demo').addEventListener('click', () => { form.employeeId.value = 'BE-001'; form.pin.value = '1234'; });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    try { login(form.employeeId.value.trim(), form.pin.value.trim()); toast('Signed in.', 'success'); navigate('#/'); }
    catch (err) { app.querySelector('#login-alert').innerHTML = `<div style="background:var(--danger-soft);padding:var(--s3);border-radius:var(--r-sm);margin-block-end:var(--s3)">${esc(err.message)}</div>`; }
  });
  return { destroy() { /* none */ } };
}
export function destroy() { /* none */ }
