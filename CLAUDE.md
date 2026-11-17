# Rabel Hajj Baggage — project guide

Static, zero-build, vanilla-JS suite of role apps (one folder per app, hash router, mock `api.js` over `localStorage`).
Needs an HTTP server (ES modules): `npm run dev` → http://localhost:5173. Quality gates: `npm run check`
(= `lint` + `typecheck` + `test` + `build`; `build` is `scripts/build-check.mjs`, which verifies every import/asset resolves).

* Departure v7 lives in the **shared layer** `shared/` (pure ES modules, unit-tested in `tests/unit/`).
* Arrival apps (`accommodation-receiving-staff`, `delivery-staff`, `driver`, `/arr/*` and `/arrival/*` routes) are **unchanged** and keep their own `rabel_ui_*` stores. Do not touch them for departure work.
* Old per-app code that v7 replaces is **hidden, not deleted** (menus + routes guarded; data kept read-only, labelled "Legacy").

## Departure v7 rules

**No check-in counter.** Check-in Staff go to the traveler's residence, check in + tag bags there, and hand them to Transport at the residence pickup point. Centres, counters, appointments and carts are Legacy (read-only).

**Roles** (`shared/rbac.js` → `ROLE_PRESETS`): Traveler `/` · Backend Team `/backend` (BE-) · Check-in Staff `/staff` (CHK-) · Transport Manager `/transport` (TM-) · Transport Staff `/transport/trips` (TS-) · Warehouse Manager `/warehouse` (WM-, was Warehouse Staff WH-) · Airport Coordinator `/airport` (APC-) · Window Monitor `/monitor` (MON-, read-only) · Ops Manager `/ops` (OPS-) · System Admin `/admin` (ADM-). URLs map to folders (`pilgrim/`, `backend-team/`, `checkin-staff/`, `transport/`, `warehouse-staff/`, `airport-coordinator/`, `window-monitor/`, `operations-manager/`, `system-admin/`). **Driver is not a login role** (Driver records; old driver users are Disabled "Moved to Driver records"; the `driver/` app stays for arrival only). No Group Ameer. Airline/Ground Handler module is kept but outside the departure flow. Demo PIN `1234`, OTP/2FA `123456`.

**Bag statuses** (forward only, exactly one step, `shared/constants.js` → `BAG_STATUSES`):
Declared → Data Verified → Tag Assigned → Checked-in → Loaded to Collection Truck → Received at Warehouse → Screened → Loaded to Airport Truck → In Transit to Airport → Received at Airport → Handed to Airport Authority → SGS Voucher Accepted → Loaded on Aircraft.
Side statuses (named helpers only): `Held – Cancelled Flight`, `Rebooked` (re-enters at Tag Assigned with a NEW tag), `Returned to Traveler`. Old → new: Tagged→Checked-in, Tag Pre-printed→Tag Assigned, Stored→Held (cancelled flight) or Screened, Handed to Airline→Handed to Airport Authority (`shared/migrations/statusMap.js`).
Who sets what is derived from the presets (`bag:advance:<status>`): Backend (Data Verified, Tag Assigned, Loaded on Aircraft) · Check-in (Checked-in) · Transport Staff (Loaded to Collection Truck, In Transit to Airport — idempotent) · Warehouse Manager (Received at Warehouse, Screened, Loaded to Airport Truck) · Airport Coordinator (Received at Airport, Handed to Airport Authority, SGS Voucher Accepted).

**Tag rule.** Rabel cannot create IATA tags. Backend imports the airline's 10-digit LPNs (CSV now, API later), assigns them to traveler + flight, releases them to check-in staff. LPN is a **string** `^\d{10}$` (leading zero kept), issuer code must be in the airline's `btic_codes`, unique, flight must exist. Every bag also has an internal label `tag_no` = `RBL-D-xxxxxx` (sequential, `counters.internalTag`) used for every internal hand-off. No airline tags for a flight → internal tag only, "No airline tag" badge, flagged for Ops. Damaged tag → void → replacement from Backend (no reprint).

**Scan points — one scan per hand-off.** Residence: airline tag (ITF) once + internal label once · Pickup point: no per-bag scan, count match vs check-in log · Warehouse receiving: truck QR once + each internal label once · Warehouse loading: internal label once onto the airport truck · Airport offload: internal label once (count match) · SGS handover: airline tag list reconciled to the manifest (scan only disputed bags).

