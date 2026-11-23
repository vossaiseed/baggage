/**
 * Browser checks for the static suite — the things only a real browser can answer:
 * every app boots its ES modules without a console error, the route guards hold, the demo seeds
 * itself, and two different role apps really do share one store.
 *
 * Run with `npm run test:browser` (uses the Chrome already installed; no download).
 */
import { test, expect } from '@playwright/test';

const DEPARTURE_APPS = [
  ['pilgrim', 'Traveler'],
  ['backend-team', 'Backend'],
  ['checkin-staff', 'Check-in'],
  ['transport', 'Transport'],
  ['warehouse-staff', 'Warehouse'],
  ['airport-coordinator', 'Airport'],
  ['window-monitor', 'Window Monitor'],
  ['operations-manager', 'Operations'],
  ['system-admin', 'System Admin'],
];
const ARRIVAL_APPS = ['accommodation-receiving-staff', 'delivery-staff', 'driver', 'airline-ground-handler'];

/**
 * Collect console errors and page exceptions for the life of a page. Chrome asks every page for
 * /favicon.ico whether or not it declares one; the arrival apps do not, and that 404 is the
 * browser's noise, not the app's.
 */
function watchErrors(page) {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/favicon/.test(m.location()?.url || '')) return;
    errors.push(`${m.text()} (${m.location()?.url || 'no url'})`);
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/** Sign a staff account in through its own login form. */
async function signIn(page, app, employeeId, { otp = null } = {}) {
  await page.goto(`/${app}/index.html#/login`);
  await page.fill('#employeeId', employeeId);
  await page.fill('#pin', '1234');
  await page.click('button[type="submit"]');
  if (otp) {
    await page.fill('#otp', otp);
    await page.click('button[type="submit"]');
  }
  await expect(page.locator('.sidebar, .wb-topbar').first()).toBeVisible();
}

test.describe('every app boots', () => {
  test('the landing page lists all ten departure roles and links them', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/index.html');
    for (const [, label] of DEPARTURE_APPS) {
      await expect(page.getByText(label, { exact: false }).first()).toBeVisible();
    }
    await expect(page.locator('.role-card[aria-disabled="true"]')).toHaveCount(0); // nothing is "coming in phase N" any more
    expect(errors).toEqual([]);
  });

  for (const [app] of DEPARTURE_APPS) {
    test(`${app} loads its modules and guards its routes`, async ({ page }) => {
      const errors = watchErrors(page);
      await page.goto(`/${app}/index.html#/`);
      await page.waitForLoadState('networkidle');
      // unauthenticated, every staff console redirects to its own login
      if (app !== 'pilgrim') await expect(page).toHaveURL(/#\/login$/);
      await expect(page.locator('#app')).toBeVisible();
      expect(errors, `${app} console errors`).toEqual([]);
    });
  }

  for (const app of ARRIVAL_APPS) {
    test(`${app} (arrival, untouched) still loads`, async ({ page }) => {
      const errors = watchErrors(page);
      await page.goto(`/${app}/index.html`);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('#app')).toBeVisible();
      expect(errors, `${app} console errors`).toEqual([]);
    });
  }
});

test.describe('the shared store', () => {
  test('?seed=departure rebuilds the demo and strips the parameter', async ({ page }) => {
    await page.goto('/operations-manager/index.html?seed=departure#/login');
    await page.waitForLoadState('networkidle');
    const state = await page.evaluate(() => JSON.parse(localStorage.getItem('rabel_v7')));
    expect(state.flights.length).toBeGreaterThan(0);
    expect(page.url()).not.toContain('seed=departure');

    // plant a change, reseed, and watch it go
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('rabel_v7'));
      s.flights.find((f) => f.id === 'FLT-PK-760').status = 'Cancelled';
      localStorage.setItem('rabel_v7', JSON.stringify(s));
    });
    await page.goto('/operations-manager/index.html?seed=departure#/login');
    await page.waitForLoadState('networkidle');
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('rabel_v7')).flights.find((f) => f.id === 'FLT-PK-760').status);
    expect(after).toBe('Scheduled');
  });

  test('Ops cancels a flight and the Warehouse Manager sees its bags waiting to be racked', async ({ page }) => {
    await page.goto('/operations-manager/index.html?seed=departure#/login');
    await page.waitForLoadState('networkidle');

    // the seeded cancelled flight already has 8 bags at the warehouse
    await signIn(page, 'warehouse-staff', 'WM-001');
    await page.goto('/warehouse-staff/index.html#/holding');
    await expect(page.getByText('To move into holding')).toBeVisible();
    const before = await page.locator('tbody tr').count();
    expect(before).toBe(8);

    // Ops cancels another flight whose bags are still with travelers — nothing new to rack
    await signIn(page, 'operations-manager', 'OPS-001');
    await expect(page.getByRole('heading', { name: 'Flights' })).toBeVisible();
    await page.locator('[data-cancel]').first().click();
    await page.fill('#c-why', 'Browser check: airline cancelled the departure.');
    await page.locator('#c-go').click();
    const code = await page.locator('#confirm-title').innerText();
    await page.fill('#confirm-input', code.replace(/^Cancel |\?$/g, ''));
    await page.locator('[data-act="confirm"]').click();
    await expect(page.locator('.overlay')).toHaveCount(0);
    const cancelled = await page.evaluate(() => JSON.parse(localStorage.getItem('rabel_v7'))
      .flights.filter((f) => f.status === 'Cancelled').map((f) => f.code));
    expect(cancelled.length).toBeGreaterThan(1); // the seeded one, plus the one just cancelled

    // and the fan-out reached every role
    const roles = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('rabel_v7'));
      return s.notifications.filter((n) => /cancelled/i.test(n.title)).flatMap((n) => n.roles || []);
    });
    expect(roles).toContain('warehouse_manager');
    expect(roles).toContain('window_monitor');
  });

  test('the Window Monitor board shows the same flights as the Ops console', async ({ page }) => {
    await page.goto('/operations-manager/index.html?seed=departure#/login');
    await page.waitForLoadState('networkidle');
    await signIn(page, 'window-monitor', 'MON-001');
    await expect(page.getByRole('heading', { name: '12-hour window' })).toBeVisible();
    const boardCodes = await page.locator('.wb-code').allInnerTexts();
    expect(boardCodes.length).toBeGreaterThan(0);

    await signIn(page, 'operations-manager', 'OPS-001');
    const opsCodes = await page.locator('.flight-row h2').allInnerTexts();
    for (const code of boardCodes) {
      expect(opsCodes.some((o) => o.startsWith(code))).toBe(true);
    }
  });
});

test.describe('legacy screens stay hidden', () => {
  const GUARDED = [
    ['operations-manager', 'OPS-001', ['/cutoffs', '/reconciliation', '/trucks', '/stakeholders', '/bags']],
    ['warehouse-staff', 'WM-001', ['/storage', '/inventory', '/incoming', '/gate']],
    ['system-admin', 'ADM-001', ['/config', '/masterdata', '/health', '/users']],
  ];

  for (const [app, id, paths] of GUARDED) {
    test(`${app}: the pre-v7 routes redirect home`, async ({ page }) => {
      await page.goto('/operations-manager/index.html?seed=departure#/login');
      await page.waitForLoadState('networkidle');
      await signIn(page, app, id, { otp: app === 'system-admin' ? '123456' : null });
      for (const path of paths) {
        await page.goto(`/${app}/index.html#${path}`);
        await expect(page).toHaveURL(/#\/$/);
      }
    });
  }
});
