/** Operations Manager sign-in — authenticates against the shared v7 users. */
import { login } from '../data.js';
import { toast, announce, esc } from '../ui.js';
import { navigate } from '../router.js';

const DEMO_ACCOUNTS = [{ label: 'Layla Al-Harthi', employeeId: 'OPS-001', pin: '1234' }];

/** @param {object} params @param {HTMLElement} app */
export function render(params, app) {
  app.innerHTML = `
    <div class="login-shell">
      <div class="login-card">
        <div class="brand" style="margin-block-end:var(--s6)">
          <span class="brand-name fs-xl">Rabel</span>
          <span class="brand-ar">رابل — خدمة أمتعة الحجاج</span>
        </div>
        <h1 class="fs-lg">Operations Manager sign in</h1>
        <p class="muted fs-sm" style="margin-block-end:var(--s5)">Flights and cut-offs, staff, collection areas, the 24-hour forecast, exceptions and closure.</p>
        <div id="login-alert" role="alert"></div>
        <form id="login-form" novalidate>
          <div class="field">
            <label for="employeeId">Employee ID <span class="req">*</span></label>
            <input id="employeeId" name="employeeId" type="text" autocomplete="username" placeholder="OPS-001" required />
            <div class="error" id="err-employeeId" hidden></div>
          </div>
          <div class="field">
            <label for="pin">PIN <span class="req">*</span></label>
            <input id="pin" name="pin" type="password" inputmode="numeric" maxlength="4" autocomplete="current-password" required />
            <div class="error" id="err-pin" hidden></div>
          </div>
          <button type="submit" class="btn btn-primary btn-lg btn-block" id="login-submit"><span class="label">Sign in</span></button>
        </form>
        <p class="fs-sm muted" style="margin-block-start:var(--s5)">Demo account</p>
        <div class="demo-chip-list">
          ${DEMO_ACCOUNTS.map((d, i) => `<button type="button" class="demo-chip" data-demo="${i}">${esc(d.label)}</button>`).join('')}
        </div>
      </div>
    </div>`;

  const form = /** @type {HTMLFormElement} */ (app.querySelector('#login-form'));
  app.querySelectorAll('[data-demo]').forEach((btn) => btn.addEventListener('click', () => {
    const d = DEMO_ACCOUNTS[Number(/** @type {HTMLElement} */ (btn).dataset.demo)];
    form.employeeId.value = d.employeeId;
    form.pin.value = d.pin;
    form.employeeId.focus();
  }));

  function validate() {
    let valid = true;
    const idErr = app.querySelector('#err-employeeId');
    const pinErr = app.querySelector('#err-pin');
    if (!form.employeeId.value.trim()) {
      idErr.textContent = 'Employee ID is required.'; idErr.hidden = false;
      form.employeeId.setAttribute('aria-invalid', 'true'); valid = false;
    } else { idErr.hidden = true; form.employeeId.removeAttribute('aria-invalid'); }
    if (!/^\d{4}$/.test(form.pin.value.trim())) {
      pinErr.textContent = 'PIN must be exactly 4 digits.'; pinErr.hidden = false;
      form.pin.setAttribute('aria-invalid', 'true'); valid = false;
    } else { pinErr.hidden = true; form.pin.removeAttribute('aria-invalid'); }
    return valid;
  }
  form.employeeId.addEventListener('blur', validate);
  form.pin.addEventListener('blur', validate);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!validate()) return;
    const alertBox = app.querySelector('#login-alert');
    alertBox.innerHTML = '';
    try {
      login(form.employeeId.value.trim(), form.pin.value.trim());
      toast('Signed in.', 'success');
      navigate('#/');
    } catch (err) {
      const amber = /disabled/i.test(err.message);
      alertBox.innerHTML = `<div class="field error" style="background:${amber ? 'var(--warning-soft)' : 'var(--danger-soft)'};color:${amber ? '#7C4A03' : 'inherit'};padding:var(--s3);border-radius:var(--r-sm);margin-block-end:var(--s3)">${esc(err.message)}</div>`;
      announce(err.message);
    }
  });

  return { destroy };
}

/** No timers to clean up. */
export function destroy() { /* no-op */ }
