import {
  bookingCategory, CUSTOMER_SEGMENTS, CUSTOMER_STATUSES, fold, IMPLIED_CONSENT_DAYS, normalizeCountry, normalizeEmail, normalizePhone, normalizePostalCode,
  normalizeRegion, samePerson, scrubCardNumbers, tidyText, type BookingCategory, type CustomerSegment, type CustomerStatus,
} from "../domain/customers.js";
import { DomainError } from "../domain/errors.js";
import { toApi, writeAudit } from "./catalog.js";
import type { TenantScope } from "./commerce.js";
import { mapDbErrors } from "./errors.js";
import type { Db, Tx } from "./pool.js";

/**
 * Run 41: the customer file (CRM). Customers and their bookings, imported from an outside
 * system's reports; visits, segments and e-mail permission are computed when read, so they
 * are never stale. Server-only tables (see the migration).
 */
type Queryable = Db | Tx;
type Actor = { type: "user" | "system"; id: string | null };

export interface ImportRow {
  sourceRef: string;
  item?: string | null | undefined;
  startsOn: string;
  endsOn: string;
  adults?: number | undefined;
  children?: number | undefined;
  pets?: number | undefined;
  groupBooking?: boolean | undefined;
  checkedIn?: boolean | undefined;
  totalCents?: number | undefined;
  firstName?: string | null | undefined;
  lastName?: string | null | undefined;
  companionName?: string | null | undefined;
  email?: string | null | undefined;
  mobilePhone?: string | null | undefined;
  homePhone?: string | null | undefined;
  workPhone?: string | null | undefined;
  addressLine?: string | null | undefined;
  addressUnit?: string | null | undefined;
  city?: string | null | undefined;
  region?: string | null | undefined;
  postalCode?: string | null | undefined;
  country?: string | null | undefined;
  // Run 43, set by ALKAO itself (ticket orders), never by the import API:
  /** The lodging family, instead of guessing it from `item`. */
  category?: BookingCategory | undefined;
  /** The day it was booked (paid), instead of the report's date. */
  bookedOn?: string | undefined;
  /** The day it was cancelled (refunded, session cancelled); absent means booked. */
  cancelledOn?: string | null | undefined;
}

export interface ImportResult {
  rows: number;
  customersCreated: number;
  customersMatched: number;
  bookingsCreated: number;
  bookingsUpdated: number;
  cardNumbersRemoved: number;
}

interface Contact {
  first_name: string | null;
  last_name: string | null;
  companion_name: string | null;
  email: string | null;
  mobile_phone: string | null;
  home_phone: string | null;
  work_phone: string | null;
  address_line: string | null;
  address_unit: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
}
const CONTACT_COLUMNS = ["first_name", "last_name", "companion_name", "email", "mobile_phone", "home_phone", "work_phone",
  "address_line", "address_unit", "city", "region", "postal_code", "country"] as const;

/** Cleaned contact details; every text field loses anything that looks like a card number. */
function contactOf(row: ImportRow, scrubbed: { removed: number }): Contact {
  const clean = (value: string | null | undefined, max: number) => {
    const { text, removed } = scrubCardNumbers(value ?? "");
    scrubbed.removed += removed;
    return tidyText(text, max);
  };
  const region = normalizeRegion(clean(row.region, 60));
  const country = normalizeCountry(clean(row.country, 60), region);
  return {
    first_name: clean(row.firstName, 120),
    last_name: clean(row.lastName, 120),
    companion_name: clean(row.companionName, 200),
    email: normalizeEmail(row.email),
    mobile_phone: normalizePhone(row.mobilePhone),
    home_phone: normalizePhone(row.homePhone),
    work_phone: normalizePhone(row.workPhone),
    address_line: clean(row.addressLine, 200),
    address_unit: clean(row.addressUnit, 40),
    city: clean(row.city, 120),
    region,
    postal_code: normalizePostalCode(row.postalCode, country),
    country,
  };
}

/**
 * A returning customer: the same e-mail or phone and the same person (family or first name),
 * else the same full name and postal code. The oldest such customer wins.
 */
