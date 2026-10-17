import { describe, expect, it } from "vitest";
import { renderVenuePage, type PublicVenue } from "../../src/api/venue-view.js";

// Run 90: the venue page's gallery, rendered from synthetic events (no database needed).
const event = (n: number, imageUrl: string | null) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`, title: `Soirée ${n} "spéciale"`, description: null, imageUrl,
  venueId: "v", venueName: "Salle Test", venueCity: "Laval", startsAt: new Date(Date.UTC(2026, 11, n, 23)),
  fromCents: n === 1 ? null : 2500, shopPath: `/acheter/c/b/${n}`,
});
const venue = (events: ReturnType<typeof event>[]): PublicVenue => ({
  clientId: "c", brandId: "b", venueId: "v", name: "Salle Test", city: "Laval", address: "1 rue Test", brand: "Org Test", events,
});
const render = (v: PublicVenue, lang: "fr" | "en" = "fr") =>
  renderVenuePage({ origin: "https://alkao.test", lang, now: new Date(Date.UTC(2026, 10, 1)), asset: (name) => `/assets/home/${name}`, venue: v });

describe("Run 90: venue page gallery", () => {
  it("lists every organizer photo in a rail that opens the viewer, and none of ALKAO's stand-ins", () => {
    const html = render(venue([event(1, "https://img.example.test/1.webp"), event(2, "https://img.example.test/2.webp"), event(3, null)]));
    expect(html).toContain('<ul class="rail shots" id="venue-gallery-rail">');
    expect(html.match(/data-zoom-group="gallery"/g)).toHaveLength(2);
    expect(html).toContain('href="https://img.example.test/2.webp" data-zoom="https://img.example.test/2.webp" data-zoom-alt="Soirée 2 &quot;spéciale&quot;"');
    expect(html).not.toContain('data-zoom="/assets/home/');
    expect(html).toContain("<h2 id=\"venue-gallery\">En images</h2>");
    // A free event is the lowest price.
    expect(html).toContain("<li><strong>Gratuit</strong><span>Entrée</span></li>");
    expect(html).toContain("<li><strong>3</strong><span>événements en vente</span></li>");
    expect(render(venue([event(1, "https://img.example.test/1.webp"), event(2, "https://img.example.test/2.webp")]), "en")).toContain("<h2 id=\"venue-gallery\">In pictures</h2>");
  });

  it("never takes a photo that is not https", () => {
    const html = render(venue([event(1, "http://img.example.test/1.webp"), event(2, "javascript:alert(1)")]));
    expect(html).not.toContain("img.example.test");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain('class="rail shots"');
  });
});
