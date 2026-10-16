import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-ignore ALKAO Operations' unbundled JavaScript module has no TS declarations.
import { createOfflineCoordinator, loadOffline, newOfflineStore, saveOffline, syncOffline } from "../../ops-ui/offline.js";

const sessionId = "test-offline-serialized";
const entry = (payload: string) => ({
  payload, scannedAt: "2026-10-16T15:00:00.000Z", admittedOffline: true,
});
const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
const successful = (scans: { payload: string }[]) => scans.map((_, index) => ({ index, result: "admitted" }));

afterEach(() => vi.unstubAllGlobals());

describe("Run 86: serialize local offline scan writes and synchronization", () => {
  it("does not erase a newly scanned ticket when a sync response arrives later", async () => {
    vi.stubGlobal("localStorage", storage());
    const base = newOfflineStore({});
    base.queue.push(entry("admission-before-sync"));
    saveOffline(sessionId, base);
    const sequence = createOfflineCoordinator();
    const http = deferred<{ index: number; result: string }[]>();
    const started = deferred<void>();
    const syncing = sequence(async () => {
      const snapshot = loadOffline(sessionId)!;
      const done = await syncOffline(snapshot, async (scans: { payload: string; scannedAt: string }[]) => {
        expect(scans.map((s: { payload: string }) => s.payload)).toEqual(["admission-before-sync"]);
        started.resolve();
        return http.promise;
      });
      expect(done).toBe(true);
      saveOffline(sessionId, snapshot);
    });
    await started.promise;
    const scanning = sequence(async () => {
      const latest = loadOffline(sessionId)!;
      latest.queue.push(entry("admission-during-sync"));
      latest.localAdmitted.push("new-id");
      saveOffline(sessionId, latest);
    });
    expect(loadOffline(sessionId)!.queue).toHaveLength(1);
    http.resolve([{ index: 0, result: "admitted" }]);
    await Promise.all([syncing, scanning]);
    const final = loadOffline(sessionId)!;
    expect(final.queue.map((q: { payload: string }) => q.payload)).toEqual(["admission-during-sync"]);
    expect(final.localAdmitted).toEqual(["new-id"]);
    expect(final.synced).toBe(1);
    const accepted = await sequence(async () => {
      const latest = loadOffline(sessionId)!;
      const ok = await syncOffline(latest, async (scans: { payload: string }[]) => successful(scans));
      saveOffline(sessionId, latest);
      return ok;
    });
    expect(accepted).toBe(true);
    expect(loadOffline(sessionId)!.queue).toEqual([]);
    expect(loadOffline(sessionId)!.synced).toBe(2);
  });

  it("an exit operation cannot delete a queue while a preceding scan is still processing", async () => {
    vi.stubGlobal("localStorage", storage());
    saveOffline(sessionId, newOfflineStore({}));
    const sequence = createOfflineCoordinator();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const scan = sequence(async () => {
      entered.resolve();
      await gate.promise;
      const current = loadOffline(sessionId)!;
      current.queue.push(entry("still-needs-server-audit"));
      saveOffline(sessionId, current);
    });
    await entered.promise;
    const exit = sequence(async () => {
      const current = loadOffline(sessionId);
      if (!current?.queue.length) saveOffline(sessionId, null);
    });
    gate.resolve();
    await Promise.all([scan, exit]);
    expect(loadOffline(sessionId)!.queue.map((q: { payload: string }) => q.payload))
      .toEqual(["still-needs-server-audit"]);
  });

  it("continues processing later scanner operations after an HTTP failure", async () => {
    const sequence = createOfflineCoordinator();
    const events: string[] = [];
    await expect(sequence(async () => { events.push("failed"); throw Error("server 503"); }))
      .rejects.toThrow("server 503");
    await expect(sequence(async () => { events.push("recovered"); return "ok"; })).resolves.toBe("ok");
    expect(events).toEqual(["failed", "recovered"]);
  });
});
