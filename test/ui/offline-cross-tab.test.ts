import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let browser: Browser;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/ops/offline.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(readFileSync("ops-ui/offline.js", "utf8"));
    } else {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html lang='fr'><title>ALKAO test</title><body>Ops<script type='module'>import * as offline from '/ops/offline.js';globalThis.offlineModule=offline;</script></body></html>");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ ...(process.env.ALKAO_CHROMIUM_PATH
    ? { executablePath: process.env.ALKAO_CHROMIUM_PATH } : {}), args: ["--no-sandbox"] });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Run 87: Chromium two-tab Web Locks reconciliation", () => {
  it("prevents another tab from overwriting an admission during a delayed sync", async () => {
    const context = await browser.newContext();
    try {
      const tabA = await context.newPage();
      const tabB = await context.newPage();
      await Promise.all([tabA.goto(origin), tabB.goto(origin)]);
      await Promise.all([
        tabA.waitForFunction(() => Boolean((globalThis as any).offlineModule)),
        tabB.waitForFunction(() => Boolean((globalThis as any).offlineModule)),
      ]);
      expect(await tabA.evaluate(() => typeof (globalThis as any).navigator.locks?.request)).toBe("function");

      await tabA.evaluate(async () => {
        const mod = (globalThis as any).offlineModule;
        const local = mod.newOfflineStore({});
        local.queue.push({ payload: "first-admission", scannedAt: "2026-10-16T19:00:00Z", admittedOffline: true });
        mod.saveOffline("cross-tab", local);
      });

      const pending = tabA.evaluate(async () => {
        const mod = (globalThis as any).offlineModule;
        await mod.withOfflineSessionLock("cross-tab", async () => {
          const snapshot = mod.loadOffline("cross-tab");
          await new Promise<void>((resolve) => {
            (globalThis as any).releaseSync = resolve;
            (globalThis as any).syncHoldingLock = true;
          });
          snapshot.queue.splice(0, 1);
          snapshot.synced++;
          mod.saveOffline("cross-tab", snapshot);
        });
      });
      await tabA.waitForFunction(() => (globalThis as any).syncHoldingLock === true);

      const queuedScan = tabB.evaluate(async () => {
        const mod = (globalThis as any).offlineModule;
        (globalThis as any).tabBStarted = true;
        await mod.withOfflineSessionLock("cross-tab", async () => {
          (globalThis as any).tabBEntered = true;
          const latest = mod.loadOffline("cross-tab");
          latest.queue.push({
            payload: "second-admission", scannedAt: "2026-10-16T19:01:00Z", admittedOffline: true,
          });
          mod.saveOffline("cross-tab", latest);
        });
      });
      await tabB.waitForFunction(() => (globalThis as any).tabBStarted === true);
      expect(await tabB.evaluate(() => Boolean((globalThis as any).tabBEntered))).toBe(false);

      await tabA.evaluate(() => (globalThis as any).releaseSync());
      await Promise.all([pending, queuedScan]);
      const result = await tabB.evaluate(async () => {
        const mod = (globalThis as any).offlineModule;
        const local = mod.loadOffline("cross-tab");
        return { queue: local.queue.map((e: { payload: string }) => e.payload), synced: local.synced };
      });
      expect(result).toEqual({ queue: ["second-admission"], synced: 1 });
    } finally {
      await context.close();
    }
  }, 30_000);
  it("preserves a denied offline admission report across a fresh browser tab and reload", async () => {
    const context = await browser.newContext();
    try {
      const tab = await context.newPage();
      await tab.goto(origin);
      await tab.waitForFunction(() => Boolean((globalThis as any).offlineModule));
      const evidence = await tab.evaluate(async () => {
        const mod = (globalThis as any).offlineModule;
        const session = "run88";
        const raw = "ALK1.k1234567890." + "A".repeat(22) + "." + "B".repeat(86);
        const store = mod.newOfflineStore({});
        store.queue.push({ payload: raw, scannedAt: "2026-10-16T19:00:00.000Z", admittedOffline: true });
        mod.saveOffline(session, store);
        await mod.withOfflineSessionLock(session, async () => {
          const loaded = mod.loadOffline(session);
          await mod.syncOffline(loaded, async () => [{ index: 0, result: "already_admitted" }]);
          mod.saveOffline(session, loaded);
          mod.archiveOfflineIncidents(session, loaded);
          mod.saveOffline(session, null);
        });
        return {
          count: mod.loadIncidentReport(session).length,
          temporary: mod.loadOffline(session),
          containsQr: JSON.stringify(mod.loadIncidentReport(session)).includes(raw),
        };
      });
      expect(evidence).toEqual({ count: 1, temporary: null, containsQr: false });
      const second = await context.newPage();
      await second.goto(origin);
      await second.waitForFunction(() => Boolean((globalThis as any).offlineModule));
      const report = await second.evaluate(() => {
        const mod = (globalThis as any).offlineModule;
        return {
          list: mod.loadIncidentReport("run88"),
          csv: mod.incidentReportCsv(mod.loadIncidentReport("run88")),
        };
      });
      expect(report.list).toHaveLength(1);
      expect(report.list[0]).toMatchObject({
        qrId: "A".repeat(22), result: "already_admitted",
      });
      expect(report.csv).toContain('"already_admitted"');
      expect(report.csv).not.toContain("B".repeat(86));
    } finally {
      await context.close();
    }
  }, 30_000);

});
