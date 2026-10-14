import { describe, expect, it } from "vitest";
import { watchAddress } from "../../src/ops/live-watch.js";

/** Run 63: the "Live" workflow's check of a public address (GET only). */
type Route = { status: number; body?: unknown; type?: string; location?: string } | "down";

const fakeFetch = (routes: Record<string, Route>) =>
  (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    const r = routes[path] ?? { status: 404, body: { error: { code: "not_found" } } };
    if (r === "down") throw new TypeError("fetch failed");
    const headers = new Headers({ "content-type": r.type ?? "application/json" });
    if (r.location) headers.set("location", r.location);
    return new Response(r.type?.startsWith("text/html") ? "<!doctype html>" : JSON.stringify(r.body ?? {}), { status: r.status, headers });
  }) as typeof fetch;

const up: Record<string, Route> = {
  "/health": { status: 200, body: { ok: true, service: "alkao", api: "alkao.api.v1", build: "85cd05873e79c3899cd9dbceb698ca63eff2011b" } },
  "/health/ready": { status: 200, body: { ok: true, database: "up" } },
  "/": { status: 200, type: "text/html; charset=utf-8" },
};

describe("live watch", () => {
  it("passes when the service, its database and the home page answer", async () => {
    const r = await watchAddress("https://alkao.test", { doFetch: fakeFetch(up), expectBuild: "85cd05873e79c3899cd9dbceb698ca63eff2011b" });
    expect(r).toEqual({
      origin: "https://alkao.test", ok: true, build: "85cd05873e79c3899cd9dbceb698ca63eff2011b",
      lines: ["✔ ALKAO répond (version 85cd05873e79)", "✔ Base de données joignable", "✔ Page d'accueil"],
    });
  });

  it("only warns when the address runs an older commit than main", async () => {
    const r = await watchAddress("https://alkao.test", { doFetch: fakeFetch(up), expectBuild: "9820f4507157756eb8878ac2b9ddfda9ab27d786" });
    expect(r.ok).toBe(true);
    expect(r.lines).toContain("⚠ main est à 9820f4507157 : le dernier déploiement n'est pas encore en ligne");
  });

  it("accepts a deployment without a build, and a white-label home redirect", async () => {
    const r = await watchAddress("https://billets.test", {
      doFetch: fakeFetch({ ...up, "/health": { status: 200, body: { ok: true, service: "alkao" } }, "/": { status: 302, location: "https://marque.test/" } }),
      expectBuild: "85cd058",
    });
    expect(r).toMatchObject({ ok: true, build: null });
    expect(r.lines).toEqual(["✔ ALKAO répond", "✔ Base de données joignable", "✔ Page d'accueil (redirigée)"]);
  });

  it("fails when the database, the home page or the whole address is down", async () => {
    const db = await watchAddress("https://alkao.test", { doFetch: fakeFetch({ ...up, "/health/ready": { status: 503, body: { ok: false, database: "down" } } }) });
    expect(db.ok).toBe(false);
    expect(db.lines).toContain("✘ /health/ready répond 503 : la base ne répond pas");

    // Run 70: a build whose migrations are not applied.
    const behind = await watchAddress("https://alkao.test", { doFetch: fakeFetch({ ...up, "/health/ready": { status: 503, body: { ok: false, database: "up", schema: "behind" } } }) });
    expect(behind.ok).toBe(false);
    expect(behind.lines).toContain("✘ /health/ready : des migrations de cette version ne sont pas appliquées (ALKAO_MIGRATE_ON_START ou scripts/migrate.ts)");
    const current = await watchAddress("https://alkao.test", { doFetch: fakeFetch({ ...up, "/health/ready": { status: 200, body: { ok: true, database: "up", schema: "current" } } }) });
    expect(current.lines).toContain("✔ Base de données joignable, schéma à jour");

    // An older ALKAO without the platform home answers / with a JSON 404.
    const home = await watchAddress("https://alkao.test", { doFetch: fakeFetch({ ...up, "/": { status: 404, body: { error: { code: "not_found" } } } }) });
    expect(home.ok).toBe(false);
    expect(home.lines).toContain("✘ la page d'accueil répond 404");

    const down = await watchAddress("https://alkao.test", { doFetch: fakeFetch({ "/health": "down" }) });
    expect(down).toEqual({ origin: "https://alkao.test", ok: false, build: null, lines: ["✘ injoignable (DNS, certificat ou serveur)"] });
  });

  it("fails when something else answers the address", async () => {
    const r = await watchAddress("https://alkao.test", { doFetch: fakeFetch({ "/health": { status: 200, type: "text/html" } }) });
    expect(r).toMatchObject({ ok: false, lines: ["✘ /health répond 200 : ce n'est pas ALKAO"] });
  });
});
