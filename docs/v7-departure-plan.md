# Rabel Departure Workflow v7 — Phase 0 Audit & Plan

Status: **Phase 0 only (audit + plan). No application code has been changed.**
Branch for build phases: `feature/departure-v7` (not yet created; repo is currently on `main`, clean).

> **Headline finding.** The master prompt assumes a framework app with an ORM / Base44 entities, migrations, a
> lint + type-check + test + build pipeline and Playwright. This repo is none of those: it is a **static,
> zero-build, vanilla-JS suite of 10 independent role apps**, each with its own mock API and its own
> `localStorage` store. There is no `package.json`, no test tooling, no shared code and no cross-app data.
> The plan below therefore adds the missing foundation (a shared domain layer + shared store + minimal Node
> tooling) *before* the v7 workflow. All decisions are in §9 "Assumptions" — reply **"go"** to accept them,
> or tell me what to change.

---

## 1. Stack summary

| Item | Reality in this repo |
|---|---|
| Repo | `Hajj-Baggage/`, git, `origin = github.com/Dilshad313/Hajj-Baggage`, branch `main`, 3 commits |
| Framework | **None.** Vanilla ES modules (`<script type="module" src="js/app.js">`), plain CSS (`tokens.css`, `base.css`, `components.css`, `<role>.css`) |
| Apps | 10 folders, each a standalone SPA: `pilgrim`, `checkin-staff`, `warehouse-staff`, `driver`, `airport-coordinator`, `airline-ground-handler`, `accommodation-receiving-staff`, `delivery-staff`, `operations-manager`, `system-admin`. Landing page: root `index.html` (hard-coded `ROLES` array) |
| Routing | Per-app hash router (`js/router.js`, identical copy in every app): `#/route/:param`, guards, 404 |
| Auth / roles | Per-app mock login (employee ID + PIN `1234`, system-admin adds 2FA `123456`). Session in the app's own store. **No RBAC module**; no `ROLE_PRESETS` constant exists (system-admin has a `/roles` screen driven by its own seed) |
| Data layer | Per-app `js/store.js` (localStorage key `rabel_ui_<app>`, schema marker `__v: 1`) + `js/seed.js` (hand-built mock data) + `js/api.js` (async functions with 300–700 ms fake latency, `ApiError`, `?fail=1`). **Each app has its own copy of the data — apps cannot see each other's bags** |
| Shared UI code | Copy-pasted per app: `ui.js` (3 variants), `components/scan-input.js` (6 identical copies + 1 variant), `status-chip`, `bag-timeline`, `stepper`, `data-table`, `kpi-tile`, `signature-pad` |
| Scanning | `components/scan-input.js`: keyboard-wedge text input + `html5-qrcode@2.3.8` camera modal + manual entry + demo "simulate failure". Libraries via CDN: lucide, qrcodejs, JsBarcode, html5-qrcode |
| Tests / lint / types / build | **None** |
| Run | Needs any static HTTP server (ES modules don't load from `file://`); `.vscode/settings.json` points at Live Server |
| Size | ~51.5k lines JS across ~297 files |

### Departure vs arrival in today's code
* Departure-only apps: `checkin-staff`, `warehouse-staff`.
* Mixed: `pilgrim` (booking/track + `/arrival/*`), `airport-coordinator` (`/dep/*` + `/arr/*`), `driver` (`DEPARTURE_STEPS` + `ARRIVAL_STEPS`), `operations-manager`, `system-admin`, `airline-ground-handler`.
* Arrival-only (**must not change**): `accommodation-receiving-staff`, `delivery-staff`, and every `/arr/*`, `/arrival/*` route.
* "Group Ameer": not present anywhere (only the name "Sameer"). Nothing to remove.

---

## 2. Mapping: old → v7

Legend: **keep** · **extend** · **hide** (remove from menus/routes, keep code + data, label "Legacy") · **replace** · **migrate**.

### 2.1 Entities / data
| Old (where) | v7 target | Action |
|---|---|---|
| `centres` (CheckInCenter) `AZIZIYAH`, `AL-AWALI`, `MADINAH` (checkin-staff seed) | `CollectionArea` (Aziziyah, Al-Awali, Shisha) | **hide + migrate** (centre → area by name; Madinah stays Legacy). Old data read-only |
| `appointments` (Appointment) | `CollectionAssignment` + `CollectionSlot` | **hide** (Legacy). Open/future appointments migrated to Assignments only if traveler has a residence; otherwise listed in Backend "Unmapped address" |
| `checkinSessions` (CheckInSession) | per-bag check-in log inside Assignment | **hide** (Legacy, read-only) |
| `carts` (CollectionCart) | — | **hide** |
| `trucks` (checkin/ops/driver copies) | `Truck` (new statuses) | **extend + migrate** |
| `bags` | `Bag` (+ `tag_no`, `airline_tag_no` string, `weight_kg`, `meets_airline_criteria`, `tag_verified`, `holding_area/rack`) | **extend + migrate** statuses (§3.3) |
| per-session `events` / bag `timeline` / `logEvent` | `ScanEvent` collection (step, method, symbology, device_id, raw_value, result, lat/lng) | **replace** (new shared collection; old events stay as history) |
| `exceptions` (+ `EXCEPTION_TYPES` in each seed) | same entity + 12 new types | **extend** |
| `flights` (code, origin, destination, `std`, `status: Open/Departed`, `closed`) | `Flight` v7 (status, cut_off_at, window_start_at, priority_rank, cancelled_at, cancel_reason, rebooked_to_flight_id) | **extend + migrate** (`std` → derive `cut_off_at`) |
| `nusukRecords` | `Traveler` (source Nusuk/Airline, data_verified, boarding pass fields, residence_id) | **extend + migrate** |
| pilgrim record | `Traveler` | **migrate** (rename label Pilgrim → Traveler) |
| `staff` arrays (per app) / system-admin `users` | `User` in shared store, v7 roles, prefixes | **migrate** (see §3.4) |
| `drivers` (warehouse seed `DRV-*`, driver app users) | `Driver` record (not a login) | **migrate** |
| `handovers` (shift notes) | same | **keep** |
| `BTypeMessage` / `DcsMessage` → `bsm` in airline-ground-handler | Airline module | **keep, hide from departure flow** |
| `staffService` | does **not exist** (staff logic is inline in each `api.js`) | **create** `shared/services/staffService.js` |
| tag generator `generateTag` → `RBTAG-<appt>-<seq>` (checkin-staff `api.js:562`) | `tag_no` `RBL-D-xxxxxx` internal tag + imported airline LPN (`BagTag`) | **replace** |
| — | `Airline`, `CollectionArea`, `Residence`, `CollectionSlot`, `CollectionAssignment`, `BagTag`, `TagImportBatch`, `Driver`, `Trip`, `SgsVoucher`, `RerouteLog`, `Integration` config | **create** |

### 2.2 Routes / screens
| Old | v7 | Action |
|---|---|---|
| `checkin-staff`: `/appointments`, `/checkin` (QR→Identity→Nusuk→Bags→Receipt), `/loading` (carts/trucks), `/history`, login (centre + counter picker) | `/` assignments list, `/route`, `/assignment/:id` (identity→count→weigh→tags→complete→handoff), `/exceptions`, `/handover`; login without centre/counter | **replace** (`CheckInTagStep` / `CheckInTagScanStep` do not exist as named components — they are the generate→print→verify steps inside `views/checkin.js`) |
| `pilgrim`: `/book`, `/booking/:id`, `/track`, `/receipt/:id`, `/support` | Nusuk login + OTP, sync, booking in 8 h window, tracking (13 statuses), receipt | **replace departure screens**; `/arrival/*` **keep untouched** |
| `warehouse-staff`: `/incoming`, `/gate`, `/unloading/:id`, `/screening`, `/storage`, `/inventory`, `/outbound*`, `/exceptions` | Upcoming trucks, monitor, receiving, screening + truck-to-truck loading, holding (cancelled only), dashboard | **extend/replace**; `/storage`, `/inventory` → **hide**, replaced by `/holding` |
| `driver`: `/trip/:id/{vehicle,pretrip,pickup,count,seal,arrive,security,offload,handover,complete}`, `/map` | Transport Staff trips (no login for drivers) | **hide for departure**; **keep for arrival** (see Assumption A7) |
| `airport-coordinator`: `/dep/incoming`, `/dep/gate`, `/dep/receiving/:id`, `/dep/airline*` | `/` incoming trucks, seal check, offload, SGS handover, voucher | **replace** `dep/*`; `arr/*` **keep** |
| `airline-ground-handler` (all) | out of departure flow | **keep module, remove departure steps** from the flow and from Ops/Airport menus |
| `operations-manager`: `/cutoffs`, `/reconciliation`, `/closure`, `/trucks`, `/bags`, `/exceptions`, `/reports`, `/stakeholders` | flights (new/cancel/rebook), staff, areas & slots, 24 h forecast + 12 h window, exceptions, reports, closure | **extend**; `/trucks` → moves to Transport Manager (kept as read-only link) |
| `system-admin`: `/users`, `/roles`, `/config`, `/masterdata`, `/audit` | admins/ops/TM accounts, integrations, airline policy table | **extend** |
| — | `backend-team/`, `transport/` (manager + staff), `window-monitor/` | **create** new apps |

### 2.3 Services / components
| Old | v7 | Action |
|---|---|---|
| `components/scan-input.js` (×7 copies) | `shared/ui/scanner.js` + `shared/services/scanService.js` | **replace** in departure apps; arrival apps keep their copy |
| each app's `api.js` status writes | `bagService.advanceBag()` | **replace** (every departure status change) |
| ad-hoc `if (role === …)` / per-app role checks | `shared/rbac.js` (`can` / `scopeFilter` / `assertCan`) | **create** |
| per-app `store.js` | `shared/store.js` (single key `rabel_v7`, migrations) | **create**; old stores read once for migration, never deleted |
| `status-chip`, `bag-timeline`, `stepper` | reuse; add 13-status + side-status variants in `shared/ui/` | **extend** |
| `ROLES` in root `index.html` | v7 role list (Traveler, Backend Team, Check-in Staff, Transport Manager/Staff, Warehouse Manager, Airport Coordinator, Window Monitor, Ops, Admin); Driver/Delivery/Accommodation/Airline moved to a "Arrival & legacy" group | **replace** |

---

## 3. Data model changes & migrations

### 3.1 Approach
* New **`shared/`** folder (ES modules, no globals), imported by departure apps via `../shared/…`:
  `store.js`, `migrations/`, `models/`, `services/{bagService,scanService,staffService,flightService,tagService,transportService,windowService}.js`, `rbac.js`, `integrations/`, `ui/`, `seed/`, `time/`.
* **One shared store** `localStorage['rabel_v7']` = `{ __v, users, airlines, flights, travelers, residences, collectionAreas, collectionSlots, collectionAssignments, bags, bagTags, tagImportBatches, scanEvents, drivers, trucks, trips, sgsVouchers, rerouteLogs, exceptions, notifications, auditLog, counters, legacy:{…} }`. All departure apps (same origin) read/write it, which is what makes cross-role flows (check-in → transport → warehouse → airport → backend) possible. Arrival apps keep their own `rabel_ui_*` stores.
* **Migrations**: ordered array `[{ v, name, up(state) }]` in `shared/migrations/`, run on load; never edit a shipped migration — append. Fresh DB path = `createEmptyState()` → seed. Existing-data path = import from old `rabel_ui_*` keys (read-only) into `legacy` + mapped collections, then run migrations.
* Nothing is deleted: old keys stay untouched; replaced entities are kept under `legacy.*` and shown read-only with a "Legacy" label.

### 3.2 New / extended entities
Exactly as specified in the brief (Airline, Flight, Traveler, CollectionArea, Residence, CollectionSlot, CollectionAssignment, Bag, BagTag, TagImportBatch, ScanEvent, Driver, Truck, Trip, SgsVoucher, RerouteLog, +12 exception types). Additions I will make explicit: `Integration` config rows (nusuk, airlineFeed, sgs), `counters` (`internalTag`), `Notification` (role-targeted, for cancel fan-out), `AuditLog`.
LPN is always a **string** (`^\d{10}$`), never coerced to number.

### 3.3 Status migration map (unit-tested in Phase 1)
| Old | New |
|---|---|
| `Declared` | `Declared` |
| `Checked-in` (old: pre-tag) | `Checked-in` is now *post-tag*; old `Checked-in` without a tag → `Data Verified` (safest pre-check-in state); with a tag → `Checked-in` |
| `Tagged` | `Checked-in` |
| `Tag Pre-printed` | `Tag Assigned` |
| `Loaded to Collection Truck`, `Received at Warehouse`, `Screened` | unchanged |
| `Stored` | `Held – Cancelled Flight` if flight cancelled, else `Screened` |
| `Loaded to Airport Truck`, `In Transit to Airport`, `Received at Airport`, `Loaded on Aircraft` | unchanged |
| `Handed to Airline` | `Handed to Airport Authority` |
New statuses with no legacy source: `Data Verified`, `Tag Assigned`, `SGS Voucher Accepted`; side: `Held – Cancelled Flight`, `Rebooked`, `Returned to Traveler`.

### 3.4 User migration
| Old | New |
|---|---|
| Pilgrim | Traveler (label only) |
| `CHK-*` staff | Check-in Staff, assigned to a CollectionArea (centre → area map) |
| Warehouse Staff `WH-*` | Warehouse Manager, id re-prefixed `WM-*` (old id kept as `legacy_id`; login accepts both) |
| Driver users `DRV-*` | `status: Disabled`, `disabled_reason: "Moved to Driver records"` + matching `Driver` record |
| Airport Coordinator | `APC-*` |
| Ops `OPS-001`, Admin `ADM-001` | unchanged |
| — | create `BE-*`, `TM-*`, `TS-*`, `MON-*` |

---

## 4. Route / menu map per role (departure)

| Role | Home (folder) | Menu (hash routes) |
|---|---|---|
| Traveler | `pilgrim/` `#/` | Home/Sync · Book · Track · Receipt · Support |
| Backend Team | `backend-team/` `#/` | Data · Tags · Boarding pass · Tag verification · Manifest |
| Check-in Staff | `checkin-staff/` `#/` | Assignments · Route · Exceptions · Handover |
| Transport Manager | `transport/` `#/` | Staff · Drivers · Trucks · Window board · Dispatch · Reports |
| Transport Staff | `transport/` `#/trips` | Collection trips · Airport trips |
| Warehouse Manager | `warehouse-staff/` `#/` | Upcoming · Monitor · Receiving · Screening · Holding · Exceptions |
| Airport Coordinator | `airport-coordinator/` `#/` | Incoming · Seal · Offload · SGS handover · Voucher · (arrival menu unchanged) |
| Window Monitor | `window-monitor/` `#/` | Wall-board only |
| Operations Manager | `operations-manager/` `#/` | Flights · Staff · Areas & slots · Forecast · Exceptions · Reports · Closure |
| System Admin | `system-admin/` `#/` | Accounts · Integrations · Airline policy · Audit |

The spec's "home" paths (`/staff`, `/backend`, …) are mapped to these folders; each app also gets a root-level redirect alias folder only if you ask for it (A2).

---

## 5. Files created / changed per phase

* **P1 Foundation** — new: `package.json`, `eslint.config.js`, `jsconfig/tsconfig.json` (checkJs), `vitest.config.js`, `.env.example`, `shared/{store,rbac,config}.js`, `shared/migrations/*`, `shared/models/*`, `shared/services/{bagService,staffService}.js`, `shared/time/window.js`, `shared/seed/legacy-import.js`, `tests/unit/{bagService,rbac,statusMigration}.test.js`. Changed: root `index.html` (roles), departure menus in `pilgrim`, `checkin-staff`, `warehouse-staff`, `airport-coordinator`, `operations-manager`, `system-admin` (hide legacy items, relabels, ROLE presets). CLAUDE.md created.
* **P2 Traveler + Backend** — `pilgrim/js/views/{login,home,book,track,receipt}.js` + api; new `backend-team/**`; `shared/integrations/{nusuk,airlineFeed}.js`, `shared/services/tagService.js`, `shared/tags/{validateLpn,csv}.js`.
* **P3 Check-in + Scanner** — `checkin-staff/**` rewritten (views `assignments`, `assignment`, etc.), `shared/ui/scanner.js`, `shared/services/scanService.js`.
* **P4 Transport** — new `transport/**`, `shared/services/transportService.js` (dispatch + reroute).
* **P5 Warehouse Manager** — `warehouse-staff/**` receiving/screening/loading/holding/dashboard.
* **P6 Airport run + Coordinator** — `transport` airport trips, `airport-coordinator` dep views, `shared/integrations/sgs.js`.
* **P7 Ops/Monitor/Admin/Seed/Verify** — `operations-manager/**`, new `window-monitor/**`, `system-admin/**`, `shared/seed/departure.js`, `scripts/seed-departure.mjs`, `tests/e2e/*`, CLAUDE.md "Departure v7 rules", this plan updated.

---

## 6. Test plan
* **Unit (Vitest, pure modules in `shared/`, injectable clock/store):** `advanceBag` (forward-only, one step, side statuses only via helpers, rbac enforced), rbac presets/scopes, status migration, `validateLpn` (format, leading zero kept as string, BTIC allow-list, duplicate, released/flight/step), count-match rules, 12 h window + priority ranking, airline weight/count policy, cancel/rebook side effects, reroute suggestion, idempotent seed.
* **E2E (Playwright + a static server, seeded store via `?seed=departure`):** checks 2, 4, 6, 7, 10 from the brief; plus the regression check (one bag through all 13 statuses; every scan has a method) at the service level.
* **Gates per phase:** `npm run lint` · `npm run typecheck` (tsc `checkJs` on `shared/` + changed apps) · `npm test` · `npm run build`.

## 7. Risks
1. **Scale.** ~7 phases rewriting 5 existing apps + 3 new apps in a no-framework codebase; the per-app code is duplicated, so some copy/paste is unavoidable.
2. **No existing safety net** (zero tests) — arrival regression is guarded only by not touching arrival files + a smoke e2e that loads each arrival app.
3. **localStorage** is per-browser/origin: demo roles must run in the same browser profile and origin to share state; ~5 MB quota (seed sized accordingly).
4. **CDN dependencies** (lucide, html5-qrcode, JsBarcode via unpkg/cdnjs) — e2e needs network or local vendoring.
5. **Playwright browser download** may be unavailable offline; fallback = jsdom-level service tests only, reported honestly.
6. **Camera ITF scanning** is device-dependent; cannot be e2e-tested — covered by unit tests of read-acceptance logic only.
7. Mixed-direction apps (`driver`, `airport-coordinator`, `pilgrim`) must keep arrival working while departure is replaced.

## 8. Conflicts between the spec and the repo (spec wins, noted)
* Spec mentions Base44 entities / `npm run seed` / migrations → none exist; created as in §3 (A1–A4).
* Spec: "Driver is not a login role" vs. arrival requirement "must keep working unchanged" → see A7.
* Spec: Warehouse prefix `WM-`; repo uses `WH-` → re-prefix + accept legacy id.
* Spec: "Pilgrim → Traveler everywhere" → labels renamed in departure UI and landing; folder `pilgrim/` kept so arrival deep links don't break.

## 9. Assumptions (the choices I will make unless you object)
* **A1 Tooling.** Add root `package.json` with **dev-only** deps: `vitest`, `eslint`, `typescript` (checkJs via JSDoc, no TS conversion), `@playwright/test`, `http-server`. Runtime stays zero-build. `npm run build` = `scripts/build-check.mjs`: verifies every `import` and asset reference resolves and every app's `index.html` loads its entry (there is nothing to bundle).
* **A2 Structure.** Shared domain layer in `shared/`; new apps as new folders (`backend-team`, `transport`, `window-monitor`); existing folders reused. Spec URL homes map to folders (§4); no alias folders.
* **A3 Shared store.** Departure apps share `rabel_v7`; arrival apps untouched on `rabel_ui_*`. A departure bag that must be visible to arrival does not exist (separate flows).
* **A4 Seed / "migrations on a fresh DB".** Seed is deterministic with stable IDs (upsert, so re-running never duplicates). `npm run seed:departure` builds the seed in Node, validates it and writes `shared/seed/departure.seed.json`; the browser loads it via `?seed=departure` or the Ops/Admin "Reset demo data" action. "Run migrations on existing data" = import from old `rabel_ui_*` keys.
* **A5 Integrations.** `shared/integrations/{nusuk,airlineFeed,sgs,sms,maps,gps}.js` each export an interface + a simulated implementation; selection via `shared/config.js` (reads `window.RABEL_CONFIG`); `.env.example` documents the keys a future server would use. No secrets in code.
* **A6 Windows.** 12 h window = `[cut_off−12h, cut_off]`: collection/check-in `[−12h,−4h]` (8 h), warehouse `[−4h,−2h]`, drive `[−2h,0]`. Red alert when bags aren't at the airport by `cut_off−30min`. Priority = earliest cut-off, tie → more bags remaining; recalculated every 5 min (and on demand in tests via injectable clock).
* **A7 Driver app.** Departure login and departure trips are removed from the `driver/` app; it remains available **for arrival trips only** (labelled "Arrival — legacy driver app"). Departure drivers are `Driver` records managed by the Transport Manager and operated by Transport Staff.
* **A8 Airline/Ground Handler** stays as a module under the "Arrival & legacy" landing group; its departure-facing items (BSM/loading/acceptance) are hidden from departure menus; manifest confirmation moves to Backend.
* **A9 Check-in-before-tag edge case.** Old `Checked-in` bags with no tag map to `Data Verified` (see §3.3).
* **A10 OTP** is simulated as `123456` for travelers; staff PIN `1234`; Admin 2FA `123456` (as today).
* **A11 Git.** Work on `feature/departure-v7`, one commit per phase (`feat(departure-v7): phase N — <title>`), no pushes.
* **A12 Libraries.** `html5-qrcode`, `JsBarcode`, `qrcodejs`, `lucide` are already used via CDN; no new runtime libraries. If CDN access fails in e2e, vendor them under `shared/vendor/` (same libs, no new ones).

## 10. To verify in Phase 1 (not fully read during audit)
Exact contents of `system-admin` roles/users screens, `operations-manager/api.js` flight/cut-off logic, `warehouse-staff` outbound/trip data, `airport-coordinator/api.js` `dep/*` logic and `pilgrim/api.js` booking. These are read in full at the start of each phase before editing; findings that change this plan will be recorded in the final "what changed vs plan" section.

---

## 11. Phase 1 — what changed vs the plan (implemented)
* **Done:** `package.json` + ESLint/tsc(checkJs)/Vitest/build-check; `shared/{constants,models,config,rbac,store}.js`, `shared/migrations/{001-foundation,002-legacy-import,003-normalize-statuses,statusMap}`, `shared/services/{bagService,staffService,audit}`, `shared/time/window.js`, `shared/seed/baseAccounts.js`; 66 unit tests.
* **Bridge added (not in the plan):** `shared/seed/baseAccounts.js` upserts the demo accounts/areas/warehouse/airport into the shared store so every role has a v7 identity before Phase 7's full seed. It only fills missing fields.
* **UI:** Check-in Staff — login without centre/counter, menu reduced to Assignments/Exceptions/Handover, `/appointments /checkin /loading /history` redirect to `#/` (old dashboard kept as `views/legacy-dashboard.js`). Warehouse — renamed Warehouse Manager, `WM-` ids (legacy `WH-` still signs in), `/storage /inventory` hidden. Airport — `/dep/airline` hidden. Admin — v7 role list/prefixes, Driver retired (existing driver users Disabled), store v2→v3 upgrade. Landing — Departure / Arrival & legacy groups; Backend, Transport, Monitor cards marked "Coming in Phase N".
* **Deliberately deferred:** the other mixed apps (`pilgrim`, `driver`, `operations-manager`) still use their own stores for their screens until their phases; only labels were changed. Existing localStorage for those apps is untouched.
* **Noted for Phase 5:** the spec's "Rebooked → new tag → Release to loading" skips Checked-in…Screened (the bag is already screened). A named helper `releaseRebookedToLoading` will be added to `bagService` then; `advanceBag` stays strictly one-step.
* **`seed:departure`** npm script is not added yet (Phase 7).

## 12. Phase 2 — what changed vs the plan (implemented)
* **Done:** Traveler app (`pilgrim/js/v7/*`: Nusuk-ID/booking-ref + passport → OTP, "Synced from Nusuk" + Sync again, contact-only edits with change log, booking with airline policy and 2-hour slots in the 8 h window, confirmation without a QR, tracking with the 13-step timeline, cancelled/rebooked/absent banners and slot re-pick, digital receipt, support, notifications) and the new `backend-team/` app (dashboard tiles, data collection, tags, boarding pass, tag verification, manifest). Shared: `validateLpn`, `csv`, `tagService`, `travelerService`, `backendService`, `notify`, integration adapters + simulated data, departure seed. 109 unit tests.
* **Traveler app is dual-mode (not in the plan):** v7 travelers use the shared store; the arrival-demo travelers still sign in through the old flow, whose city-check-in booking is now unreachable (Book tab + `/book` hidden for them).
* **Legacy rows:** pre-v7 imported travelers/bags (`legacy: true`) never match airline data and are excluded from Backend queues; legacy flights are upgraded in place with a cut-off when the departure seed runs (found while testing against real imported browser data).
* **LPN layout** documented: issuer = digits 1–3, serial = digits 4–9, digit 10 not validated (Rabel cannot know the airline's check-digit rule).
* **Boarding-pass tile** counts only travelers that have airline boarding-pass data (the one traveler missing from airline data appears under "data missing" instead).
* **Not yet:** "Damaged tag" requests from check-in (Phase 3 creates the `Damaged Tag` exception the Backend list already reads); scan statuses Attached/Scanned (Phase 3); `seed:departure` npm script + "Reset demo data" (Phase 7).

## 13. Phase 3 — what changed vs the plan (implemented)
* **Done:** `checkinService`, `scanService`, `exceptionService`, `shared/scan/readFilter.js`, `shared/ui/scanner.{js,css}`; Check-in Staff app rebuilt around assignments (list + per-assignment flow); Backend gets Damaged-tag "Void & replace" and extra-bag tag requests. 140 unit tests.
* **Staff model:** a Check-in Staff signs in with the shared v7 account (CHK-001/2/3) — one per area. Old counter/centre/appointment screens remain hidden.
* **Binding:** because a traveler's bags are interchangeable until tagged, a scanned airline tag / Rabel label is bound to the bag row being processed (swapped with the traveler's other bag when it was pre-assigned there). Duplicates are refused.
* **Absent:** `Traveler Absent` is an exception; staff can book a new slot immediately (status `Rescheduled`) or the traveler picks one; when no slot is left Ops is notified.
* **`pending_pickups`** now means "checked-in bags handed over and not yet loaded onto a collection truck" (the seed recomputes it); Phase 4 decrements it when Transport loads.
* **Not browser-testable here:** camera scanning (needs a device); it is covered by unit tests of the read-acceptance logic only. The handheld path was driven end to end in Chrome.
* **Noted:** the extra-bag `extra_approval` goes Pending (booked) → Requested (accepted at residence); there is no airline approval workflow yet (Phase 7 Admin policy only).

## 14. Phase 4 — what changed vs the plan (implemented)
* **Done:** new `transport/` app (Transport Manager home `/`, Transport Staff home `/trips`, one login screen routing to the right home by role); `shared/services/transportService.js` (driver/truck CRUD + status, `windowBoard`, `dispatchCollectionTrip`, the Collection-trip lifecycle `loadCollectionTrip`/`departTrip`/`arriveAtWarehouse`, `rerouteTrip`, `reportSummary`); `shared/models.js` `makeDriver`/`makeTruck`/`makeTrip`; `TRIP_STATUSES` in `shared/constants.js`; demo fleet (`BASE_DRIVERS`/`BASE_TRUCKS`) in `shared/seed/baseAccounts.js`. 20 unit tests (`tests/unit/transportService.test.js`); verified live in-browser end to end (Backend tags → Check-in residence flow → Transport dispatch → load/depart/arrive → driver/truck freed → Reports), zero console errors.
* **Pickup count match uses the check-in log, not bag status.** A bag is only "eligible" for a Collection trip once its `CollectionAssignment` is `Handed to Transport` (`checkinService.handToTransport`'s `handed_bag_ids`) — matching the plan's "count match vs check-in log" rule, not merely `status === 'Checked-in'` (which could still be sitting with Check-in Staff mid-flow, not yet physically at the pickup point).
* **Airport trips deferred to Phase 6, as planned.** The Staff "Airport trips" tab and route exist (matching §4's role map) but show an empty "no airport trips yet" placeholder — there's nothing to move until Warehouse (Phase 5) can set a bag `Loaded to Airport Truck`, and the real flow needs Phase 6's Airport Coordinator screens built alongside it. Building speculative Airport-trip UI now would likely be reshaped by Phase 6's actual requirements.
* **One active trip per area.** `dispatchCollectionTrip` refuses to dispatch a second trip while one is already `Dispatched`/`Loaded`/`En Route` for the same area — avoids double-claiming the same pickup-log bags. A Manager can still `rerouteTrip` the existing one (swap driver and/or truck, reason required) instead of dispatching around it.
* **Resource lifecycle:** driver/truck go `Available → Busy` on dispatch, back to `Available` on `arriveAtWarehouse`; a reroute sends the *replaced* resource to `Off duty` (assumed broken/unavailable) rather than back to `Available`, since reroutes model a problem with that resource.
* **Not yet:** Reports is a simple summary + trip list (no CSV export, no date-range filter — Phase 7 extends Ops/Reports generally); Transport Manager "Staff" reuses `staffService` as-is (no transport-specific fields beyond `area_id`).

## 15. Phase 5 — what changed vs the plan (implemented)
* **Done:** `shared/services/warehouseService.js` (upcoming trucks · receiving with truck-QR + per-label scans and a blocking count match · monitor with the 2 h timer · screening · loading onto the airport truck · cancelled-flight holding · read-only exceptions); `bagService.releaseRebookedToLoading`; `transportService.dispatchAirportTrip`; the `warehouse-staff/` app rebuilt on the shared store (Monitor · Upcoming · Receiving · Screening · Loading · Holding · Exceptions). 33 unit tests (`tests/unit/warehouseService.test.js`), 193 in total. Verified live in Chrome end to end — Backend tags → residence check-in → collection trip → warehouse receiving (wrong truck QR refused, duplicate label refused, short count blocked with the missing label named) → screening → request + dispatch airport truck → load → close → holding → rebook → re-tag → release — with zero console errors.
* **"Loading" is its own screen** (the role map in §4 folded it into Screening). It has a scanner and its own queue; merging it into Screening would have put two different scan contexts on one page. Menu order otherwise matches §4.
* **The release target is the stage the bag was held from, not always "Screened".** Phase 1 noted the spec's "Rebooked → new tag → Release to loading" as skipping Checked-in…Screened. Driving it out showed that is only right for a bag held *after* screening: a bag held at "Received at Warehouse" was never screened, and releasing it to "Screened" would skip a real step. `releaseRebookedToLoading` therefore restores `held_from_status`, capped at "Screened", and refuses a bag held before it reached the warehouse.
* **Receiving needs a warehouse permission, not just `trip:update`.** Transport Staff hold `trip:update` for their own area's trips, so the first implementation let them receive at the warehouse. Every receiving/loading entry point now asserts the status only the Warehouse Manager may set (`bag:advance:Received at Warehouse` / `…Loaded to Airport Truck`); `screenBags`/`holdBags` assert up front instead of failing per bag. Caught by the RBAC tests.
* **Screening raises no new exception type.** The 12 v7 exception types have nothing for an X-ray alarm, and inventing a 13th was out of scope here; screening is a bulk advance with an optional note. A pull-for-inspection workflow needs an Ops-defined type — flagged for Phase 7.
* **Seed bug found and fixed:** `seedCancelledFlightBags` created brand-new v7 bags for *every* traveler on the cancelled flight, including pre-v7 (`legacy: true`) travelers imported from the old `rabel_ui_*` stores — 12 bags instead of 8 in a browser carrying old data, for travelers with no residence. Now filtered to v7 travelers; `SEED_VERSION` → 5. Phantom bags already created in a browser are not deleted (the seed never deletes) — they clear on the Phase 7 "Reset demo data".
* **Warehouse timer falls back to status history** when `received_at_warehouse_at` is absent (seeded or migrated rows), so the Monitor never shows a blank timer for bags that are demonstrably in the warehouse.
* **Transport "Active trips" tile** now counts airport runs too (it read `reportSummary`, which is collection-only by Phase 4's contract).
* **Not yet:** the airport truck can be loaded and closed but not driven — `In Transit to Airport`, `Received at Airport` and the Coordinator's screens are Phase 6. No CSV export or date filters on warehouse reports (there is no warehouse Reports screen; Ops reporting is Phase 7).

## 16. Phase 6 — what changed vs the plan (implemented)
* **Done:** `shared/services/airportService.js` (incoming airport trucks · seal check · offload with one internal-label scan per bag and a count match · SGS handover against the manifest, scanning only disputed bags · voucher acceptance), `shared/integrations/sgs.js`, `makeHandover`/`makeSgsVoucher` in `shared/models.js`, `transportService.departForAirport`/`arriveAtAirport` (the Phase 4 placeholder replaced by a drivable airport run, `In Transit to Airport` idempotent), and `airport-coordinator/` rebuilt on the shared store (`js/v7/*`: dashboard · incoming · seal · offload · handover · voucher). 24 unit tests, 217 in total.
* **Pre-v7 departure views kept on disk** as `legacy-dep-*.js`, unimported; the `/arr/*` arrival screens are untouched.
* **The seal belongs to the airport run, not the collection trip.** `Trip.seal_no` is set when Transport Staff depart the warehouse and checked by the Coordinator on arrival; a broken seal raises `Seal Broken` and blocks the offload until Ops releases it (`seal:release`).
* **SGS reconciles the airline tags, not the internal labels** — the handover manifest is the airline-tag list, and only disputed bags are scanned again (`scanDisputedTag`), as the scan-point rule requires.
* **A voucher that counts fewer tags than were handed over** is `Mismatch`, raises `SGS Voucher Mismatch`, and does **not** advance those bags; the matching tags still advance. The demo switch is `state.simulated.voucherDrops[flightId]`.

## 17. Phase 7 — what changed vs the plan (implemented)
* **Done:** the last three consoles and the tooling around the demo.
  * `shared/services/flightService.js` — the flight board, the 24 h forecast, create/update, `cancelFlight`, `rebookBags`, the closure checklist and `closeFlight`.
  * `shared/services/areaService.js` — collection areas and their 2 h slots (capacity only; times always come from the flight's window).
  * `shared/services/exceptionService.js` — extended from "raise" to the full Ops lifecycle: Open → Assigned → Escalated → Resolved → Closed (+ reopen).
  * `shared/services/reportService.js` — the Ops roll-up, the bag/exception/scan ledgers and the one CSV writer.
  * `shared/services/monitorService.js` — the wall board (composed from the other read models) and `alertOps`.
  * `shared/services/adminService.js` — integration status + connection test, the airline policy table, the audit read model and `resetDemoData`.
  * `shared/seed/validate.js` + `scripts/seed-departure.mjs` (`npm run seed:departure`, the fifth gate in `npm run check`).
  * Apps: `operations-manager/` rebuilt (Flights · Forecast · Exceptions · Areas & slots · Staff · Reports · Closure), new `window-monitor/`, `system-admin/` rebuilt (Accounts · Roles · Integrations · Airline policy · Audit).
  * 62 new tests (279 total) plus 20 Playwright browser checks.
* **Cancelling a flight moves no bag.** The plan implied a fan-out; driving it out showed the fan-out must *not* include holding the bags — the rack is recorded by the Warehouse Manager (`holdBags`) or the Coordinator, and a bag at a residence is not ours to move. `cancelFlight` therefore sets the status, calls off every collection that has not happened yet (new assignment status **`Cancelled`**, their slots freed), and notifies all eight operational roles plus every affected traveler by app and SMS. The warehouse's existing "to hold" queue picks the bags up from there.
* **Legacy bags are excluded from every Ops count.** Pre-v7 rows imported from the old per-app stores (`legacy: true`) can never move through the v7 line, so counting them inflated every flight and would have made a closure impossible. Found by running the new console against a browser carrying real imported data.
* **Closure blocks on High/Critical exceptions only.** Every bag must be accounted for (`ACCOUNTED_STATUSES`); lower-severity exceptions are listed as warnings rather than blockers, so a cosmetic Data Mismatch cannot strand a finished flight.
* **Roles screen is generated, not written.** The Admin "Roles" page (a fifth item beyond §4's four) renders `ROLE_PRESETS` directly — scope, which bag statuses the role may set, who it manages, its permissions — so it cannot drift from what is enforced. It replaces the Phase 1 role list in the legacy admin app.
* **Reset demo data** lives on Admin → Integrations and Ops → Reports (both presets hold `demo:reset`), behind a typed confirmation, plus `?seed=departure` on any departure app. 
* **No `departure.seed.json`.** A4 proposed writing the built seed to a file for the browser to load. Every cut-off is relative to "now" — a demo has to open with its flights still ahead of their window — so a frozen snapshot would ship stale cut-offs and show every flight red. `npm run seed:departure` instead builds the same seed in Node and *validates* it (referential integrity, window and slot arithmetic, tag formats and uniqueness, no held bag on a live flight); `--json=<path>` dumps one for inspection.
* **Playwright drives the installed Chrome** (`channel: 'chrome'`) rather than downloading browsers, which keeps the repo's install small; `npm run test:browser` is deliberately not part of `npm run check`, which must keep running where no browser exists.
* **Not done:** the airline/ground-handler module is still outside the departure flow (A8, unchanged); there is no pull-for-inspection exception type for screening (flagged in Phase 5 — it needs an Ops-defined type, and inventing a 13th was out of scope); extra-bag approval is still a flag on the assignment with no airline workflow behind it.
