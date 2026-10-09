import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testApp, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult } from "../helpers/seed.js";

// Run 53: a shared shop link shows the event's title, photo and Brand. Synthetic data only.

let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool, { publicUrl: "https://billets.example.test/" });
});

afterAll(async () => {
  await db?.drop();
});

const html = async (path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: await res.text() };
};
const meta = (body: string, property: string) => new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)" />`).exec(body)?.[1] ?? null;

describe("shared shop links", () => {
  it("name the published event, its photo and its Brand", async () => {
    const t = seed.havana;
    await db.pool.query(
      `UPDATE public.ticketing_events SET title = 'Nuit des lanternes', description = 'Feux, musique et guimauves sous les étoiles.',
         image_url = 'https://cdn.example.com/events/nuit.jpg' WHERE id = $1`,
      [t.eventId],
    );
    const { status, body } = await html(`/acheter/${t.clientId}/${t.brandId}/${t.eventId}`);
    expect(status).toBe(200);
    expect(body).toContain("<title>Nuit des lanternes — Havana Resort — Événements</title>");
    expect(meta(body, "og:title")).toBe("Nuit des lanternes — Havana Resort — Événements");
    expect(meta(body, "og:description")).toBe("Feux, musique et guimauves sous les étoiles.");
    expect(meta(body, "og:image")).toBe("https://cdn.example.com/events/nuit.jpg");
    expect(meta(body, "og:url")).toBe(`https://billets.example.test/acheter/${t.clientId}/${t.brandId}/${t.eventId}`);
    expect(meta(body, "og:site_name")).toBe("Havana Resort — Événements");
    expect(meta(body, "twitter:card")).toBe("summary_large_image");
    // The app still loads as before.
    expect(body).toContain('<script type="module" src="/shop/app.js"></script>');
  });

  it("escape what staff typed, and never use an image that is not https", async () => {
    const t = seed.havana;
    await db.pool.query(
      `UPDATE public.ticketing_events SET title = $2, description = NULL, image_url = NULL WHERE id = $1`,
      [t.eventId, `Soirée "spéciale" <script>alert(1)</script> $& $1`],
    );
    const { body } = await html(`/acheter/${t.clientId}/${t.brandId}/${t.eventId}`);
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(meta(body, "og:title")).toBe("Soirée &quot;spéciale&quot; &lt;script&gt;alert(1)&lt;/script&gt; $&amp; $1 — Havana Resort — Événements");
    // No description: the place and "Billets en ligne".
    expect(meta(body, "og:description")).toMatch(/· Billets en ligne$/);
    expect(meta(body, "og:image")).toBeNull();
    expect(meta(body, "twitter:card")).toBe("summary");
  });

  it("reveal nothing for a draft event, an unknown event or a closed ticketing", async () => {
    const t = seed.havana;
    const plain = (body: string) => {
      expect(body).toContain("<title>Billetterie</title>");
      expect(meta(body, "og:title")).toBeNull();
      expect(body).not.toContain("Nuit des lanternes");
    };
    await db.pool.query(`UPDATE public.ticketing_events SET status = 'draft' WHERE id = $1`, [t.eventId]);
    plain((await html(`/acheter/${t.clientId}/${t.brandId}/${t.eventId}`)).body);
    await db.pool.query(`UPDATE public.ticketing_events SET status = 'published' WHERE id = $1`, [t.eventId]);
    plain((await html(`/acheter/${t.clientId}/${t.brandId}/${randomUUID()}`)).body);
    // Another Brand's event under this Brand's address.
    plain((await html(`/acheter/${t.clientId}/${t.brandId}/${seed.festi.eventId}`)).body);
    // A Client TAKATAK does not know.
    plain((await html(`/acheter/${randomUUID()}/${randomUUID()}/${t.eventId}`)).body);
  });

  it("name the Brand on its list of events", async () => {
    const t = seed.festi;
    const { body } = await html(`/acheter/${t.clientId}/${t.brandId}`);
    expect(body).toContain("<title>FESTI-ICE</title>");
    expect(meta(body, "og:site_name")).toBe("FESTI-ICE");
  });
});
