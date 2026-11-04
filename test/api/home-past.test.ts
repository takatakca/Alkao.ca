import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adm, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 106: past events on alkao.ca. "Passés" lists the past year's events of the Brands that
 * show on alkao.ca: never sold, never in the search or search-engine data. Made-up events only.
 */
let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
let t: TenantFixture;
const ids: Record<string, string> = {};
const DAY = 86_400_000;

const page = async (qs = "") => (await app.request(`/${qs ? `?${qs}` : ""}`)).text();

async function event(tenant: TenantFixture, slug: string, title: string, status = "published") {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO public.ticketing_events (client_id, brand_id, venue_id, slug, title, status)
     SELECT client_id, brand_id, venue_id, $2, $3, $4 FROM public.ticketing_events WHERE id = $1 RETURNING id`,
    [tenant.eventId, slug, title, status],
  );
  return rows[0]!.id;
}
async function date(tenant: TenantFixture, eventId: string, daysFromNow: number, status = "on_sale") {
  await db.pool.query(
    `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
     VALUES ($1, $2, $3, now() + make_interval(days => $4), 100, $5)`,
    [tenant.clientId, tenant.brandId, eventId, daysFromNow, status],
  );
}

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  t = seed.havana;
  app = testApp(db.pool, { publicUrl: "https://alkao.test" });
  for (const tenant of [seed.havana, seed.festi]) {
    const token = await tokenFor(tenant === seed.havana ? seed.users.havanaOwner : seed.users.festiOwner);
    const r = await app.request(`${adm(tenant.clientId, tenant.brandId)}/appearance`, {
      method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ showOnAlkao: tenant === seed.havana }),
    });
    expect(r.status).toBe(200);
  }
  // Two dates, both over: the past year's Halloween.
  ids.halloween = await event(t, "halloween-test", "Halloween Havana");
  await date(t, ids.halloween, -10);
  await date(t, ids.halloween, -3, "closed");
  // Never in "Passés": a draft, a date cancelled, more than a year back, a date still to come,
  // and a Brand that does not show on alkao.ca.
  ids.draft = await event(t, "brouillon-test", "Soirée brouillon", "draft");
  await date(t, ids.draft, -5);
  ids.cancelled = await event(t, "annule-test", "Concert annulé");
  await date(t, ids.cancelled, -4, "cancelled");
  ids.old = await event(t, "ancien-test", "Carnaval d'antan");
  await date(t, ids.old, -400);
  ids.running = await event(t, "en-cours-test", "Festival en cours");
  await date(t, ids.running, -2);
  await date(t, ids.running, 20, "paused");
  ids.hidden = await event(seed.festi, "festi-passe-test", "Patin de l'an dernier");
  await date(seed.festi, ids.hidden, -6);
});
beforeEach(async () => {
  await db.pool.query(`UPDATE public.ticketing_sessions SET status = 'on_sale', starts_at = now() + interval '30 days' WHERE event_id = $1`, [t.eventId]);
});
afterAll(async () => {
  await db?.drop();
});

describe("Run 106: past events on alkao.ca", () => {
  it("offers « À venir » and « Passés » with their counts, and keeps the past out of what is on sale", async () => {
    const html = await page();
    expect(html).toMatch(/<div class="period-switch" role="group" aria-labelledby="f-period">/);
    expect(html).toMatch(/<a class="chip is-current" href="\/\?#evenements" aria-current="true">À venir<span class="count">1<\/span><\/a>/);
    expect(html).toMatch(/<a class="chip" href="\/\?periode=passes#evenements">Passés<span class="count">1<\/span><\/a>/);
    expect(html).not.toContain("Halloween Havana");
    const json = JSON.parse(html.match(/<script type="application\/json" id="alkao-data">([\s\S]*?)<\/script>/)![1]!);
    expect(json.events.map((e: { title: string }) => e.title)).toEqual([expect.not.stringContaining("Halloween")]);
    // The sitemap lists what is on sale only.
    expect(await (await app.request("/sitemap.xml")).text()).not.toContain(ids.halloween);
  });

  it("lists the past year's events, the latest first: « Terminé », their page, no price and no purchase", async () => {
    const html = await page("periode=passes");
    expect(html).toContain('<h2 id="events-title">Événements passés</h2>');
    expect(html).toContain("<strong>1 événement</strong>");
    const card = html.match(/<article class="card is-past reveal" data-id="([^"]+)">([\s\S]*?)<\/article>/)!;
    expect(card[1]).toBe(ids.halloween);
    expect(card[2]).toContain("Halloween Havana");
    expect(card[2]).toContain("<span>Terminé</span>");
    expect(card[2]).toContain('<span class="pill">2 dates</span>');
    expect(card[2]).toContain(`href="/acheter/${t.clientId}/${t.brandId}/${ids.halloween}" aria-label="Voir l’événement : Halloween Havana">Voir l’événement</a>`);
    expect(card[2]).not.toContain("Voir les billets");
    expect(card[2]).not.toContain("$");
    expect(card[2]).not.toContain("data-fav");
    for (const title of ["Soirée brouillon", "Concert annulé", "Carnaval d'antan", "Carnaval d&#39;antan", "Festival en cours", "Patin de l"]) expect(html).not.toContain(title);
    // Dates, prices, sort and the agenda are about sales: not offered here.
    expect(html).not.toContain('id="f-when"');
    expect(html).not.toContain('id="f-price"');
    expect(html).not.toContain('id="f-view"');
    // The search form keeps the period.
    expect(html).toContain('<input type="hidden" name="periode" value="passes" />');
  });

  it("searches the past by words and organizer, and drops what does not apply", async () => {
    expect(await page("periode=passes&q=halloween")).toContain("<strong>1 événement</strong>");
    const none = await page("periode=passes&q=jazz");
    expect(none).toContain("Aucun événement passé ne correspond à cette recherche.");
    expect(none).toContain('aria-label="Retirer le filtre : « jazz »"');
    expect(none).toContain('<a class="btn btn-ghost btn-sm" href="/?periode=passes#evenements">Tout effacer</a>');
    // A price or a date window from the upcoming list does not empty the past.
    expect(await page("periode=passes&prix=over50&quand=today&tri=prix")).toContain("<strong>1 événement</strong>");
    // Going to the past drops them from the link.
    expect(await page("prix=under25&quand=month")).toMatch(/href="\/\?periode=passes#evenements">Passés<span class="count">1<\/span>/);
  });

  it("with nothing on sale, says so and leads to the past", async () => {
    await db.pool.query(`UPDATE public.ticketing_sessions SET starts_at = now() - interval '1 day' WHERE event_id = $1`, [t.eventId]);
    const html = await page();
    expect(html).toContain("Aucun événement à venir pour le moment.");
    expect(html).toContain('<a class="btn btn-primary" href="/?periode=passes#evenements">Voir les événements passés (2)</a>');
    expect(html).not.toContain("Aucun organisateur");
    // The first event is now past too, the latest first.
    const order = [...(await page("periode=passes")).matchAll(/<article class="card is-past reveal" data-id="([^"]+)">/g)].map((m) => m[1]);
    expect(order).toEqual([t.eventId, ids.halloween]);
  });

  it("speaks English", async () => {
    const html = await page("lang=en&periode=passes");
    expect(html).toContain('<h2 id="events-title">Past events</h2>');
    expect(html).toContain("<span>Ended</span>");
    expect(html).toContain(">See the event</a>");
    expect(html).toMatch(/href="\/\?lang=en#evenements">Upcoming<span class="count">\d<\/span><\/a>/);
  });
});
