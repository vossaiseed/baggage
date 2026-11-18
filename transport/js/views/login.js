import { login } from '../data.js';
import { esc, toast } from '../ui.js';
import { navigate } from '../router.js';

const DEMO_ACCOUNTS = [
  { label: 'Rashid', employeeId: 'TM-001', pin: '1234', hint: 'Transport Manager' },
  { label: 'Hamza', employeeId: 'TS-001', pin: '1234', hint: 'Transport Staff — Aziziyah' },
  { label: 'Idris', employeeId: 'TS-002', pin: '1234', hint: 'Transport Staff — Al-Awali' },
];

export function render(params, app) {
  app.innerHTML = `
    <div class="login-shell"><div class="login-card">
      <div class="brand" style="margin-block-end:var(--s6)"><span class="brand-name fs-xl">Rabel</span><span class="brand-ar">رابل — خدمة أمتعة الحجاج</span></div>
      <h1 class="fs-lg">Transport sign in</h1>
      <p class="muted fs-sm" style="margin-block-end:var(--s5)">Managers dispatch drivers and trucks; staff run collection trips from the residence pickup point to the warehouse.</p>
      <div id="login-alert" role="alert"></div>
      <form id="login-form" novalidate>
        <div class="field"><label for="employeeId">Employee ID <span class="req">*</span></label><input id="employeeId" type="text" autocomplete="username" placeholder="TM-001 or TS-001" required /></div>
        <div class="field"><label for="pin">PIN <span class="req">*</span></label><input id="pin" type="password" inputmode="numeric" maxlength="4" autocomplete="current-password" required /></div>
        <button type="submit" class="btn btn-primary btn-lg btn-block">Sign in</button>
      </form>
      <p class="fs-sm muted" style="margin-block-start:var(--s5)">Demo accounts</p>
      <div class="demo-chip-list">${DEMO_ACCOUNTS.map((d, i) => `<button type="button" class="demo-chip" data-demo="${i}">${esc(d.label)} <span class="muted">· ${esc(d.hint)}</span></button>`).join('')}</div>
    </div></div>`;
  const form = app.querySelector('#login-form');
  app.querySelectorAll('[data-demo]').forEach((btn) => btn.addEventListener('click', () => {
    const d = DEMO_ACCOUNTS[Number(btn.dataset.demo)];
    form.employeeId.value = d.employeeId; form.pin.value = d.pin;
  }));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    try {
      const u = login(form.employeeId.value.trim(), form.pin.value.trim());
      toast('Signed in.', 'success');
      navigate(u.role === 'transport_manager' ? '#/' : '#/trips');
    } catch (err) {
      app.querySelector('#login-alert').innerHTML = `<div style="background:var(--danger-soft);padding:var(--s3);border-radius:var(--r-sm);margin-block-end:var(--s3)">${esc(err.message)}</div>`;
    }
  });
  return { destroy() { /* none */ } };
}
export function destroy() { /* none */ }
