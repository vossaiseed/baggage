/**
 * Departure v7 — shared constants. Single source of truth for statuses,
 * roles, exception types and rule numbers. Never hard-code these elsewhere.
 */

/** The 13 forward-only departure bag statuses, in order. */
export const BAG_STATUSES = Object.freeze([
  'Declared',
  'Data Verified',
  'Tag Assigned',
  'Checked-in',
  'Loaded to Collection Truck',
  'Received at Warehouse',
  'Screened',
  'Loaded to Airport Truck',
  'In Transit to Airport',
  'Received at Airport',
  'Handed to Airport Authority',
  'SGS Voucher Accepted',
  'Loaded on Aircraft',
]);

/** Side statuses — reachable ONLY through the named helpers in bagService. */
export const SIDE_STATUSES = Object.freeze({
  HELD: 'Held – Cancelled Flight',
  REBOOKED: 'Rebooked',
  RETURNED: 'Returned to Traveler',
});
export const SIDE_STATUS_LIST = Object.freeze(Object.values(SIDE_STATUSES));

/** Statuses that count as "accounted for" when a flight closes. */
export const ACCOUNTED_STATUSES = Object.freeze([
  'Loaded on Aircraft', SIDE_STATUSES.HELD, SIDE_STATUSES.REBOOKED, SIDE_STATUSES.RETURNED,
]);

/** Only this status may be "advanced" to itself (trip start is idempotent). */
export const IDEMPOTENT_STATUSES = Object.freeze(['In Transit to Airport']);

/** Role ids for the departure workflow. */
export const ROLE = Object.freeze({
  TRAVELER: 'traveler',
  BACKEND: 'backend',
  CHECKIN: 'checkin',
  TRANSPORT_MANAGER: 'transport_manager',
  TRANSPORT_STAFF: 'transport_staff',
  WAREHOUSE_MANAGER: 'warehouse_manager',
  AIRPORT_COORDINATOR: 'airport_coordinator',
  WINDOW_MONITOR: 'window_monitor',
  OPS_MANAGER: 'ops_manager',
  SYSTEM_ADMIN: 'system_admin',
});

export const FLIGHT_STATUSES = Object.freeze(['Scheduled', 'New', 'Cancelled', 'Rebooked', 'Completed']);

export const ASSIGNMENT_STATUSES = Object.freeze([
  'Assigned', 'En Route', 'Arrived', 'Collected', 'Handed to Transport', 'Traveler Absent', 'Rescheduled', 'Cancelled',
]);
/** A collection that has not happened yet — these are the ones a flight cancellation calls off. */
export const PRE_COLLECTION_ASSIGNMENT_STATUSES = Object.freeze(['Assigned', 'En Route', 'Arrived', 'Rescheduled']);

export const BAG_TAG_STATUSES = Object.freeze(['Imported', 'Assigned', 'Released', 'Attached', 'Scanned', 'Void']);
export const DRIVER_STATUSES = Object.freeze(['Available', 'Busy', 'Off duty']);
export const TRUCK_STATUSES = Object.freeze(['Available', 'Busy', 'Rerouting', 'Off duty']);
export const TRIP_TYPES = Object.freeze(['Collection', 'Airport', 'Return']);
/** Collection-trip lifecycle (Phase 4). Airport/Return trips are introduced in Phase 6. */
export const TRIP_STATUSES = Object.freeze(['Dispatched', 'Loaded', 'En Route', 'Arrived', 'Cancelled']);
export const SCAN_METHODS = Object.freeze(['HANDHELD', 'CAMERA', 'MANUAL']);
export const SCAN_RESULTS = Object.freeze(['OK', 'DUPLICATE', 'UNKNOWN', 'WRONG_FLIGHT', 'WRONG_STEP', 'INVALID_FORMAT']);

/** Exception types added in v7 (existing types are kept as-is by each app). */
export const EXCEPTION_TYPES_V7 = Object.freeze([
  'Traveler Absent', 'Data Mismatch', 'Over Airline Limit', 'Count Mismatch',
  'Invalid Tag Format', 'Duplicate Tag', 'Tag Not Released', 'Wrong Flight Tag', 'Damaged Tag',
  'Seal Broken', 'SGS Voucher Mismatch', 'Manifest Gap',
]);

/** Exception lifecycle. Ops is the only role that moves an exception past "Open". */
export const EXCEPTION_STATUSES = Object.freeze(['Open', 'Assigned', 'Escalated', 'Resolved', 'Closed']);
/** Still needs work — `raiseException` dedupes against these, and they are what the Ops queue shows. */
export const OPEN_EXCEPTION_STATUSES = Object.freeze(['Open', 'Assigned', 'Escalated']);
export const EXCEPTION_SEVERITIES = Object.freeze(['Low', 'Medium', 'High', 'Critical']);

/** Time rules (hours / minutes). The 12 h window ends at the baggage cut-off. */
export const WINDOW = Object.freeze({
  totalHours: 12,
  collectionHours: 8,
  warehouseHours: 2,
  driveHours: 2,
  slotHours: 2,
  redBeforeCutoffMin: 30,
  forecastHours: 24,
  forecastRefreshMin: 5,
  warehouseAmberMin: 90,
  warehouseRedMin: 120,
});

/** Airline defaults. */
export const AIRLINE_DEFAULTS = Object.freeze({ bags_allowed: 2, extra_bags_max: 0, max_bag_weight_kg: 23 });

/** Internal tag format: RBL-D-000123 */
export const INTERNAL_TAG_PREFIX = 'RBL-D-';
export const LPN_REGEX = /^\d{10}$/;

/** Old statuses that existed before v7 (used by the status migration). */
export const LEGACY_STATUSES = Object.freeze([
  'Declared', 'Checked-in', 'Tagged', 'Tag Pre-printed', 'Loaded to Collection Truck', 'Received at Warehouse',
  'Screened', 'Stored', 'Loaded to Airport Truck', 'In Transit to Airport', 'Received at Airport',
  'Handed to Airline', 'Loaded on Aircraft',
]);