async function findCustomer(tx: Tx, s: TenantScope, c: Contact): Promise<string | null> {
  const phones = [c.mobile_phone, c.home_phone].filter((p): p is string => Boolean(p));
  if (!c.email && phones.length === 0 && !c.postal_code) return null;
  const { rows } = await tx.query<{ id: string; first_name: string | null; last_name: string | null; email: string | null; mobile_phone: string | null; home_phone: string | null; postal_code: string | null }>(
    `SELECT id, first_name, last_name, email, mobile_phone, home_phone, postal_code
     FROM public.ticketing_customers
     WHERE client_id = $1 AND brand_id = $2 AND anonymized_at IS NULL
       AND (email = $3 OR mobile_phone = ANY($4::text[]) OR home_phone = ANY($4::text[]) OR postal_code = $5)
     ORDER BY created_at, id
     LIMIT 500`,
    [s.clientId, s.brandId, c.email, phones, c.postal_code],
  );
  const person = { firstName: c.first_name, lastName: c.last_name };
  const byContact = rows.find((r) =>
    ((c.email && r.email === c.email) || phones.some((p) => p === r.mobile_phone || p === r.home_phone))
    && samePerson(person, { firstName: r.first_name, lastName: r.last_name }));
  if (byContact) return byContact.id;
  const byName = rows.find((r) => c.postal_code && r.postal_code === c.postal_code
    && fold(c.last_name) && fold(r.last_name) === fold(c.last_name) && fold(c.first_name) && fold(r.first_name) === fold(c.first_name));
  return byName?.id ?? null;
}

/**
 * One batch of a report's rows. A booking already known keeps its customer; a newer report
 * updates it (and brings back a booking taken for cancelled), an older one only moves its
 * first-seen date back. Contact details follow the newest report that has them.
 */
export async function importRows(
  tx: Tx, s: TenantScope, input: { source: string; reportDate: string; rows: ImportRow[] }, actor: Actor,
): Promise<ImportResult> {
  return mapDbErrors(async () => {
    const result: ImportResult = { rows: input.rows.length, customersCreated: 0, customersMatched: 0, bookingsCreated: 0, bookingsUpdated: 0, cardNumbersRemoved: 0 };
    const scrubbed = { removed: 0 };
    for (const row of input.rows) {
      const contact = contactOf(row, scrubbed);
      const item = tidyText(scrubCardNumbers(row.item ?? "").text, 80);
      const { rows: known } = await tx.query<{ id: string; customer_id: string; last_report_on: string }>(
        `SELECT id, customer_id, last_report_on::text FROM public.ticketing_customer_bookings
         WHERE client_id = $1 AND brand_id = $2 AND source = $3 AND source_ref = $4 FOR UPDATE`,
        [s.clientId, s.brandId, input.source, row.sourceRef],
      );
      let customerId = known[0]?.customer_id ?? (await findCustomer(tx, s, contact));
      if (customerId) {
        result.customersMatched++;
        // Newer details win; a blank field never erases a known one.
        await tx.query(
          `UPDATE public.ticketing_customers SET ${CONTACT_COLUMNS.map((col, i) => `${col} = COALESCE($${i + 5}, ${col})`).join(", ")}, contact_as_of = $4
           WHERE id = $1 AND client_id = $2 AND brand_id = $3 AND anonymized_at IS NULL AND (contact_as_of IS NULL OR contact_as_of <= $4)`,
          [customerId, s.clientId, s.brandId, input.reportDate, ...CONTACT_COLUMNS.map((col) => contact[col])],
        );
      } else {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO public.ticketing_customers (client_id, brand_id, contact_as_of, ${CONTACT_COLUMNS.join(", ")})
           VALUES ($1, $2, $3, ${CONTACT_COLUMNS.map((_, i) => `$${i + 4}`).join(", ")}) RETURNING id`,
          [s.clientId, s.brandId, input.reportDate, ...CONTACT_COLUMNS.map((col) => contact[col])],
        );
        customerId = rows[0]!.id;
        result.customersCreated++;
      }
      const booking = [row.category ?? bookingCategory(item), item, row.startsOn, row.endsOn, row.adults ?? 0, row.children ?? 0, row.pets ?? 0,
        row.groupBooking ?? false, row.checkedIn ?? false, row.totalCents ?? 0];
      const bookedOn = row.bookedOn && row.bookedOn < input.reportDate ? row.bookedOn : input.reportDate;
      if (!known[0]) {
        await tx.query(
          `INSERT INTO public.ticketing_customer_bookings
             (client_id, brand_id, customer_id, source, source_ref, category, item, starts_on, ends_on, adults, children, pets,
              group_booking, checked_in, total_cents, first_report_on, last_report_on, cancelled_on)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
          [s.clientId, s.brandId, customerId, input.source, row.sourceRef, ...booking, bookedOn, input.reportDate, row.cancelledOn ?? null],
        );
        result.bookingsCreated++;
      } else if (known[0].last_report_on <= input.reportDate) {
        await tx.query(
          `UPDATE public.ticketing_customer_bookings
           SET category = $2, item = $3, starts_on = $4, ends_on = $5, adults = $6, children = $7, pets = $8, group_booking = $9,
               checked_in = checked_in OR $10, total_cents = $11, last_report_on = $12, cancelled_on = $13::date,
               first_report_on = LEAST(first_report_on, $14::date)
           WHERE id = $1`,
          [known[0].id, ...booking, input.reportDate, row.cancelledOn ?? null, bookedOn],
        );
        result.bookingsUpdated++;
      } else {
        await tx.query(`UPDATE public.ticketing_customer_bookings SET first_report_on = LEAST(first_report_on, $2) WHERE id = $1`, [known[0].id, bookedOn]);
        result.bookingsUpdated++;
      }
    }
    result.cardNumbersRemoved = scrubbed.removed;
    // No personal data in the journal: counts only.
    await writeAudit(tx, s, actor, "customers.imported", { type: "customer_import", id: null }, { source: input.source, reportDate: input.reportDate, ...result });
    return result;
  });
}

