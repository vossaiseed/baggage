/**
 * Imports pre-v7 DEPARTURE data from the per-app localStorage stores
 * (`rabel_ui_*`) into the shared v7 state. Old keys are only READ — never
 * modified or deleted. Replaced entities (centres, appointments, sessions,
 * carts) are kept read-only under `state.legacy`.
 * On a fresh browser (no old keys) this is a no-op.
 */
import { makeUser } from '../models.js';
import { ROLE } from '../constants.js';
import { INTERNAL_TAG_PREFIX } from '../constants.js';
import { nextCounter } from '../services/audit.js';

const KEYS = {
  checkin: 'rabel_ui_checkin-staff',
  warehouse: 'rabel_ui_warehouse-staff',
  driver: 'rabel_ui_driver',
  admin: 'rabel_ui_system-admin',
  ops: 'rabel_ui_operations-manager',
};

/** @param {{getItem:(k:string)=>string|null}|null|undefined} storage @param {string} key */
function read(storage, key) {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

const upsert = (arr, row, key = 'id') => {
  const i = arr.findIndex((x) => x[key] === row[key]);
  if (i === -1) arr.push(row); else arr[i] = { ...arr[i], ...row };
};

/** 'SV 1821' -> 'SV' */
const airlineOf = (code) => String(code || '').trim().split(/\s+/)[0] || null;
const flightIdOf = (code) => `FLT-${String(code || '').trim().replace(/\s+/g, '-')}`;

/** Legacy centre id -> v7 collection area (Madinah has no departure area). */
const CENTRE_TO_AREA = { AZIZIYAH: 'AREA-AZIZIYAH', 'AL-AWALI': 'AREA-AL-AWALI' };

function ensureFlight(state, code) {
  if (!code) return null;
  const id = flightIdOf(code);
  if (!state.flights.some((f) => f.id === id)) {
    state.flights.push({
      id, code, airline_code: airlineOf(code), route: null, status: 'Scheduled', cut_off_at: null, window_start_at: null,
      priority_rank: null, cancelled_at: null, cancel_reason: null, rebooked_to_flight_id: null, no_airline_tag: false, legacy: true,
    });
  }
  return id;
}

function internalTag(state) {
  return `${INTERNAL_TAG_PREFIX}${String(nextCounter(state, 'internalTag')).padStart(6, '0')}`;
}

function importBag(state, b, extra = {}) {
  if (state.bags.some((x) => x.id === b.id)) return;
  const flight_id = ensureFlight(state, b.flightCode);
  state.bags.push({
    id: b.id, traveler_id: b.pilgrimId ? `TRV-${b.pilgrimId}` : (b.appointmentId ? `TRV-${b.appointmentId}` : null), flight_id,
    collection_area_id: extra.collection_area_id ?? null, warehouse_id: extra.warehouse_id ?? null, airport_id: null,
    status: b.status || 'Declared', // raw legacy status, normalised by migration 003
    tag_no: b.tagNumber ? internalTag(state) : null, legacy_tag_no: b.tagNumber ?? null, airline_tag_no: null,
    weight_kg: b.weightKg ?? null, meets_airline_criteria: b.weightKg != null ? true : null, tag_verified: !!b.tagNumber,
    holding_area: null, holding_rack: null, extra: false, status_history: [],
    created_at: new Date().toISOString(), updated_at: null, legacy: true,
  });
}

export default {
  v: 2,
  name: 'import-legacy-departure',
  up(state, ctx = {}) {
    const storage = ctx.storage;
    const checkin = read(storage, KEYS.checkin);
    const warehouse = read(storage, KEYS.warehouse);
    const driver = read(storage, KEYS.driver);
    const admin = read(storage, KEYS.admin);
    const ops = read(storage, KEYS.ops);
    if (!checkin && !warehouse && !driver && !admin && !ops) return;

    state.legacy.imported_from = Object.entries({ checkin, warehouse, driver, admin, ops }).filter(([, v]) => v).map(([k]) => KEYS[k]);

    if (checkin) {
      state.legacy.centres = checkin.centres || [];
      state.legacy.appointments = checkin.appointments || [];
      state.legacy.checkinSessions = checkin.checkinSessions || [];
      state.legacy.carts = checkin.carts || [];
      for (const c of checkin.centres || []) {
        const area = CENTRE_TO_AREA[c.id];
        if (area) upsert(state.collectionAreas, { id: area, name: c.name, district: c.name, lat: null, lng: null, warehouse_id: 'WH-MAKKAH', pending_pickups: 0, priority_score: 0, from_legacy_centre: c.id });
      }
      for (const f of checkin.flights || []) ensureFlight(state, f.code);
      for (const n of checkin.nusukRecords || []) {
        upsert(state.travelers, {
          id: `TRV-${n.nusukId}`, nusuk_id: n.nusukId, name: n.name, passport: n.passportNo, booking_ref: null,
          airline_code: airlineOf(n.flightCode), flight_id: ensureFlight(state, n.flightCode), source: 'Nusuk',
          data_verified: false, boarding_pass_no: null, boarding_pass_verified: false, residence_id: null,
          collection_area_id: null, nusuk_synced_at: null, legacy: true,
        });
      }
      for (const s of checkin.staff || []) {
        upsert(state.users, makeUser({
          id: s.id, employee_id: s.employeeId, name: s.name, role: ROLE.CHECKIN, pin: s.pin,
          area_id: CENTRE_TO_AREA[s.homeCentre] ?? null,
        }), 'id');
        if (s.role === 'supervisor') state.users.find((u) => u.id === s.id).legacy_role = 'supervisor';
      }
      for (const b of checkin.bags || []) {
        importBag(state, b, { collection_area_id: CENTRE_TO_AREA[b.centreId] ?? null });
      }
      for (const t of checkin.trucks || []) {
        upsert(state.trucks, { id: t.id, plate: t.id, capacity_bags: 40, status: t.status === 'Out of Service' ? 'Off duty' : 'Available', current_area_id: null, rerouted_to_area_id: null, legacy: true });
      }
    }

    if (warehouse) {
      upsert(state.warehouses, { id: 'WH-MAKKAH', name: warehouse.warehouse?.name || 'Rabel Central Warehouse — Makkah' });
      for (const s of warehouse.staff || []) {
        const employee_id = String(s.employeeId).replace(/^WH-/i, 'WM-');
        upsert(state.users, makeUser({
          id: employee_id, employee_id, legacy_id: s.employeeId, name: s.name, role: ROLE.WAREHOUSE_MANAGER, pin: s.pin, warehouse_id: 'WH-MAKKAH',
        }), 'id');
      }
      for (const d of warehouse.drivers || []) {
        upsert(state.drivers, { id: d.id, name: d.name, phone: null, licence_no: null, status: 'Available', current_area_id: null, legacy: true });
      }
      state.legacy.warehouseTrips = warehouse.trips || [];
      state.legacy.warehouseZones = warehouse.zones || [];
      for (const b of warehouse.bags || []) importBag(state, b, { warehouse_id: 'WH-MAKKAH' });
      for (const t of warehouse.outboundTrucks || []) {
        upsert(state.trucks, { id: t.id, plate: t.code || t.id, capacity_bags: warehouse.config?.outboundTruckCapacity || 40, status: t.status === 'Out of Service' ? 'Off duty' : 'Available', current_area_id: null, rerouted_to_area_id: null, legacy: true });
      }
    }

    if (driver) {
      // Drivers are no longer a login role: disable the user and keep a Driver record.
      for (const s of driver.staff || []) {
        upsert(state.users, makeUser({
          id: s.id, employee_id: s.employeeId, name: s.name, role: 'driver_legacy', pin: s.pin,
          status: 'Disabled', disabled_reason: 'Moved to Driver records',
        }), 'id');
        upsert(state.drivers, { id: s.id, name: s.name, phone: null, licence_no: null, status: 'Available', current_area_id: null, legacy: true });
      }
      state.legacy.driverTrips = driver.trips || [];
    }

    if (admin) {
      const ROLE_MAP = {
        checkin: ROLE.CHECKIN, warehouse: ROLE.WAREHOUSE_MANAGER, airport: ROLE.AIRPORT_COORDINATOR,
        opsmanager: ROLE.OPS_MANAGER, sysadmin: ROLE.SYSTEM_ADMIN,
      };
      state.legacy.adminUsers = [];
      for (const u of admin.users || []) {
        if (u.roleId === 'driver') {
          upsert(state.users, makeUser({ id: u.employeeId, employee_id: u.employeeId, name: u.name, role: 'driver_legacy', pin: u.pin, phone: u.phone, status: 'Disabled', disabled_reason: 'Moved to Driver records' }), 'id');
          upsert(state.drivers, { id: u.employeeId, name: u.name, phone: u.phone || null, licence_no: null, status: 'Available', current_area_id: null, legacy: true });
        } else if (ROLE_MAP[u.roleId]) {
          const role = ROLE_MAP[u.roleId];
          const employee_id = role === ROLE.WAREHOUSE_MANAGER ? String(u.employeeId).replace(/^WH-/i, 'WM-') : u.employeeId;
          if (state.users.some((x) => x.employee_id === employee_id)) continue;
          upsert(state.users, makeUser({
            id: employee_id, employee_id, legacy_id: employee_id !== u.employeeId ? u.employeeId : null, name: u.name, role, pin: u.pin, phone: u.phone,
            status: u.status === 'Disabled' ? 'Disabled' : 'Active', disabled_reason: u.disabledReason ?? null,
          }), 'id');
        } else {
          state.legacy.adminUsers.push(u); // arrival-side roles stay legacy / read-only
        }
      }
    }

    // Exceptions from every old store are merged (kept as-is), tagged with their source.
    for (const [src, store] of Object.entries({ checkin, warehouse, driver, ops })) {
      for (const e of store?.exceptions || []) {
        if (!state.exceptions.some((x) => x.id === e.id)) state.exceptions.push({ ...e, source_app: src, legacy: true });
      }
    }
  },
};
