/**
 * Run 41: the customer file (CRM). Pure rules: how contact details are cleaned, how a
 * returning customer is recognised, what a booking is (lodging family), and the guard that
 * keeps payment-card numbers out of the file.
 */

/** Accents, case, spaces and punctuation do not matter when comparing names. */
export function fold(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Spaces collapsed; a name typed all in capitals or all in lower case gets capitals per word. */
export function tidyText(value: string | null | undefined, max: number): string | null {
  let s = (value ?? "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  const letters = s.replace(/[^\p{L}]/gu, "");
  if (letters && (letters === letters.toUpperCase() || letters === letters.toLowerCase())) {
    s = s.toLowerCase().replace(/(^|[\s\-'’])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
  }
  return s.slice(0, max);
}

/** Front-desk placeholders: the whole part before the @ is one of these (never "nathalie@", "nora@"). */
const PLACEHOLDER_LOCAL = /^(no|non|na|n\/a|aucun|aucune|none|pas|pasde|noemail|nomail|test|x+|0+)$/;

/** A usable e-mail address in lower case, or null (missing, malformed or a placeholder). */
export function normalizeEmail(value: string | null | undefined): string | null {
  const e = (value ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (e.length > 320 || !/^[^@\s;,]+@[^@\s;,]+\.[a-z]{2,}$/.test(e) || PLACEHOLDER_LOCAL.test(e.split("@")[0]!)) return null;
  return e;
}

/** Digits only; North American numbers lose their leading 1; placeholders (000…, 555-5555) are dropped. */
export function normalizePhone(value: string | null | undefined): string | null {
  let d = (value ?? "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length < 10 || d.length > 15 || new Set(d).size <= 2) return null;
  if (d.length === 10 && /^(0000000|1111111|5555555|1234567)$/.test(d.slice(3))) return null;
  return d;
}

const COUNTRIES: Record<string, string> = {
  ca: "CA", can: "CA", canada: "CA", cad: "CA", qc: "CA", quebec: "CA",
  fr: "FR", france: "FR", us: "US", usa: "US", etatsunis: "US", unitedstates: "US",
  be: "BE", belgique: "BE", ch: "CH", suisse: "CH", mx: "MX", mexique: "MX",
};
const REGIONS: Record<string, string> = {
  qc: "QC", que: "QC", quebec: "QC", on: "ON", ont: "ON", ontario: "ON", nb: "NB", nouveaubrunswick: "NB", newbrunswick: "NB",
  ns: "NS", nouvelleecosse: "NS", novascotia: "NS", pe: "PE", nl: "NL", mb: "MB", manitoba: "MB", sk: "SK",
  saskatchewan: "SK", ab: "AB", alberta: "AB", bc: "BC", colombiebritannique: "BC", britishcolumbia: "BC",
};

export function normalizeRegion(value: string | null | undefined): string | null {
  const f = fold(value);
  return f ? (REGIONS[f] ?? tidyText(value, 60)) : null;
}

/** ISO 3166 alpha-2. Empty but with a Canadian province: Canada. */
export function normalizeCountry(value: string | null | undefined, region: string | null): string | null {
  const f = fold(value);
  if (!f) return region && Object.values(REGIONS).includes(region) ? "CA" : null;
  const known = COUNTRIES[f];
  if (known) return known;
  const raw = (value ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(raw) ? raw : null;
}

/** Canadian codes as "A1A 1A1"; other countries as typed (upper case). */
export function normalizePostalCode(value: string | null | undefined, country: string | null): string | null {
  const compact = (value ?? "").toUpperCase().replace(/[\s-]/g, "");
  if (/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(compact)) return `${compact.slice(0, 3)} ${compact.slice(3)}`;
  if (!compact || country === "CA" || country === null) return null;
  return compact.slice(0, 20);
}

/** Luhn checksum, as card numbers carry it. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

const CARD_LIKE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;

/**
 * Removes anything that looks like a payment-card number (13 to 19 digits, spaces or dashes
 * allowed, valid Luhn checksum). The customer file never stores one, whatever field it was
 * typed in.
 */
export function scrubCardNumbers(value: string): { text: string; removed: number } {
  let removed = 0;
  const text = value.replace(CARD_LIKE, (m) => {
    if (!luhnValid(m.replace(/\D/g, ""))) return m;
    removed++;
    return "";
  });
  return { text: removed ? text.replace(/\s+/g, " ").trim() : text, removed };
}

/** Lodging families, and (Run 43) "ticket": an ALKAO ticket order (a day pass, an evening). */
export const BOOKING_CATEGORIES = ["camping", "cabana", "chalet", "condo", "villa", "tent", "coolbox", "ticket", "other"] as const;
export type BookingCategory = (typeof BOOKING_CATEGORIES)[number];

/** The lodging family of a Réservation camping.ca site name ("CHALET 12", "Condo 3 Amarillo", "104"…). */
export function bookingCategory(site: string | null | undefined): BookingCategory {
  const s = (site ?? "").trim().toUpperCase();
  if (s.startsWith("CONDO")) return "condo";
  if (s.startsWith("CABANA")) return "cabana";
  if (s.startsWith("CHA")) return "chalet";
  if (s.startsWith("VILLA")) return "villa";
  if (s.startsWith("TENTE")) return "tent";
  if (s.startsWith("COOL")) return "coolbox";
  if (s.includes("BACKUP")) return "other";
  if (/^\d+[A-Z]?$/.test(s) || s.startsWith("TER")) return "camping";
  return "other";
}

export interface PersonKey {
  firstName: string | null;
  lastName: string | null;
}

/**
 * The same person: the same family name, or the same first name (a name changed or mistyped).
 * Used on top of a shared e-mail or phone, so a front-desk placeholder or a shared family
 * address never merges different people.
 */
export function samePerson(a: PersonKey, b: PersonKey): boolean {
  const [al, bl, af, bf] = [fold(a.lastName), fold(b.lastName), fold(a.firstName), fold(b.firstName)];
  if (!al && !af) return true; // nothing to compare: the contact alone decides
  return Boolean((al && al === bl) || (af && af === bf));
}

/** Segments, from most to least frequent. Thresholds count visits already made. */
export const CUSTOMER_SEGMENTS = ["loyal", "regular", "occasional", "one_time", "upcoming", "cancelled", "prospect"] as const;
export type CustomerSegment = (typeof CUSTOMER_SEGMENTS)[number];
export const CUSTOMER_STATUSES = ["active", "lapsed", "inactive"] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

/** Implied consent to e-mail after a purchase, under Canada's anti-spam law (CASL): 2 years. */
export const IMPLIED_CONSENT_DAYS = 730;

/** Calendar date (YYYY-MM-DD) in a time zone. */
export function localDate(at: Date, timeZone = "America/Toronto"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