/**
 * The report is complete (every upcoming booking is in it): a booking it no longer lists,
 * whose arrival was still ahead on the report's date, was cancelled. Refused if nothing was
 * imported for that date, so a mistaken call cannot cancel everything.
 */
export async function completeImport(tx: Tx, s: TenantScope, input: { source: string; reportDate: string }, actor: Actor) {
  const { rowCount: listed } = await tx.query(
    `SELECT 1 FROM public.ticketing_customer_bookings WHERE client_id = $1 AND brand_id = $2 AND source = $3 AND last_report_on = $4 LIMIT 1`,
    [s.clientId, s.brandId, input.source, input.reportDate],
  );
  if (!listed) throw new DomainError("import_empty");
  const { rowCount } = await tx.query(
    `UPDATE public.ticketing_customer_bookings SET cancelled_on = $4
     WHERE client_id = $1 AND brand_id = $2 AND source = $3 AND cancelled_on IS NULL AND NOT checked_in
       AND last_report_on < $4 AND starts_on > $4`,
    [s.clientId, s.brandId, input.source, input.reportDate],
  );
  await writeAudit(tx, s, actor, "customers.import_completed", { type: "customer_import", id: null }, { source: input.source, reportDate: input.reportDate, cancelled: rowCount ?? 0 });
  return { cancelled: rowCount ?? 0 };
}

// ── Reading ─────────────────────────────────────────────────────────────────
/**
 * Per-customer figures for one tenant ($1 client, $2 brand, $3 today as a date), as the CTE `stats`.
 * A visit is one stay: bookings that overlap or follow each other (several sites, a stay
 * extended) count once. Segments count visits already made; the status follows the year of
 * the latest visit or upcoming arrival.
 */
