// ALKAO — "Ajouter à mon calendrier" (Run 31). An iCalendar file (RFC 5545) built in the
// buyer's browser from what the tickets page already shows. It never holds the personal
// link or its token: calendars are often synced and shared.

/** UTC in the iCalendar form 20270115T233000Z. */
const stamp = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** Text values escape backslash, semicolon, comma and line breaks (RFC 5545, 3.3.11). */
export const escapeText = (s) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Lines longer than 75 octets continue on the next line after one space, never inside a character. */
export function fold(line) {
  const encoder = new TextEncoder();
  const parts = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const bytes = encoder.encode(ch).length;
    if (size + bytes > (parts.length === 0 ? 75 : 74)) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += bytes;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

/**
 * @param {{ orderId: string, title: string, startsAt: string, endsAt?: string | null,
 *   venue: { name: string, addressLine1?: string | null, city?: string | null }, description: string }} e
 * @param {Date} now
 */
export function calendarFile(e, now = new Date()) {
  const where = [e.venue.name, e.venue.addressLine1, e.venue.city].filter(Boolean).join(", ");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ALKAO//Billetterie//FR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    // One entry per order: adding it again updates it instead of doubling it.
    `UID:${e.orderId}@alkao`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(new Date(e.startsAt))}`,
    ...(e.endsAt ? [`DTEND:${stamp(new Date(e.endsAt))}`] : []),
    `SUMMARY:${escapeText(e.title)}`,
    `LOCATION:${escapeText(where)}`,
    `DESCRIPTION:${escapeText(e.description)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
