/**
 * SMS adapter. Simulated: records a notification row with channel 'sms' (no message leaves the app).
 *   send(state, { traveler_id?, phone, text }) -> notification
 */
import { notify } from '../services/notify.js';

export const simulatedSms = {
  mode: 'simulated',
  send(state, { traveler_id = null, phone = null, text }, ctx = {}) {
    return notify(state, { traveler_id, title: 'SMS (simulated)', body: `${phone ? `${phone}: ` : ''}${text}`, channel: 'sms' }, ctx);
  },
};
