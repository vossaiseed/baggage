/**
 * Simulated external datasets behind the integration adapters. Nothing here is
 * imported by screens — only by the simulated adapters. A real API replaces
 * the adapter, not the screens.
 */

const res = (building, flat_no, street, district, lat, lng, phone, landmark) => ({ building, flat_no, street, district, lat, lng, contact_phone: phone, landmark });

/** Raw Nusuk records (what Nusuk knows: identity, flight, residence). */
export const NUSUK_RECORDS = Object.freeze([
  { nusuk_id: '2000000001', name: 'Siti Rahmah', passport: 'C1234567', flight_code: 'SV 1821', residence: res('Al-Safwa Hotel', '412', 'Ibrahim Al-Khalil St', 'Aziziyah', 21.4231, 39.8742, '+966500000001', 'Next to the green mosque') },
  { nusuk_id: '2000000002', name: 'Asif Karim', passport: 'AB7654321', flight_code: 'SV 1821', residence: res('Dar Al-Eiman Building 3', '21', 'Al-Awali Main Rd', 'Al-Awali', 21.3862, 39.8411, '+966500000002', 'Opposite the pharmacy') },
  { nusuk_id: '2000000003', name: 'Fatima Noor', passport: 'A09876543', flight_code: 'SV 1821', residence: res('Shisha Residence B', '7', 'Shisha Rd', 'Shisha', 21.4008, 39.8893, '+966500000003', 'Blue gate') },
  { nusuk_id: '2000000004', name: 'Ahmad Yusuf', passport: 'BX0987654', flight_code: 'GA 981', residence: res('Aziziyah Towers', '1105', 'Al-Aziziyah St', 'Aziziyah', 21.4219, 39.8761, '+966500000004', 'Tower B lobby') },
  { nusuk_id: '2000000005', name: 'Dewi Lestari', passport: 'C7654321', flight_code: 'GA 981', residence: res('Al-Awali Pilgrim House', '3', 'Al-Awali Side Rd', 'Al-Awali', 21.3849, 39.8398, '+966500000005', 'Yellow building') },
  { nusuk_id: '2000000006', name: 'Hassan Ali', passport: 'AB1234567', flight_code: 'GA 981', residence: res('Shisha Hotel', '215', 'Shisha Rd', 'Shisha', 21.3996, 39.8905, '+966500000006', 'Behind the bakery') },
  { nusuk_id: '2000000007', name: 'Rizwan Ahmed', passport: 'A01234567', flight_code: 'PK 760', residence: res('Aziziyah Plaza', '808', 'Al-Aziziyah St', 'Aziziyah', 21.4242, 39.8735, '+966500000007', 'Plaza entrance') },
  { nusuk_id: '2000000008', name: 'Mariam Khan', passport: 'PK4455667', flight_code: 'PK 760', residence: res('Awali Residence', '12', 'Al-Awali Main Rd', 'Al-Awali', 21.3871, 39.8422, '+966500000008', 'Near the bus stop') },
  { nusuk_id: '2000000009', name: 'Usman Tariq', passport: 'PK8899001', flight_code: 'SV 1944', residence: res('Aziziyah Heights', '502', 'Al-Aziziyah St', 'Aziziyah', 21.4228, 39.8755, '+966500000009', 'Side entrance') },
  { nusuk_id: '2000000010', name: 'Aisha Bibi', passport: 'PK1122334', flight_code: 'SV 1944', residence: res('Awali Garden', '34', 'Al-Awali Side Rd', 'Al-Awali', 21.3858, 39.8405, '+966500000010', 'Garden gate') },
  { nusuk_id: '2000000011', name: 'Ibrahim Malik', passport: 'PK5566778', flight_code: 'SV 1944', residence: res('Shisha Court', '9', 'Shisha Rd', 'Shisha', 21.4003, 39.8899, '+966500000011', 'Red door') },
  { nusuk_id: '2000000012', name: 'Zainab Hussain', passport: 'PK3344556', flight_code: 'SV 1944', residence: res('Aziziyah Palace', '61', 'Al-Aziziyah St', 'Aziziyah', 21.4236, 39.8748, '+966500000012', 'Palace hotel lobby') },
  { nusuk_id: '2000000013', name: 'Khalid Rahman', passport: 'BD2233445', flight_code: 'GA 7005', residence: res('Awali Suites', '18', 'Al-Awali Main Rd', 'Al-Awali', 21.3867, 39.8417, '+966500000013', 'Suites reception') },
  // Residence in a district Rabel has no collection area for → "Unmapped address" in Backend.
  { nusuk_id: '2000000014', name: 'Noor Fatima', passport: 'BD5566778', flight_code: 'GA 7005', residence: res('Kudai Apartments', '44', 'Kudai Rd', 'Kudai', 21.3601, 39.8102, '+966500000014', 'Behind the fuel station') },
]);

