import { describe, expect, it } from "vitest";
import { escapeCalendarText, foldCalendarLine, publicVenueCalendar } from "../../src/api/venue-calendar.js";
import type { PublicVenue } from "../../src/api/venue-view.js";

const venue: PublicVenue = {
  clientId: "00000000-0000-4000-8000-000000000001",
  brandId: "00000000-0000-4000-8000-000000000002",
  venueId: "00000000-0000-4000-8000-000000000003",
  name: "Théâtre, Montréal; Sud", city: "Montréal", address: "10, rue St-Paul",
  brand: "ALKAO Test",
  events: [{
    id: "00000000-0000-4000-8000-000000000004",
    title: "Spectacle; spécial, entrée\nBEGIN:VEVENT",
    description: "Line one\r\nInjected: comma, slash\\ and semicolon;",
    imageUrl: null,
    venueId: "00000000-0000-4000-8000-000000000003",
    venueName: "Théâtre, Montréal; Sud", venueCity: "Montréal",
    startsAt: "2026-12-15T19:00:00.000Z",
    sessions: ["2026-12-15T19:00:00.000Z", "2026-12-16T19:00:00.000Z"],
    ends: ["2026-12-15T20:30:00.000Z", null],
    shopPath: "/acheter/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000004",
  }],
};
describe("Run 75: public venue iCalendar", () => {
  it("escapes untrusted event data and folds UTF-8 without splitting characters", () => {
    expect(escapeCalendarText("back\\slash;comma,\r\nnext")).toBe("back\\\\slash\\;comma\\,\\nnext");
    const line = foldCalendarLine("SUMMARY:" + "Été 🎵".repeat(40));
    for (const part of line.split("\r\n")) expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(75);
    expect(line).toContain("\r\n ");
  });

  it("produces deterministic UIDs, every on-sale session and no access token", () => {
    const now = new Date("2026-10-14T19:00:00.000Z");
    const out = publicVenueCalendar(venue, { origin: "https://alkao.ca", now, lang: "fr" });
    expect(out).toContain("BEGIN:VCALENDAR\r\nVERSION:2.0");
    expect(out.split("\r\n").filter((line) => line === "BEGIN:VEVENT")).toHaveLength(2);
    expect(out).toContain("DTSTART:20261215T190000Z");
    expect(out).toContain("DTEND:20261215T203000Z");
    expect(out).toContain("DTSTART:20261216T190000Z");
    expect(out).toContain("UID:00000000-0000-4000-8000-000000000004-20261215T190000Z@alkao.ca");
    expect(out.replace(/\r\n /g, "")).toContain("SUMMARY:Spectacle\\; spécial\\, entrée\\nBEGIN:VEVENT");
    expect(out).toContain("LOCATION:Théâtre\\, Montréal\\; Sud\\, 10\\, rue St-Paul\\, Montréal");
    expect(out).toContain("URL:https://alkao.ca/acheter/");
    expect(out).not.toContain("order-token");
    expect(out).not.toContain("BEGIN:VEVENT\r\nBEGIN:VEVENT");
    expect(out.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("omits expired or invalid dates and labels the calendar in English", () => {
    const out = publicVenueCalendar(venue, {
      origin: "https://alkao.ca", now: new Date("2026-12-15T19:01:00Z"), lang: "en",
    });
    expect(out.split("\r\n").filter((line) => line === "BEGIN:VEVENT")).toHaveLength(1);
    expect(out).toContain("DTSTART:20261216T190000Z");
    expect(out).toContain("X-WR-CALNAME:Events at");
  });
});