export const CUSTOMER_STATS = `
  bookings AS (
    SELECT b.*, CASE WHEN b.cancelled_on IS NOT NULL THEN 'cancelled' WHEN b.starts_on <= $3::date THEN 'done' ELSE 'upcoming' END AS state
    FROM public.ticketing_customer_bookings b WHERE b.client_id = $1 AND b.brand_id = $2
  ),
  done AS (
    SELECT customer_id, starts_on, ends_on, total_cents, category,
           max(ends_on) OVER (PARTITION BY customer_id ORDER BY starts_on, ends_on ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_end
    FROM bookings WHERE state = 'done'
  ),
  done_stats AS (
    SELECT customer_id, count(*) FILTER (WHERE prev_end IS NULL OR starts_on > prev_end)::int AS visits, count(*)::int AS stays,
           min(starts_on) AS first_visit_on, max(starts_on) AS last_visit_on, sum(total_cents)::bigint AS spent_cents,
           mode() WITHIN GROUP (ORDER BY category) AS favorite_category
    FROM done GROUP BY customer_id
  ),
  other_stats AS (
    SELECT customer_id, count(*) FILTER (WHERE state = 'upcoming')::int AS upcoming, count(*) FILTER (WHERE state = 'cancelled')::int AS cancelled,
           min(starts_on) FILTER (WHERE state = 'upcoming') AS next_arrival_on,
           max(first_report_on) FILTER (WHERE state <> 'cancelled') AS last_booked_on
    FROM bookings GROUP BY customer_id
  ),
  stats AS (
    SELECT c.id, c.first_name, c.last_name, c.email, c.mobile_phone, c.home_phone, c.work_phone, c.address_line, c.address_unit,
           c.city, c.region, c.postal_code, c.country, c.companion_name, c.email_consent_at, c.email_opt_out_at, c.sms_opt_out_at,
           c.anonymized_at, c.created_at,
           COALESCE(d.visits, 0) AS visits, COALESCE(d.stays, 0) AS stays, d.first_visit_on, d.last_visit_on,
           COALESCE(d.spent_cents, 0) AS spent_cents, COALESCE(d.favorite_category, (SELECT b.category FROM bookings b WHERE b.customer_id = c.id AND b.state = 'upcoming' ORDER BY b.starts_on LIMIT 1)) AS favorite_category,
           COALESCE(o.upcoming, 0) AS upcoming, COALESCE(o.cancelled, 0) AS cancelled, o.next_arrival_on,
           CASE WHEN COALESCE(d.visits, 0) >= 5 THEN 'loyal' WHEN d.visits >= 3 THEN 'regular' WHEN d.visits = 2 THEN 'occasional'
                WHEN d.visits = 1 THEN 'one_time' WHEN COALESCE(o.upcoming, 0) > 0 THEN 'upcoming'
                WHEN COALESCE(o.cancelled, 0) > 0 THEN 'cancelled' ELSE 'prospect' END AS segment,
           CASE WHEN GREATEST(d.last_visit_on, o.next_arrival_on) IS NULL THEN NULL
                WHEN extract(year FROM GREATEST(d.last_visit_on, o.next_arrival_on)) >= extract(year FROM $3::date) THEN 'active'
                WHEN extract(year FROM GREATEST(d.last_visit_on, o.next_arrival_on)) = extract(year FROM $3::date) - 1 THEN 'lapsed'
                ELSE 'inactive' END AS status,
           CASE WHEN c.email IS NULL THEN 'none'
                WHEN c.email_opt_out_at IS NOT NULL AND (c.email_consent_at IS NULL OR c.email_opt_out_at >= c.email_consent_at) THEN 'opted_out'
                WHEN c.email_consent_at IS NOT NULL THEN 'express'
                WHEN o.last_booked_on + ${IMPLIED_CONSENT_DAYS} >= $3::date THEN 'implied'
                ELSE 'expired' END AS email_permission,
           o.last_booked_on + ${IMPLIED_CONSENT_DAYS} AS implied_consent_until
    FROM public.ticketing_customers c
    LEFT JOIN done_stats d ON d.customer_id = c.id
    LEFT JOIN other_stats o ON o.customer_id = c.id
    WHERE c.client_id = $1 AND c.brand_id = $2
  )`;

const LIST_COLUMNS = `id, first_name, last_name, email, mobile_phone, city, region, segment, status, visits, stays, upcoming, cancelled,
  first_visit_on::text, last_visit_on::text, next_arrival_on::text, spent_cents, favorite_category, email_permission,
  implied_consent_until::text, anonymized_at`;

