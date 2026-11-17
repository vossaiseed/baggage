/**
 * Integration registry. Screens/services call `integrations().nusuk` etc.; which
 * implementation is used comes from config (RABEL_*_MODE). Only the simulated
 * adapters exist today — a live adapter is added here without touching screens.
 */
import { getConfig } from '../config.js';
import { simulatedNusuk } from './nusuk.js';
import { simulatedAirlineFeed } from './airlineFeed.js';
import { simulatedSms } from './sms.js';

/** @returns {{ nusuk: typeof simulatedNusuk, airlineFeed: typeof simulatedAirlineFeed, sms: typeof simulatedSms }} */
export function integrations() {
  const modes = getConfig().integrations;
  const pick = (name, sim) => {
    if (modes[name] && modes[name] !== 'simulated') throw new Error(`Integration "${name}" mode "${modes[name]}" has no adapter yet.`);
    return sim;
  };
  return { nusuk: pick('nusuk', simulatedNusuk), airlineFeed: pick('airlineFeed', simulatedAirlineFeed), sms: pick('sms', simulatedSms) };
}
