import type { Lang } from "./home-copy.js";
import type { PublicVenue } from "./venue-view.js";

/**
 * Public iCalendar feed, with no buyer/order identity or access token.
 * A venue can only reach this function through the already-gated ALKAO catalog.
 * Calendar clients may cache entries; a sold-out event disappears from subsequent
 * downloads but previously imported entries are controlled by the calendar app.
 */
const icsDate = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export const escapeCalendarText = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");

/** RFC 5545 content lines: at most 75 UTF-8 octets including the continuation space. */
export function foldCalendarLine(line: string): string {
  const lines: string[] = [];
  let part = "";
  let octets = 0;
  for (const char of line) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (octets + bytes > (lines.length ? 74 : 75)) {
      lines.push(part);
      part = "";
      octets = 0;
    }
    part += char;
    octets += bytes;
  }
  lines.push(part);
  return lines.join("\r\n ");
}

export function publicVenueCalendar(
  venue: PublicVenue,
  { origin, now, lang }: { origin: string | null; now: Date; lang: Lang },
): string {
  const title = lang === "en" ? `Events at ${venue.name}` : `Événements — ${venue.name}`;
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ALKAO//Salles//FR-CA",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeCalendarText(title)}`,
  ];
  const location = [venue.name, venue.address, venue.city].filter(Boolean).join(", ");
  for (const event of venue.events) {
    const dates = event.sessions?.length ? event.sessions : [event.startsAt];
    for (const [index, raw] of dates.entries()) {
      const starts = new Date(raw);
      if (!Number.isFinite(starts.getTime()) || starts < now) continue;
      const ends = event.ends?.[index] ? new Date(event.ends[index]!) : null;
      const validEnd = ends && Number.isFinite(ends.getTime()) && ends > starts ? ends : null;
      // Stable across refreshes. A change of start time becomes a new calendar entry.
      const uid = `${event.id}-${icsDate(starts)}@alkao.ca`;
      const shop = origin ? `${origin}${event.shopPath}` : event.shopPath;
      const details = [event.description?.slice(0, 350) ?? "", shop].filter(Boolean).join("\n");
      lines.push(
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `DTSTAMP:${icsDate(now)}`,
        `DTSTART:${icsDate(starts)}`,
        ...(validEnd ? [`DTEND:${icsDate(validEnd)}`] : []),
        `SUMMARY:${escapeCalendarText(event.title)}`,
        `LOCATION:${escapeCalendarText(location)}`,
        `DESCRIPTION:${escapeCalendarText(details)}`,
        `URL:${shop}`,
        "END:VEVENT",
      );
    }
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldCalendarLine).join("\r\n")}\r\n`;
}
