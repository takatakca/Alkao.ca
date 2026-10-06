import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseReservationsReport } from "../../ops-ui/reservations-csv.js";
import {
  bookingCategory, normalizeEmail, normalizePhone, normalizePostalCode, samePerson, scrubCardNumbers, tidyText,
} from "../../src/domain/customers.js";
import { adm, call, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { line, report } from "../helpers/reservations.js";
import { seedTwoTenants, type SeedResult } from "../helpers/seed.js";

/**
 * Run 41: the customer file (CRM). Every name, address and number here is made up.
 * "Today" is 2026-06-25 in Québec.
 */
let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool, { now: () => new Date("2026-06-25T16:00:00Z") });
});

afterAll(async () => {
  await db?.drop();
});

const ALICE = { Nom: "EXEMPLE", Prénom: "ALICE", Courriel: "Alice.Exemple@Example.com", Cellulaire: "(514) 555-0101", CP: "j0e2l2", Province: "Québec", Pays: "CA", Ville: "maricourt" };

const owner = () => tokenFor(seed.users.havanaOwner);
const base = () => adm(seed.havana.clientId, seed.havana.brandId);
async function importReport(bytes: Uint8Array, reportDate: string, complete = true) {
  const { rows } = parseReservationsReport(bytes);
  const token = await owner();
  const res = await call(app, "POST", `${base()}/customers/import`, { token, body: { reportDate, rows } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  if (!complete) return { import: res.body.import, complete: null };
  const done = await call(app, "POST", `${base()}/customers/import/complete`, { token, body: { reportDate } });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return { import: res.body.import, complete: done.body.import };
}
async function list(query = "") {
  const res = await call(app, "GET", `${base()}/customers${query}`, { token: await owner() });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}
async function find(q: string) {
  const body = await list(`?q=${encodeURIComponent(q)}`);
  expect(body.customers.length, q).toBe(1);
  return (await call(app, "GET", `${base()}/customers/${body.customers[0].id}`, { token: await owner() })).body.customer;
}

describe("cleaning rules", () => {
  it("normalizes contact details and drops placeholders", () => {
    expect(normalizeEmail(" Alice.Exemple@Example.COM ")).toBe("alice.exemple@example.com");
    expect(normalizeEmail("aucun@aucun.com")).toBeNull();
    expect(normalizeEmail("no@example.com")).toBeNull();
    // A real name that merely starts like a placeholder is kept.
    for (const real of ["nathalie@example.com", "nancy.test@example.com", "normand@example.com", "testard@example.com", "nadia@example.com"]) {
      expect(normalizeEmail(real)).toBe(real);
    }
    expect(normalizeEmail("pas une adresse")).toBeNull();
    expect(normalizePhone("1 (514) 555-0101")).toBe("5145550101");
    expect(normalizePhone("000-000-0000")).toBeNull();
    expect(normalizePhone("514-555-5555")).toBeNull();
    expect(normalizePostalCode("j0e2l2", "CA")).toBe("J0E 2L2");
    expect(normalizePostalCode("75011", "FR")).toBe("75011");
    expect(tidyText("  ALICE   EXEMPLE-TEST ", 120)).toBe("Alice Exemple-Test");
    expect(tidyText("Marie-Ève O'Brien", 120)).toBe("Marie-Ève O'Brien");
  });

  it("removes anything that looks like a payment card, and only that", () => {
    expect(scrubCardNumbers("Jean 4111 1111 1111 1111")).toEqual({ text: "Jean", removed: 1 });
    expect(scrubCardNumbers("carte 5500-0000-0000-0004 exp 12/28").removed).toBe(1);
    // Not a card: the checksum fails, or it is a phone number.
    expect(scrubCardNumbers("1234 5678 9012 3456").removed).toBe(0);
    expect(scrubCardNumbers("514 555-0101").removed).toBe(0);
  });

  it("tells lodging families apart and the same person from another", () => {
    expect(["104", "CHALET 12", "Chalet 3 (chiens)", "CABANA 7", "Condo 2 Amarillo", "Villa Mar 1", "TENTE BOIS 4", "TER12", "BACKUP 2", "Coolbox 3"].map(bookingCategory))
      .toEqual(["camping", "chalet", "chalet", "cabana", "condo", "villa", "tent", "camping", "other", "coolbox"]);
    expect(samePerson({ firstName: "Alice", lastName: "Exemple" }, { firstName: "Alicia", lastName: "EXEMPLE" })).toBe(true);
    expect(samePerson({ firstName: "Alice", lastName: "Exemple" }, { firstName: "Alice", lastName: "Exemple-Fictif" })).toBe(true);
    expect(samePerson({ firstName: "Alice", lastName: "Exemple" }, { firstName: "Bruno", lastName: "Fictif" })).toBe(false);
  });
});

describe("reading a Réservation camping.ca report", () => {
  it("keeps only the customer file's fields, mends a row shifted by a ';' and never reads comments or plates", () => {
    const bytes = report([
      line("9001", "CHALET 12", "2025-07-10", "2025-07-12", { ...ALICE, Commentaires: "carte 4111 1111 1111 1111; arrivée tard", Immatriculation: "ABC123", "Pers. suppl1": "Invité Secret" }),
      line("9002", "104", "2025-08-01", "2025-08-03", { Nom: "Fictif", Prénom: "Bruno", Courriel: "bruno@example.com", Arrivé: "Oui", "Résrv de groupe": "Oui" }),
    ]);
    const parsed = parseReservationsReport(bytes);
    expect(parsed).toMatchObject({ unreadable: 0, repaired: 1 });
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({ sourceRef: "9001", item: "CHALET 12", startsOn: "2025-07-10", endsOn: "2025-07-12", adults: 2, totalCents: 25000, firstName: "ALICE", region: "Québec" });
    expect(parsed.rows[1]).toMatchObject({ checkedIn: true, groupBooking: true });
    const everything = JSON.stringify(parsed.rows);
    for (const secret of ["4111", "arrivée tard", "ABC123", "Invité Secret", "100.00", "En Ligne"]) expect(everything).not.toContain(secret);
  });

  it("refuses a file that is not a reservations report", () => {
    expect(() => parseReservationsReport(Buffer.from("a;b;c\r\n1;2;3\r\n"))).toThrow("not_a_reservations_report");
  });
});

describe("the customer file", () => {
  it("is for owners, admins and managers; importing and exporting for owners and admins", async () => {
    const viewer = await tokenFor(seed.users.both); // a viewer at Havana
    const staff = await tokenFor(seed.users.havanaStaff);
    expect((await call(app, "GET", `${base()}/customers`, { token: staff })).status).toBe(403);
    expect((await call(app, "GET", `${base()}/customers`, { token: viewer })).status).toBe(403);
    expect((await call(app, "POST", `${base()}/customers/import`, { token: staff, body: { reportDate: "2026-06-01", rows: [] } })).status).toBe(403);
    expect((await call(app, "GET", `${base()}/customers.csv`, { token: staff })).status).toBe(403);
    // Another Client's owner does not even learn the file exists.
    expect((await call(app, "GET", `${base()}/customers`, { token: await tokenFor(seed.users.festiOwner) })).status).toBe(404);
  });

  it("imports a report: one customer per person, card numbers removed, nothing personal in the journal", async () => {
    const first = await importReport(report([
      line("1001", "CHALET 12", "2025-07-10", "2025-07-12", ALICE),
      // Same mobile, same family name, another e-mail: still Alice.
      line("1002", "CHALET 12", "2026-07-10", "2026-07-12", { Nom: "Exemple", Prénom: "Alice", Courriel: "alice@ailleurs.example", Cellulaire: "514 555 0101" }),
      // Same e-mail as Alice but another person (a shared front-desk address): someone else.
      line("1003", "104", "2026-06-05", "2026-06-07", { Nom: "Fictif", Prénom: "Bruno", Courriel: "alice.exemple@example.com" }),
      // A card number typed into the first-name field.
      line("1004", "CABANA 7", "2025-08-01", "2025-08-02", { Nom: "Témoin", Prénom: "Chloé 4111 1111 1111 1111", Courriel: "chloe@example.com" }),
    ]), "2026-06-01");
    expect(first.import).toMatchObject({ rows: 4, customersCreated: 3, customersMatched: 1, bookingsCreated: 4, cardNumbersRemoved: 1 });
    expect(first.complete).toEqual({ cancelled: 0 });

    const alice = await find("Alice Exemple");
    expect(alice).toMatchObject({ firstName: "Alice", lastName: "Exemple", email: "alice@ailleurs.example", mobilePhone: "5145550101", postalCode: "J0E 2L2", region: "QC", country: "CA", city: "Maricourt" });
    // The last e-mail seen wins; Bruno, who shares her old one, stays apart.
    expect(alice.bookings).toHaveLength(2);
    expect((await find("alice.exemple@example")).firstName).toBe("Bruno");
    const chloe = await find("chloe@example.com");
    expect(chloe.firstName).toBe("Chloé");
    const { rows } = await db.pool.query(`SELECT data::text FROM public.ticketing_audit_log WHERE action LIKE 'customers.%'`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.data).not.toMatch(/example|Exemple|5145550101/);
  });

  it("counts visits (a stay extended or on two sites is one visit) and colours customers by frequency", async () => {
    const stays = [
      ["2401", "2024-07-01", "2024-07-03"], ["2402", "2024-07-03", "2024-07-05"], // extended: one visit
      ["2403", "2024-08-10", "2024-08-12"], ["2404", "2024-08-10", "2024-08-12"], // two sites at once: one visit
      ["2501", "2025-07-01", "2025-07-02"], ["2502", "2025-08-01", "2025-08-02"], ["2601", "2026-06-01", "2026-06-03"],
    ];
    await importReport(report(stays.map(([n, a, d]) => line(n!, "CHALET 5", a!, d!, { Nom: "Fidèle", Prénom: "Denis", Courriel: "denis@example.com" }))), "2026-06-02", false);
    const denis = await find("denis@example.com");
    expect(denis).toMatchObject({ visits: 5, stays: 7, segment: "loyal", status: "active", favoriteCategory: "chalet", firstVisitOn: "2024-07-01", lastVisitOn: "2026-06-01" });
    expect(denis.spentCents).toBe(7 * 25000);

    const body = await list();
    expect(body.summary.segments).toMatchObject({ loyal: 1, one_time: 3, upcoming: 0 });
    // Bruno arrived on 2026-06-05: done, since today is 2026-06-25.
    expect((await find("Bruno")).segment).toBe("one_time");
    // Alice: one visit made (2025), one ahead; Chloé's last visit was in 2025.
    expect(await find("alice@ailleurs")).toMatchObject({ visits: 1, upcoming: 1, nextArrivalOn: "2026-07-10", status: "active" });
    expect((await find("chloe@")).status).toBe("lapsed");
    expect(body.customers[0].firstName).toBe("Denis"); // most visits first
    const loyal = await list("?segment=loyal");
    expect(loyal.customers.map((c: { firstName: string }) => c.firstName)).toEqual(["Denis"]);
    expect(loyal.total).toBe(1);
  });

  it("takes a booking a complete report no longer lists for cancelled, and brings it back if it returns", async () => {
    const later = await importReport(report([line("1003", "104", "2026-06-05", "2026-06-07", { Nom: "Fictif", Prénom: "Bruno", Courriel: "alice.exemple@example.com" })]), "2026-06-20");
    // Alice's 2026-07-10 chalet is gone from the report while still ahead: cancelled.
    // Bruno's stay and Denis's (other dates, already past) are not touched.
    expect(later.complete).toEqual({ cancelled: 1 });
    const alice = await find("alice@ailleurs");
    expect(alice).toMatchObject({ upcoming: 0, cancelled: 1, visits: 1, segment: "one_time" });
    expect(alice.bookings.find((b: { sourceRef: string }) => b.sourceRef === "1002")).toMatchObject({ state: "cancelled", cancelledOn: "2026-06-20" });

    // An older report coming in late changes nothing it should not: Alice keeps her newer details.
    await importReport(report([line("1002", "CHALET 12", "2026-07-10", "2026-07-12", { ...ALICE, Courriel: "vieille@example.com" })]), "2026-05-15", false);
    expect((await find("alice@ailleurs")).email).toBe("alice@ailleurs.example");

    // A newer report lists it again: booked after all.
    await importReport(report([line("1002", "CHALET 12", "2026-07-10", "2026-07-12", { Nom: "Exemple", Prénom: "Alice", Cellulaire: "5145550101" })]), "2026-06-24", false);
    expect(await find("alice@ailleurs")).toMatchObject({ upcoming: 1, cancelled: 0 });
  });

  it("refuses a completion with nothing imported that day, and a report from the future", async () => {
    const token = await owner();
    expect((await call(app, "POST", `${base()}/customers/import/complete`, { token, body: { reportDate: "2026-06-10" } })).body.error.code).toBe("import_empty");
    const rows = parseReservationsReport(report([line("7001", "104", "2026-07-01", "2026-07-02")])).rows;
    const future = await call(app, "POST", `${base()}/customers/import`, { token, body: { reportDate: "2026-07-01", rows } });
    expect(future.status).toBe(422);
    expect(future.body.error.code).toBe("report_date_in_future");
    // Unknown fields (a comment, a card) are not part of the contract: dropped, never stored.
    const sneaky = await call(app, "POST", `${base()}/customers/import`, { token, body: { reportDate: "2026-06-25", rows: [{ ...rows[0], comments: "4111111111111111", cardNumber: "4111111111111111" }] } });
    expect(sneaky.status).toBe(200);
    const { rows: stored } = await db.pool.query(`SELECT row_to_json(b)::text AS j FROM public.ticketing_customer_bookings b WHERE source_ref = '7001'`);
    expect(stored[0].j).not.toContain("4111");
  });

  it("says who may receive e-mail: implied for 2 years after booking, express, or opted out", async () => {
    const chloe = await find("chloe@");
    // Booked by 2026-06-01 (first report listing it): implied consent until 2028-05-31.
    expect(chloe).toMatchObject({ emailPermission: "implied", impliedConsentUntil: "2028-05-31" });
    const token = await owner();
    const out = await call(app, "PATCH", `${base()}/customers/${chloe.id}`, { token, body: { emailOptOut: true } });
    expect(out.body.customer.emailPermission).toBe("opted_out");
    const back = await call(app, "PATCH", `${base()}/customers/${chloe.id}`, { token, body: { emailConsent: true } });
    expect(back.body.customer.emailPermission).toBe("express");
    expect((await list("?emailable=true")).customers.some((c: { id: string }) => c.id === chloe.id)).toBe(true);
  });

  it("exports the file as a CSV spreadsheets read, and records who did it", async () => {
    const res = await app.request(`${base()}/customers.csv?segment=loyal`, { headers: { authorization: `Bearer ${await owner()}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("alkao-clients-2026-06-25.csv");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const [head, ...lines] = new TextDecoder().decode(bytes).trim().split("\r\n");
    expect(head).toMatch(/^id,segment,status,visits,/);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("denis@example.com");
    const { rows } = await db.pool.query(`SELECT data FROM public.ticketing_audit_log WHERE action = 'customers.exported'`);
    expect(rows[0].data).toMatchObject({ rows: 1, segment: "loyal" });
  });

  it("anonymizes a customer on request (Law 25): details gone, visits kept, never matched again", async () => {
    const denis = await find("denis@example.com");
    const token = await owner();
    expect((await call(app, "POST", `${base()}/customers/${denis.id}/anonymize`, { token: await tokenFor(seed.users.havanaStaff) })).status).toBe(403);
    const res = await call(app, "POST", `${base()}/customers/${denis.id}/anonymize`, { token });
    expect(res.body).toMatchObject({ alreadyDone: false });
    const after = (await call(app, "GET", `${base()}/customers/${denis.id}`, { token })).body.customer;
    expect(after).toMatchObject({ firstName: null, lastName: null, email: null, mobilePhone: null, postalCode: null, visits: 5, segment: "loyal" });
    expect(after.anonymizedAt).not.toBeNull();
    // The same person booking again starts a new customer record.
    const again = await importReport(report([line("2701", "CHALET 5", "2026-06-10", "2026-06-11", { Nom: "Fidèle", Prénom: "Denis", Courriel: "denis@example.com" })]), "2026-06-25", false);
    expect(again.import.customersCreated).toBe(1);
    expect((await call(app, "POST", `${base()}/customers/${denis.id}/anonymize`, { token })).body.alreadyDone).toBe(true);
    // Not in the export any more.
    const csv = await (await app.request(`${base()}/customers.csv`, { headers: { authorization: `Bearer ${token}` } })).text();
    expect(csv.split("\r\n").filter((l) => l.startsWith(denis.id))).toEqual([]);
  });
});
