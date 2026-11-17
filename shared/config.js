/**
 * Runtime config for the static demo. Real deployments set window.RABEL_CONFIG
 * (or a server injects it from .env — see .env.example). No secrets here.
 */
const DEFAULTS = Object.freeze({
  integrations: { nusuk: 'simulated', airlineFeed: 'simulated', sgs: 'simulated', sms: 'simulated', maps: 'simulated', gps: 'simulated' },
  demoOtp: '123456',
  defaultPin: '1234',
});

/** @returns {typeof DEFAULTS} */
export function getConfig() {
  const override = (typeof window !== 'undefined' && /** @type {any} */ (window).RABEL_CONFIG) || {};
  return { ...DEFAULTS, ...override, integrations: { ...DEFAULTS.integrations, ...(override.integrations || {}) } };
}
