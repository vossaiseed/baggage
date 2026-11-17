import * as v7 from './api.js';
import * as legacy from '../api.js';
import { toast, announce, esc } from '../ui.js';
import { navigate } from '../router.js';

const V7_DEMO = [
  { label: 'Siti — booked, SV 1821', id: '2000000001', passport: 'C1234567' },
  { label: 'Ahmad — to book, GA 981', id: '2000000004', passport: 'BX0987654' },
  { label: 'Mariam — PK 760 (no extra bags)', id: 'PKT9S2', passport: 'PK4455667' },
  { label: 'Aisha — cancelled flight', id: '2000000010', passport: 'PK1122334' },
];
// Arrival demo travelers (unchanged arrival flow)
const ARRIVAL_DEMO = [
  { label: 'Aisyah — delivery today', id: '1000000005', passport: 'C7654321' },
  { label: 'Ahmed — arriving', id: '1000000006', passport: 'AB1234567' },
  { label: 'Hassan — missing bag', id: '1000000007', passport: 'A01234567' },
];

/** Departure v7 login: Nusuk ID or booking ref + passport → OTP. Arrival demo travelers fall through to the old login. */
export function render(params, app) {
  stepCredentials();

  function shell(inner) {
    app.innerHTML = `
      <div class="login-shell"><div class="login-card">
        <div class="brand" style="margin-block-end:var(--s6);align-items:center;text-align:center">
          <span class="brand-name fs-xl">Rabel</span><span class="brand-ar">رابل — خدمة أمتعة الحجاج</span>
        </div>${inner}
      </div></div>`;
  }
  const alertHtml = (m) => `<div class="field error" role="alert" style="background:var(--danger-soft);padding:var(--s3);border-radius:var(--r-sm);margin-block-end:var(--s3)">${esc(m)}</div>`;

  function stepCredentials(error = '') {
    shell(`
      <h1 class="fs-lg" style="text-align:center">Sign in with Nusuk</h1>
      <p class="muted fs-sm" style="margin-block-end:var(--s5);text-align:center">Use your Nusuk ID or airline booking reference.</p>
      <div id="login-alert" role="alert">${error ? alertHtml(error) : ''}</div>
      <form id="login-form" novalidate>
        <div class="field"><label for="idOrRef">Nusuk ID or booking reference <span class="req">*</span></label>
          <input id="idOrRef" name="idOrRef" type="text" autocomplete="username" placeholder="2000000001 or SVK7Q1" required /></div>
        <div class="field"><label for="passport">Passport number <span class="req">*</span></label>
          <input id="passport" name="passport" type="text" autocomplete="off" placeholder="C1234567" required style="text-transform:uppercase" /></div>
        <button type="submit" class="btn btn-primary btn-lg btn-block" id="login-submit"><span class="label">Continue</span></button>
      </form>
      <p class="fs-sm muted" style="margin-block-start:var(--s5);text-align:center">Demo travelers — departure</p>
      <div class="demo-chip-list" style="justify-content:center">${V7_DEMO.map((d, i) => `<button type="button" class="demo-chip" data-v7="${i}">${esc(d.label)}</button>`).join('')}</div>
      <p class="fs-sm muted" style="margin-block-start:var(--s4);text-align:center">Demo travelers — arrival</p>
      <div class="demo-chip-list" style="justify-content:center">${ARRIVAL_DEMO.map((d, i) => `<button type="button" class="demo-chip" data-arr="${i}">${esc(d.label)}</button>`).join('')}</div>`);
    const form = app.querySelector('#login-form');
    const fill = (d) => { form.idOrRef.value = d.id; form.passport.value = d.passport; form.passport.focus(); };
    app.querySelectorAll('[data-v7]').forEach((b) => b.addEventListener('click', () => fill(V7_DEMO[Number(b.dataset.v7)])));
    app.querySelectorAll('[data-arr]').forEach((b) => b.addEventListener('click', () => fill(ARRIVAL_DEMO[Number(b.dataset.arr)])));
    form.passport.addEventListener('input', () => { form.passport.value = form.passport.value.toUpperCase(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = form.idOrRef.value.trim();
      const passport = form.passport.value.trim();
      if (!id || !passport) { stepCredentials('Enter your Nusuk ID or booking reference and your passport number.'); return; }
      try {
        const t = v7.lookup(id, passport);
        stepOtp(t);
        return;
      } catch (err) {
        if (err.code !== 'NOT_FOUND') { stepCredentials(err.message); return; }
      }
      // Not a v7 (departure) traveler → arrival demo traveler (legacy login), else "not found".
      try {
        if (/^\d{10}$/.test(id)) { await legacy.login(id, passport); toast('Welcome back.', 'success'); navigate('#/'); return; }
      } catch { /* fall through */ }
      announce('Booking not found');
      stepCredentials('Booking not found in Nusuk or airline data');
    });
  }

  function stepOtp(t, error = '') {
    shell(`
      <h1 class="fs-lg" style="text-align:center">Enter your code</h1>
      <p class="muted fs-sm" style="margin-block-end:var(--s5);text-align:center">We sent a 6-digit code by SMS to the phone registered with Nusuk. <span class="chip chip-grey">Demo code: 123456</span></p>
      <div role="alert">${error ? alertHtml(error) : ''}</div>
      <form id="otp-form" novalidate>
        <div class="field"><label for="otp">Verification code <span class="req">*</span></label>
          <input id="otp" name="otp" type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required /></div>
        <button type="submit" class="btn btn-primary btn-lg btn-block">Verify &amp; sign in</button>
        <button type="button" class="btn btn-ghost btn-block" id="otp-back" style="margin-block-start:var(--s2)">Back</button>
      </form>`);
    app.querySelector('#otp').focus();
    app.querySelector('#otp-back').addEventListener('click', () => stepCredentials());
    app.querySelector('#otp-form').addEventListener('submit', (e) => {
      e.preventDefault();
      try {
        v7.signIn(t.id, app.querySelector('#otp').value);
        toast('Welcome back.', 'success');
        navigate('#/');
      } catch (err) { stepOtp(t, err.message); }
    });
  }
  return { destroy() { /* no timers */ } };
}

export function destroy() { /* no-op */ }
