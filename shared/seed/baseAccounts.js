/**
 * Base demo accounts, areas, warehouse and airport for the v7 departure roles
 * (all PIN 1234). Idempotent: upserts by id and only FILLS missing fields, so
 * it never overwrites data imported from the old stores or edited by users.
 * The full demo scenario seed (flights, travelers, tags …) comes in Phase 7.
 */
import { makeUser, makeDriver, makeTruck } from '../models.js';
import { ROLE } from '../constants.js';

export const BASE_AREAS = Object.freeze([
  { id: 'AREA-AZIZIYAH', name: 'Aziziyah', district: 'Aziziyah', lat: 21.4225, lng: 39.8750 },
  { id: 'AREA-AL-AWALI', name: 'Al-Awali', district: 'Al-Awali', lat: 21.3856, lng: 39.8400 },
  { id: 'AREA-SHISHA', name: 'Shisha', district: 'Shisha', lat: 21.4000, lng: 39.8900 },
]);

/** Demo fleet for the Transport Manager's Drivers/Trucks screens (Phase 4). */
export const BASE_DRIVERS = Object.freeze([
  { id: 'DRV-001', name: 'Hamza Qureshi', phone: '+966500000101', license_no: 'SA-DL-10001' },
  { id: 'DRV-002', name: 'Idris Mwangi', phone: '+966500000102', license_no: 'SA-DL-10002' },
  { id: 'DRV-003', name: 'Tariq Siddiqui', phone: '+966500000103', license_no: 'SA-DL-10003' },
]);

export const BASE_TRUCKS = Object.freeze([
  { id: 'TRK-001', plate_no: 'RBL 1001', capacity_bags: 80 },
  { id: 'TRK-002', plate_no: 'RBL 1002', capacity_bags: 80 },
  { id: 'TRK-003', plate_no: 'RBL 1003', capacity_bags: 60 },
]);

const U = (id, name, role, extra = {}) => ({ id, employee_id: id, name, role, ...extra });

export const BASE_USERS = Object.freeze([
  U('CHK-001', 'Omar', ROLE.CHECKIN, { area_id: 'AREA-AZIZIYAH' }),
  U('CHK-002', 'Yusuf', ROLE.CHECKIN, { area_id: 'AREA-AL-AWALI' }),
  U('CHK-003', 'Bilal', ROLE.CHECKIN, { area_id: 'AREA-SHISHA' }),
  U('TM-001', 'Rashid', ROLE.TRANSPORT_MANAGER),
  U('TS-001', 'Hamza', ROLE.TRANSPORT_STAFF, { area_id: 'AREA-AZIZIYAH' }),
  U('TS-002', 'Idris', ROLE.TRANSPORT_STAFF, { area_id: 'AREA-AL-AWALI' }),
  U('WM-001', 'Faisal', ROLE.WAREHOUSE_MANAGER, { warehouse_id: 'WH-MAKKAH', legacy_id: 'WH-001' }),
  U('BE-001', 'Khalid', ROLE.BACKEND),
  U('APC-001', 'Salman', ROLE.AIRPORT_COORDINATOR, { airport_id: 'JED' }),
  U('MON-001', 'Noor', ROLE.WINDOW_MONITOR),
  U('OPS-001', 'Layla Al-Harthi', ROLE.OPS_MANAGER),
  U('ADM-001', 'Zaid Al-Harbi', ROLE.SYSTEM_ADMIN),
]);

/** @param {object} state the migrated v7 state @returns {object} same state */
export function ensureBaseAccounts(state) {
  for (const a of BASE_AREAS) {
    const cur = state.collectionAreas.find((x) => x.id === a.id);
    if (!cur) state.collectionAreas.push({ ...a, warehouse_id: 'WH-MAKKAH', pending_pickups: 0, priority_score: 0 });
    else for (const [k, v] of Object.entries({ ...a, warehouse_id: 'WH-MAKKAH' })) if (cur[k] == null) cur[k] = v;
  }
  if (!state.warehouses.some((w) => w.id === 'WH-MAKKAH')) state.warehouses.push({ id: 'WH-MAKKAH', name: 'Rabel Central Warehouse — Makkah' });
  if (!state.airports.some((a) => a.id === 'JED')) state.airports.push({ id: 'JED', code: 'JED', name: 'King Abdulaziz International' });
  for (const d of BASE_DRIVERS) if (!state.drivers.some((x) => x.id === d.id)) state.drivers.push(makeDriver(d));
  for (const t of BASE_TRUCKS) if (!state.trucks.some((x) => x.id === t.id)) state.trucks.push(makeTruck(t));
  for (const b of BASE_USERS) {
    const cur = state.users.find((u) => u.id === b.id || u.employee_id === b.employee_id);
    if (!cur) state.users.push(makeUser(b));
    else for (const [k, v] of Object.entries(b)) if (cur[k] == null) cur[k] = v;
  }
  return state;
}
