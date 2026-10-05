import { describe, expect, it } from "vitest";
import { calendarFile, escapeText, fold } from "../../buyer-ui/calendar.js";

/** Run 31: the .ics file the tickets page offers ("Ajouter à mon calendrier"). */
const event = {
  orderId: "0b9f6c1e-3c1d-4b8e-9a51-2f1f6d7f0a11",
  title: "FESTI-ICE; soirée, patin\\glace",
  startsAt: "2027-01-15T23:30:00.000Z",
  endsAt: "2027-01-16T02:00:00.000Z",
  venue: { name: "Parc du Domaine", addressLine1: "1 rue des Patineurs", city: "Maricourt" },
  description: "FESTI-ICE · Commande K7Q2-9X4M.\nVos billets sont dans votre courriel de confirmation.",
};

describe("the calendar file", () => {
  it("is a valid iCalendar event, in UTC, one per order", () => {
    const ics = calendarFile(event, new Date("2026-12-01T12:00:00Z"));
    expect(ics.endsWith("\r\n")).toBe(true);
    const lines = ics.trimEnd().split("\r\n");
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines.at(-1)).toBe("END:VCALENDAR");
    expect(lines).toContain("UID:0b9f6c1e-3c1d-4b8e-9a51-2f1f6d7f0a11@alkao");
    expect(lines).toContain("DTSTAMP:20261201T120000Z");
    expect(lines).toContain("DTSTART:20270115T233000Z");
    expect(lines).toContain("DTEND:20270116T020000Z");
    expect(lines).toContain("SUMMARY:FESTI-ICE\\; soirée\\, patin\\\\glace");
    expect(lines).toContain("LOCATION:Parc du Domaine\\, 1 rue des Patineurs\\, Maricourt");
    // Every line within 75 octets once folded, and unfolding gives the text back.
    const encoder = new TextEncoder();
    expect(lines.every((l) => encoder.encode(l).length <= 75)).toBe(true);
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain("DESCRIPTION:FESTI-ICE · Commande K7Q2-9X4M.\\nVos billets sont dans votre courriel de confirmation.");
  });

  it("leaves out the end when the session has none, and never carries a link", () => {
    const ics = calendarFile({ ...event, endsAt: null, venue: { name: "Havana Resort", city: null } });
    expect(ics).not.toContain("DTEND");
    expect(ics).toContain("LOCATION:Havana Resort\r\n");
    expect(ics).not.toMatch(/https?:|billets#|k=/);
  });

  it("escapes text and folds long lines without cutting a character", () => {
    expect(escapeText("a\\b;c,d\ne")).toBe("a\\\\b\\;c\\,d\\ne");
    const long = `SUMMARY:${"é".repeat(60)}`; // 8 + 120 octets
    const folded = fold(long);
    const parts = folded.split("\r\n ");
    expect(parts.length).toBe(2);
    expect(new TextEncoder().encode(parts[0]).length).toBeLessThanOrEqual(75);
    expect(parts.join("")).toBe(long);
    expect(fold("SHORT:line")).toBe("SHORT:line");
  });
});
