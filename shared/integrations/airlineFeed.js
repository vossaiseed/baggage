/**
 * Airline data / tag feed adapter:
 *   fetchReservations() -> AirlineRecord[]
 *   fetchManifest(state, flight) -> { feed: 'Connected'|'Not connected', lpns: string[] }
 * Simulated: reservations come from simulatedData.js; the "airline manifest" is
 * derived from the airline tags on bags that reached SGS Voucher Accepted or later
 * (the airline owns tag numbers, so only tagged bags appear), minus any bag listed in
 * state.simulated.manifestDrops[flightId] (used to demo a manifest gap).
 */
import { AIRLINE_RECORDS } from './simulatedData.js';
import { BAG_STATUSES } from '../constants.js';

export const simulatedAirlineFeed = {
  mode: 'simulated',
  fetchReservations() { return structuredClone([...AIRLINE_RECORDS]); },
  /** @param {any} state @param {{id:string, airline_code?:string}} flight */
  fetchManifest(state, flight) {
    const airline = state.airlines.find((a) => a.code === flight.airline_code);
    const feed = airline?.data_feed_status === 'Connected' ? 'Connected' : 'Not connected';
    if (feed !== 'Connected') return { feed, lpns: [] };
    const drops = new Set(state.simulated?.manifestDrops?.[flight.id] || []);
    const from = BAG_STATUSES.indexOf('SGS Voucher Accepted');
    const lpns = state.bags
      .filter((b) => b.flight_id === flight.id && b.airline_tag_no && BAG_STATUSES.indexOf(b.status) >= from && !drops.has(b.airline_tag_no))
      .map((b) => b.airline_tag_no);
    return { feed, lpns };
  },
};
