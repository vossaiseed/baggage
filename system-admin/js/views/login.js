/** System Admin sign-in — employee ID + PIN, then the demo 2FA code (123456). */
import { startLogin, completeLogin } from '../data.js';
import { toast, announce, esc } from '../ui.js';
import { navigate } from '../router.js';

const DEMO_ACCOUNTS = [{ label: 'Zaid Al-Harbi', employeeId: 'ADM-001', pin: '1234' }];

/** @param {object} params @param {HTMLElement} app */
export function render(params, app) {
  let step = 1;

  function draw() {
    app.innerHTML = `
      <div class="login-shell">
        <div class="login-card">
          <div class="brand" style="margin-block-end:var(--s6)">
            <span class="brand-name fs-xl">Rabel</span>
            <span class="brand-ar">رابل — خدمة أمتعة الحجاج</span>
          </div>
          <h1 class="fs-lg">System Admin sign in</h1>
          <p class="muted fs-sm" style="margin-block-end:var(--s5)">Accounts, integrations, the airline policy table and the audit trail.</p>
          <div id="login-alert" role="alert"></div>
          ${step === 1 ? `
            <form id="login-form" novalidate>
              <div class="field">
                <label for="employeeId">Employee ID <span class="req">*</span></label>
                <input id="employeeId" name="employeeId" type="text" autocomplete="username" placeholder="ADM-001" required />
              </div>
              <div class="field">
                <label for="pin">PIN <span class="req">*</span></label>
                <input id="pin" name="pin" type="password" inputmode="numeric" maxlength="4" autocomplete="current-password" required />
              </div>
              <button type="submit" class="btn btn-primary btn-lg btn-block">Continue</button>
            </form>
            <p class="fs-sm muted" style="margin-block-start:var(--s5)">Demo account</p>
            <div class="demo-chip-list">
              ${DEMO_ACCOUNTS.map((d, i) => `<button type="button" class="demo-chip" data-demo="${i}">${esc(d.label)}</button>`).join('')}
            </div>`
    : `
            <form id="otp-form" novalidate>
              <div class="field">
                <label for="otp">Verification code <span class="req">*</span></label>
                <input id="otp" name="otp" type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="123456" required />
                <div class="fs-xs muted">Demo code: 123456</div>
              </div>
              <button type="submit" class="btn btn-primary btn-lg btn-block">Sign in</button>
            </form>
            <button type="button" class="btn btn-ghost" id="back" style="margin-block-start:var(--s3)">Back</button>`}
        </div>
      </div>`;

    const fail = (msg) => {
      app.querySelector('#login-alert').innerHTML = `<div class="field error" style="background:var(--danger-soft);padding:var(--s3);border-radius:var(--r-sm);margin-block-end:var(--s3)">${esc(msg)}</div>`;
      announce(msg);
    };

    if (step === 1) {
      const form = /** @type {HTMLFormElement} */ (app.querySelector('#login-form'));
      app.querySelectorAll('[data-demo]').forEach((btn) => btn.addEventListener('click', () => {
        const d = DEMO_ACCOUNTS[Number(/** @type {HTMLElement} */ (btn).dataset.demo)];
        form.employeeId.value = d.employeeId;
        form.pin.value = d.pin;
        form.employeeId.focus();
      }));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!form.employeeId.value.trim() || !/^\d{4}$/.test(form.pin.value.trim())) { fail('Employee ID and a 4-digit PIN are required.'); return; }
        try { startLogin(form.employeeId.value.trim(), form.pin.value.trim()); step = 2; draw(); } catch (err) { fail(err.message); }
      });
    } else {
      const form = /** @type {HTMLFormElement} */ (app.querySelector('#otp-form'));
      app.querySelector('#back').addEventListener('click', () => { step = 1; draw(); });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        try {
          completeLogin(form.otp.value);
          toast('Signed in.', 'success');
          navigate('#/');
        } catch (err) { fail(err.message); }
      });
      form.otp.focus();
    }
  }

  draw();
  return { destroy };
}

/** No timers to clean up. */
export function destroy() { /* no-op */ }