export interface CustomerFilters {
  segment?: CustomerSegment | undefined;
  status?: CustomerStatus | undefined;
  q?: string | undefined;
  emailable?: boolean | undefined;
}

function where(f: CustomerFilters, params: unknown[], extra: string[] = []) {
  const parts = [...extra];
  if (f.segment) { params.push(f.segment); parts.push(`segment = $${params.length}`); }
  if (f.status) { params.push(f.status); parts.push(`status = $${params.length}`); }
  if (f.emailable) parts.push(`email_permission IN ('express', 'implied')`);
  if (f.q) {
    // Part of the name, the start of the e-mail, or 4+ digits of a phone number.
    const like = f.q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    params.push(`%${like}%`);
    const ors = [`concat_ws(' ', first_name, last_name) ILIKE $${params.length}`];
    params.push(`${like.toLowerCase()}%`);
    ors.push(`email LIKE $${params.length}`);
    const digits = f.q.replace(/\D/g, "");
    if (digits.length >= 4) {
      params.push(`%${digits}%`);
      ors.push(`mobile_phone LIKE $${params.length}`, `home_phone LIKE $${params.length}`);
    }
    parts.push(`(${ors.join(" OR ")})`);
  }
  return parts.length ? `WHERE ${parts.join(" AND ")}` : "";
}

const ORDER = `ORDER BY visits DESC, spent_cents DESC, lower(last_name) NULLS LAST, lower(first_name) NULLS LAST, id`;

export async function listCustomers(db: Db, s: TenantScope, today: string, f: CustomerFilters & { limit: number; offset: number }) {
  const params: unknown[] = [s.clientId, s.brandId, today];
  const filter = where(f, params);
  const [page, count, totals] = await Promise.all([
    db.query(`WITH ${CUSTOMER_STATS} SELECT ${LIST_COLUMNS} FROM stats ${filter} ${ORDER} LIMIT ${f.limit} OFFSET ${f.offset}`, params),
    db.query<{ n: number }>(`WITH ${CUSTOMER_STATS} SELECT count(*)::int AS n FROM stats ${filter}`, params),
    db.query<{ segment: string; status: string | null; n: number; emailable: number }>(
      `WITH ${CUSTOMER_STATS} SELECT segment, status, count(*)::int AS n, count(*) FILTER (WHERE email_permission IN ('express', 'implied'))::int AS emailable
       FROM stats GROUP BY segment, status`,
      [s.clientId, s.brandId, today],
    ),
  ]);
  const segments: Record<string, number> = Object.fromEntries(CUSTOMER_SEGMENTS.map((k) => [k, 0]));
  const statuses: Record<string, number> = Object.fromEntries(CUSTOMER_STATUSES.map((k) => [k, 0]));
  let all = 0;
  let emailable = 0;
  for (const r of totals.rows) {
    segments[r.segment] = (segments[r.segment] ?? 0) + r.n;
    if (r.status) statuses[r.status] = (statuses[r.status] ?? 0) + r.n;
    all += r.n;
    emailable += r.emailable;
  }
  return {
    customers: page.rows.map(toApi),
    total: count.rows[0]?.n ?? 0,
    summary: { customers: all, emailable, segments, statuses },
  };
}

export async function getCustomer(db: Db, s: TenantScope, id: string, today: string) {
  const [customer, bookings] = await Promise.all([
    db.query(
      `WITH ${CUSTOMER_STATS} SELECT ${LIST_COLUMNS}, home_phone, work_phone, address_line, address_unit, postal_code, country, companion_name,
              email_consent_at, email_opt_out_at, sms_opt_out_at, created_at
       FROM stats WHERE id = $4`,
      [s.clientId, s.brandId, today, id],
    ),
    db.query(
      `SELECT id, source, source_ref, category, item, starts_on::text, ends_on::text, adults, children, pets, group_booking, checked_in,
              total_cents, first_report_on::text, last_report_on::text, cancelled_on::text,
              CASE WHEN cancelled_on IS NOT NULL THEN 'cancelled' WHEN starts_on <= $4::date THEN 'done' ELSE 'upcoming' END AS state
       FROM public.ticketing_customer_bookings WHERE customer_id = $1 AND client_id = $2 AND brand_id = $3
       ORDER BY starts_on DESC, source_ref`,
      [id, s.clientId, s.brandId, today],
    ),
  ]);
  if (!customer.rows[0]) throw new DomainError("customer_not_found");
  return { ...toApi(customer.rows[0]), bookings: bookings.rows.map(toApi) };
}