/** Raw airline reservation records (what the airline knows: booking, boarding pass). Intentional gaps/mismatches for the demo. */
export const AIRLINE_RECORDS = Object.freeze([
  { booking_ref: 'SVK7Q1', passport: 'C1234567', name: 'Siti Rahmah', flight_code: 'SV 1821', boarding_pass_no: 'BP-SV1821-001' },
  { booking_ref: 'SVK7Q2', passport: 'AB7654321', name: 'Asif Karim', flight_code: 'SV 1821', boarding_pass_no: 'BP-SV1821-002' },
  { booking_ref: 'SVK7Q3', passport: 'A09876543', name: 'Fatima Noor', flight_code: 'SV 1821', boarding_pass_no: 'BP-SV1821-003' },
  { booking_ref: 'GAM4R1', passport: 'BX0987654', name: 'Ahmad Yusuf', flight_code: 'GA 981', boarding_pass_no: 'BP-GA981-001' },
  // name differs from Nusuk → MISMATCH
  { booking_ref: 'GAM4R2', passport: 'C7654321', name: 'Dewi Lestari Putri', flight_code: 'GA 981', boarding_pass_no: 'BP-GA981-002' },
  // passport differs from Nusuk (AB1234567) → MISMATCH
  { booking_ref: 'GAM4R3', passport: 'AB1234576', name: 'Hassan Ali', flight_code: 'GA 981', boarding_pass_no: 'BP-GA981-003' },
  { booking_ref: 'PKT9S1', passport: 'A01234567', name: 'Rizwan Ahmed', flight_code: 'PK 760', boarding_pass_no: 'BP-PK760-001' },
  { booking_ref: 'PKT9S2', passport: 'PK4455667', name: 'Mariam Khan', flight_code: 'PK 760', boarding_pass_no: 'BP-PK760-002' },
  { booking_ref: 'SVL2U1', passport: 'PK8899001', name: 'Usman Tariq', flight_code: 'SV 1944', boarding_pass_no: 'BP-SV1944-001' },
  { booking_ref: 'SVL2U2', passport: 'PK1122334', name: 'Aisha Bibi', flight_code: 'SV 1944', boarding_pass_no: 'BP-SV1944-002' },
  { booking_ref: 'SVL2U3', passport: 'PK5566778', name: 'Ibrahim Malik', flight_code: 'SV 1944', boarding_pass_no: 'BP-SV1944-003' },
  { booking_ref: 'SVL2U4', passport: 'PK3344556', name: 'Zainab Hussain', flight_code: 'SV 1944', boarding_pass_no: 'BP-SV1944-004' },
  // Khalid Rahman (2000000013) is deliberately NOT here → MISSING in airline data
  { booking_ref: 'GAN6V2', passport: 'BD5566778', name: 'Noor Fatima', flight_code: 'GA 7005', boarding_pass_no: 'BP-GA7005-002' },
]);

/** Boarding-pass numbers the traveler/airport copy holds when they differ from the airline's (demo: 2 unverified). */
export const BOARDING_PASS_OVERRIDES = Object.freeze({
  '2000000004': 'BP-GA981-0O1', // typo vs airline BP-GA981-001
  '2000000008': 'BP-PK760-020', // differs vs BP-PK760-002
});