**Time rules** (`shared/time/window.js`). 12 h window ends at cut-off: 8 h residence collection & check-in, 2 h warehouse, 2 h drive. 2-hour collection slots only inside the 8 h window. 24 h forecast: cut-off in next 24 h, earliest first, tie → more bags still to move, recomputed every 5 min. Amber = a stage is past its slot; Red = bags not at the airport by cut-off − 30 min. Warehouse timer: amber 90 min, red 120 min. Only bags of cancelled flights are stored (separate holding area).

**Service entry points — never bypass:**
* every bag status change → `shared/services/bagService.js` `advanceBag()` (+ `holdForCancelledFlight`, `markRebooked`, `retagRebooked`, `returnToTraveler`);
* every permission check → `shared/rbac.js` `can()` / `scopeFilter()` / `assertCan()`;
* every scan → shared scanner component + `scanService.recordScan()` (Phase 3);
* staff accounts → `shared/services/staffService.js` (RBAC + audit); audit entries → `shared/services/audit.js`;
* state → `shared/store.js` (one key `rabel_v7`, append-only migrations in `shared/migrations/`; old `rabel_ui_*` keys are only read, never deleted).
* integrations (Nusuk, airline feed, SGS, SMS, maps, GPS) sit behind adapters in `shared/integrations/`; secrets only in `.env.example` keys, never in code.

## Phase 2 additions (Traveler + Backend)
* **LPN rule**: `shared/tags/validateLpn.js` is the only validator (`mode: 'import' | 'scan'`). LPN = `^\d{10}$` **string**; issuer = digits 1–3 (must be in the airline `btic_codes`), serial = digits 4–9, digit 10 not validated. `shared/tags/csv.js` keeps every cell a string. Never coerce a tag to a number.
* **Tag lifecycle** (`tagService`): Imported → Assigned (`assignTags`) → Released (`releaseTags`, advances bags Data Verified → Tag Assigned via `advanceBag`) → Attached → Scanned (Phase 3) → Void (`voidAndReplace` takes a spare from the SAME batch). Internal labels `RBL-D-xxxxxx` are issued at "Data Verified" (`issueInternalLabel`). `issueInternalOnly` = flight without an airline list (flag `no_airline_tag`, Ops notified).
* **Traveler flow** (`travelerService`): login by Nusuk ID *or* booking ref + passport → simulated OTP (`123456`); a Traveler acts as an RBAC pseudo-user (`travelerUser`, scope `own`). Can edit ONLY flat no., landmark, phone (logged). Booking uses the traveler's airline policy; slots = 2 h slots inside `[cut-off−12h, cut-off−4h]`, future only; extra bags are marked `extra_approval: 'Pending'`. `pilgrim/` is dual-mode: v7 travelers (shared store, `session.mode === 'v7'`) get `pilgrim/js/v7/*`; arrival-demo travelers keep the untouched legacy flow.
* **Backend** (`backend-team/`, `backendService`): Sync Nusuk, import airline file, matched / mismatch / missing (`matchStatus`), match & verify (bags → Data Verified), fix (reason + choice per field) / reject (note → Ops), unmapped addresses, boarding-pass verify/fix, manifest vs "SGS Voucher Accepted" (`confirmLoaded`; manual needs a reason; gaps → `notifyOpsManifestGap`). Pre-v7 imported (`legacy: true`) travelers/bags are excluded from Backend queues.
* **Integrations** are adapters in `shared/integrations/` (`nusuk`, `airlineFeed`, `sms`) over `simulatedData.js`; get them with `integrations()`.
* **Seed** `shared/seed/departure.js` (idempotent; `SEED_VERSION` bump re-runs it on existing browsers): 3 airlines, 5 flights, 14 travelers, slots, 4 pre-booked collections, the cancelled flight's 8 bags, sample tag CSVs (`SAMPLE_TAG_FILES`). Browser stores seed automatically (`getStore()`); demo airline policy: SV 2+2/23 kg/065, GA 2+1/20 kg/126, PK 2+0/23 kg/214.

## Status of the v7 rollout
See `docs/v7-departure-plan.md`. Phase 1 (foundation) and Phase 2 (Traveler + Backend) done. Phases 3–7: Check-in + scanner, Transport, Warehouse, Airport, Ops/Monitor/Admin/seed/e2e.
