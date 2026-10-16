import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-ignore The offline gate is delivered as a browser ES module.
import { createOfflineCoordinator, loadOffline, newOfflineStore, saveOffline, syncOffline, withOfflineSessionLock } from "../../ops-ui/offline.js";

const sessionId = "test-cross-tab-offline";
const entry = (payload: string) => ({ payload, admittedOffline: true, scannedAt: "2026-10-16T19:00:00.000Z" });

function fakeStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => { values.set(k, v); },
    removeItem: (k: string) => { values.delete(k); },
  };
}
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
};
function webLocks() {
  const queued = new Map<string, Promise<unknown>>();
  const calls: string[] = [];
  return {
    calls,
    request: <T>(name: string, options: { mode: string }, fn: () => Promise<T>) => {
      expect(options.mode).toBe("exclusive");
      calls.push(name);
      const previous = queued.get(name) ?? Promise.resolve();
      const current = previous.then(fn, fn);
      queued.set(name, current.catch(() => undefined));
      return current;
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("Run 87: two scanner tabs may not overwrite each other's offline admission audit", () => {
  it("holds the same session Web Lock across a pending server acknowledgment", async () => {
    vi.stubGlobal("localStorage", fakeStorage());
    const locks = webLocks();
    vi.stubGlobal("navigator", { locks });
    const initial = newOfflineStore({});
    initial.queue.push(entry("first-admission"));
    saveOffline(sessionId, initial);
    // Two distinct Preact components / tabs have independent local FIFO objects.
    const tabA = createOfflineCoordinator();
    const tabB = createOfflineCoordinator();
    const network = deferred<{ index: number; result: string }[]>();
    const started = deferred<void>();
    const syncing = tabA(() => withOfflineSessionLock(sessionId, async () => {
      const current = loadOffline(sessionId)!;
      expect(await syncOffline(current, async (scans: { payload: string }[]) => {
        expect(scans.map((x) => x.payload)).toEqual(["first-admission"]);
        started.resolve();
        return network.promise;
      })).toBe(true);
      saveOffline(sessionId, current);
    }));
    await started.promise;
    let enteredTabB = false;
    const scanning = tabB(() => withOfflineSessionLock(sessionId, async () => {
      enteredTabB = true;
      const current = loadOffline(sessionId)!;
      current.queue.push(entry("second-admission"));
      current.localAdmitted.push("second-id");
      saveOffline(sessionId, current);
    }));
    await Promise.resolve();
    expect(enteredTabB).toBe(false);
    network.resolve([{ index: 0, result: "admitted" }]);
    await Promise.all([syncing, scanning]);
    const persisted = loadOffline(sessionId)!;
    expect(persisted.queue.map((e: { payload: string }) => e.payload)).toEqual(["second-admission"]);
    expect(persisted.localAdmitted).toEqual(["second-id"]);
    expect(persisted.synced).toBe(1);
    expect(locks.calls).toEqual([
      "alkao.ops.offline.audit." + sessionId,
      "alkao.ops.offline.audit." + sessionId,
    ]);
  });

  it("never permits a NEW offline admission on a browser lacking Web Locks", async () => {
    vi.stubGlobal("navigator", {});
    let ran = false;
    await expect(withOfflineSessionLock(sessionId, async () => {
      ran = true;
    })).rejects.toThrow("offline_lock_unavailable");
    expect(ran).toBe(false);
    // Existing physical admissions cannot be stranded in storage forever.
    expect(await withOfflineSessionLock(sessionId, async () => "reconciled", { recovery: true }))
      .toBe("reconciled");
  });

  it("a failed tab A task releases the lock so tab B can continue", async () => {
    const locks = webLocks();
    vi.stubGlobal("navigator", { locks });
    await expect(withOfflineSessionLock(sessionId, async () => {
      throw new Error("network disconnected");
    })).rejects.toThrow("network disconnected");
    await expect(withOfflineSessionLock(sessionId, async () => "success")).resolves.toBe("success");
  });

  it("unrelated sessions can scan concurrently without waiting for one another", async () => {
    vi.stubGlobal("navigator", { locks: webLocks() });
    const gate = deferred<void>();
    const started = deferred<void>();
    const a = withOfflineSessionLock("session-a", async () => {
      started.resolve();
      await gate.promise;
    });
    await started.promise;
    const b = withOfflineSessionLock("session-b", async () => "allowed");
    expect(await b).toBe("allowed");
    gate.resolve();
    await a;
  });
});
