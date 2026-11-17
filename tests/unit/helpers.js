import { makeBag, makeUser } from '../../shared/models.js';
import { createEmptyState } from '../../shared/store.js';
import { runMigrations } from '../../shared/migrations/index.js';
import { ROLE } from '../../shared/constants.js';

export function freshState() { return runMigrations(createEmptyState(), {}); }

export const users = {
  backend: makeUser({ id: 'BE-001', employee_id: 'BE-001', name: 'Backend', role: ROLE.BACKEND }),
  checkin: makeUser({ id: 'CHK-001', employee_id: 'CHK-001', name: 'Omar', role: ROLE.CHECKIN, area_id: 'AREA-A' }),
  checkinB: makeUser({ id: 'CHK-002', employee_id: 'CHK-002', name: 'Yusuf', role: ROLE.CHECKIN, area_id: 'AREA-B' }),
  tstaff: makeUser({ id: 'TS-001', employee_id: 'TS-001', name: 'T', role: ROLE.TRANSPORT_STAFF, area_id: 'AREA-A' }),
  wm: makeUser({ id: 'WM-001', employee_id: 'WM-001', name: 'W', role: ROLE.WAREHOUSE_MANAGER, warehouse_id: 'WH-1' }),
  apc: makeUser({ id: 'APC-001', employee_id: 'APC-001', name: 'A', role: ROLE.AIRPORT_COORDINATOR, airport_id: 'JED' }),
  ops: makeUser({ id: 'OPS-001', employee_id: 'OPS-001', name: 'Layla', role: ROLE.OPS_MANAGER }),
  admin: makeUser({ id: 'ADM-001', employee_id: 'ADM-001', name: 'Zaid', role: ROLE.SYSTEM_ADMIN }),
  tm: makeUser({ id: 'TM-001', employee_id: 'TM-001', name: 'TM', role: ROLE.TRANSPORT_MANAGER }),
  monitor: makeUser({ id: 'MON-001', employee_id: 'MON-001', name: 'M', role: ROLE.WINDOW_MONITOR }),
  traveler: makeUser({ id: 'TRV-1', employee_id: 'TRV-1', name: 'T', role: ROLE.TRAVELER, traveler_id: 'TRV-1', flight_id: 'F1' }),
};

export function stateWithBag(over = {}) {
  const s = freshState();
  s.flights.push({ id: 'F1', status: 'Scheduled' }, { id: 'F2', status: 'Scheduled' }, { id: 'FC', status: 'Cancelled' });
  s.bags.push(makeBag({
    id: 'B1', traveler_id: 'TRV-1', flight_id: 'F1', collection_area_id: 'AREA-A', warehouse_id: 'WH-1', airport_id: 'JED',
    tag_no: 'RBL-D-000001', weight_kg: 20, meets_airline_criteria: true, tag_verified: true, ...over,
  }));
  return s;
}