/** Every customer matching the filters, for a CSV (marketing list, accountant, TAKATAK). */
export async function exportCustomers(db: Db, s: TenantScope, today: string, f: CustomerFilters) {
  const params: unknown[] = [s.clientId, s.brandId, today];
  const { rows } = await db.query(
    `WITH ${CUSTOMER_STATS} SELECT ${LIST_COLUMNS}, home_phone, work_phone, address_line, address_unit, postal_code, country, companion_name
     FROM stats ${where(f, params, ["anonymized_at IS NULL"])} ${ORDER} LIMIT 200000`,
    params,
  );
  return rows as Record<string, unknown>[];
}

// ── Staff changes ───────────────────────────────────────────────────────────
/** Consent and opt-outs, as the customer asked (newsletter sign-up, "unsubscribe", STOP). */
export async function updateCustomer(
  tx: Tx, s: TenantScope, id: string, p: { emailConsent?: boolean | undefined; emailOptOut?: boolean | undefined; smsOptOut?: boolean | undefined }, actor: Actor, now: Date,
) {
  const sets: string[] = [];
  const values: unknown[] = [id, s.clientId, s.brandId, now];
  if (p.emailConsent !== undefined) sets.push(p.emailConsent ? "email_consent_at = $4, email_opt_out_at = NULL" : "email_consent_at = NULL");
  if (p.emailOptOut !== undefined) sets.push(p.emailOptOut ? "email_opt_out_at = $4" : "email_opt_out_at = NULL");
  if (p.smsOptOut !== undefined) sets.push(p.smsOptOut ? "sms_opt_out_at = $4" : "sms_opt_out_at = NULL");
  if (sets.length === 0) throw new DomainError("empty_update");
  const { rowCount } = await tx.query(
    `UPDATE public.ticketing_customers SET ${sets.join(", ")} WHERE id = $1 AND client_id = $2 AND brand_id = $3 AND anonymized_at IS NULL`,
    values,
  );
  if (!rowCount) throw new DomainError("customer_not_found");
  await writeAudit(tx, s, actor, "customer.updated", { type: "customer", id }, { fields: Object.keys(p).filter((k) => p[k as keyof typeof p] !== undefined) });
}

/**
 * Québec Law 25: the customer's personal fields are wiped for good; their bookings stay
 * (dates, lodging, amounts) so visits and sales still add up, without anyone in them.
 */
export async function anonymizeCustomer(tx: Tx, s: TenantScope, id: string, actor: Actor, now: Date) {
  return mapDbErrors(async () => {
    const { rows } = await tx.query<{ anonymized_at: Date | null }>(
      `SELECT anonymized_at FROM public.ticketing_customers WHERE id = $1 AND client_id = $2 AND brand_id = $3 FOR UPDATE`,
      [id, s.clientId, s.brandId],
    );
    if (!rows[0]) throw new DomainError("customer_not_found");
    if (rows[0].anonymized_at) return { anonymizedAt: rows[0].anonymized_at.toISOString(), alreadyDone: true };
    await tx.query(
      `UPDATE public.ticketing_customers SET first_name = NULL, last_name = NULL, email = NULL, mobile_phone = NULL, home_phone = NULL,
         work_phone = NULL, address_line = NULL, address_unit = NULL, postal_code = NULL, companion_name = NULL,
         email_consent_at = NULL, anonymized_at = $4
       WHERE id = $1 AND client_id = $2 AND brand_id = $3`,
      [id, s.clientId, s.brandId, now],
    );
    await writeAudit(tx, s, actor, "customer.anonymized", { type: "customer", id });
    return { anonymizedAt: now.toISOString(), alreadyDone: false };
  });
}
