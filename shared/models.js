/**
 * Departure v7 data model: collection list + small factories.
 * Entities are plain objects in arrays on the shared store state.
 */
import { AIRLINE_DEFAULTS, WINDOW } from './constants.js';

/** Every collection the v7 store owns (arrays unless noted). */
export const COLLECTIONS = Object.freeze([
  'users', 'airlines', 'flights', 'travelers', 'residences', 'collectionAreas', 'collectionSlots',
  'collectionAssignments', 'bags', 'bagTags', 'tagImportBatches', 'scanEvents', 'drivers', 'trucks', 'trips',
  'sgsVouchers', 'rerouteLogs', 'exceptions', 'notifications', 'auditLog', 'warehouses', 'airports', 'integrations',
  'handovers',
]);

/** @param {{code?:string,name?:string,bags_allowed?:number,extra_bags_max?:number,max_bag_weight_kg?:number,btic_codes?:string[],data_feed_status?:string}} [p] */
export function makeAirline(p = {}) {
  return {
    code: p.code, name: p.name || p.code,
    bags_allowed: p.bags_allowed ?? AIRLINE_DEFAULTS.bags_allowed,
    extra_bags_max: p.extra_bags_max ?? AIRLINE_DEFAULTS.extra_bags_max,
    max_bag_weight_kg: p.max_bag_weight_kg ?? AIRLINE_DEFAULTS.max_bag_weight_kg,
    btic_codes: p.btic_codes || [],
    data_feed_status: p.data_feed_status || 'Not connected',
  };
}

/**
 * @param {object} p
 * @returns {object} Flight with window_start_at derived from cut_off_at (cut-off − 12 h)
 */
export function makeFlight(p = {}) {
  const cut = p.cut_off_at ? new Date(p.cut_off_at) : null;
  return {
    id: p.id, code: p.code || null, airline_code: p.airline_code || null, route: p.route || null,
    status: p.status || 'Scheduled',
    cut_off_at: cut ? cut.toISOString() : null,
    window_start_at: cut ? new Date(cut.getTime() - WINDOW.totalHours * 3600e3).toISOString() : null,
    priority_rank: p.priority_rank ?? null,
    cancelled_at: p.cancelled_at ?? null, cancel_reason: p.cancel_reason ?? null,
    rebooked_to_flight_id: p.rebooked_to_flight_id ?? null,
    no_airline_tag: !!p.no_airline_tag,
  };
}

/** @param {object} p */
export function makeBag(p = {}) {
  return {
    id: p.id, traveler_id: p.traveler_id ?? null, flight_id: p.flight_id ?? null,
    collection_area_id: p.collection_area_id ?? null, warehouse_id: p.warehouse_id ?? null, airport_id: p.airport_id ?? null,
    status: p.status || 'Declared',
    tag_no: p.tag_no ?? null, airline_tag_no: p.airline_tag_no != null ? String(p.airline_tag_no) : null,
    weight_kg: p.weight_kg ?? null, meets_airline_criteria: p.meets_airline_criteria ?? null, tag_verified: !!p.tag_verified,
    holding_area: p.holding_area ?? null, holding_rack: p.holding_rack ?? null,
    extra: !!p.extra, status_history: p.status_history || [],
    created_at: p.created_at || new Date().toISOString(), updated_at: p.updated_at || null,
  };
}

/** @param {{id?:string,name?:string,phone?:string,license_no?:string,status?:string,truck_id?:string|null,area_id?:string|null,created_at?:string}} [p] */
export function makeDriver(p = {}) {
  return {
    id: p.id, name: p.name, phone: p.phone ?? null, license_no: p.license_no ?? null,
    status: p.status || 'Available', truck_id: p.truck_id ?? null, area_id: p.area_id ?? null,
    created_at: p.created_at || new Date().toISOString(),
  };
}

/** @param {{id?:string,plate_no?:string,capacity_bags?:number,status?:string,driver_id?:string|null,created_at?:string}} [p] */
export function makeTruck(p = {}) {
  return {
    id: p.id, plate_no: p.plate_no || p.id, capacity_bags: p.capacity_bags ?? 80,
    status: p.status || 'Available', driver_id: p.driver_id ?? null,
    created_at: p.created_at || new Date().toISOString(),
  };
}

/**
 * A truck run. Collection: area_from -> warehouse_id. Airport (Phase 6): warehouse_id -> airport_id.
 * @param {{id?:string,type?:string,status?:string,area_from?:string|null,area_to?:string|null,warehouse_id?:string|null,airport_id?:string|null,driver_id?:string|null,truck_id?:string|null,bag_ids?:string[],expected_count?:number|null,dispatched_at?:string,loaded_at?:string|null,departed_at?:string|null,arrived_at?:string|null,note?:string|null}} [p]
 */
export function makeTrip(p = {}) {
  return {
    id: p.id, type: p.type, status: p.status || 'Dispatched',
    area_from: p.area_from ?? null, area_to: p.area_to ?? null,
    warehouse_id: p.warehouse_id ?? null, airport_id: p.airport_id ?? null,
    driver_id: p.driver_id ?? null, truck_id: p.truck_id ?? null,
    bag_ids: p.bag_ids || [], expected_count: p.expected_count ?? null,
    dispatched_at: p.dispatched_at || new Date().toISOString(),
    loaded_at: p.loaded_at ?? null, departed_at: p.departed_at ?? null, arrived_at: p.arrived_at ?? null,
    note: p.note ?? null,
  };
}

/**
 * @param {object} p
 * @returns {object} User
 */
export function makeUser(p = {}) {
  return {
    id: p.id, employee_id: p.employee_id, legacy_id: p.legacy_id ?? null, name: p.name, role: p.role,
    pin: p.pin ?? '1234', phone: p.phone ?? null,
    area_id: p.area_id ?? null, warehouse_id: p.warehouse_id ?? null, airport_id: p.airport_id ?? null,
    traveler_id: p.traveler_id ?? null, flight_id: p.flight_id ?? null,
    status: p.status || 'Active', disabled_reason: p.disabled_reason ?? null,
    created_at: p.created_at || new Date().toISOString(),
  };
}
