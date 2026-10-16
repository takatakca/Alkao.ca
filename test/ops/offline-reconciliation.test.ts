import { describe, expect, it } from "vitest";
// @ts-ignore Browser source ships as an unbundled ES module.
import { newOfflineStore, syncOffline } from "../../ops-ui/offline.js";

const entry = (payload: string, admittedOffline = true) =>
  ({ payload, scannedAt: "2026-10-16T12:00:00.000Z", ...(admittedOffline ? { admittedOffline: true } : {}) });
const storeWith = (...items: ReturnType<typeof entry>[]) => {
  const store = newOfflineStore({});
  store.queue.push(...items);
  return store;
};
const accepted = (scans: { payload: string }[]) => scans.map((_, index) => ({ index, result: "admitted" }));
const rejected = (result: string) => [{ index: 0, result }];

describe("Run 84: offline gate reconciliation is lossless and admits only confirmed local entries", () => {
  it("never resends rejected attempts left in older device storage", async () => {
    const store = storeWith(entry("invalid-crypto", false), entry("offline-admitted"));
    const submitted: string[] = [];
    expect(await syncOffline(store, async (scans: { payload: string }[]) => {
      submitted.push(...scans.map(s => s.payload));
      return accepted(scans);
    })).toBe(true);
    expect(submitted).toEqual(["offline-admitted"]);
    expect(store.synced).toBe(1);
    expect(store.queue).toEqual([]);
    expect(store.conflicts).toBe(0);
  });

  it("preserves queued admissions if the server rejects with HTTP 403", async () => {
    const store = storeWith(entry("gate-a"));
    const synced = await syncOffline(store, async () => {
      throw Object.assign(Error("Forbidden"), { status: 403 });
    });
    expect(synced).toBe(false);
    expect(store.queue).toHaveLength(1);
    expect(store.synced).toBe(0);
  });

  it.each([
    { name: "empty reply", body: [] },
    { name: "absent response", body: undefined },
    { name: "no index", body: [{ result: "admitted" }] },
    { name: "wrong index", body: [{ index: 1, result: "admitted" }] },
    { name: "unknown result", body: [{ index: 0, result: "mystery_status" }] },
  ])("keeps every admission if acknowledgment is malformed: $name", async ({ body }) => {
    const store = storeWith(entry("gate-1"));
    expect(await syncOffline(store, async () => body)).toBe(false);
    expect(store.queue).toHaveLength(1);
    expect(store.synced).toBe(0);
    expect(store.conflicts).toBe(0);
  });

  it("retries after incomplete confirmation without losing the original entry", async () => {
    const store = storeWith(entry("gate-1"), entry("gate-2"));
    expect(await syncOffline(store, async () => [{ index: 0, result: "admitted" }])).toBe(false);
    expect(store.queue).toHaveLength(2);
    expect(await syncOffline(store, async (scans: { payload: string }[]) => accepted(scans))).toBe(true);
    expect(store.synced).toBe(2);
  });

  it("reconciles concurrent admissions from two offline gates: second entry is disputed", async () => {
    const left = storeWith(entry("same-valid-ticket"));
    const right = storeWith(entry("same-valid-ticket"));
    expect(await syncOffline(left, async () => rejected("admitted"))).toBe(true);
    expect(await syncOffline(right, async () => rejected("already_admitted"))).toBe(true);
    expect(left.conflicts).toBe(0);
    expect(right.conflicts).toBe(1);
    expect(right.synced).toBe(1);
    expect(right.queue).toEqual([]);
  });

  it("flags a QR admitted offline but revoked after transfer as a discrepancy", async () => {
    const store = storeWith(entry("old-owner-qr"));
    expect(await syncOffline(store, async () => rejected("revoked"))).toBe(true);
    expect(store.conflicts).toBe(1);
    expect(store.synced).toBe(1);
  });

  it("syncs batches of up to 500 in order with full acknowledgments", async () => {
    const store = storeWith(...Array.from({ length: 501 }, (_, i) => entry(`ticket-${i}`)));
    const batchSizes: number[] = [];
    expect(await syncOffline(store, async (scans: { payload: string }[]) => {
      batchSizes.push(scans.length);
      return accepted(scans);
    })).toBe(true);
    expect(batchSizes).toEqual([500, 1]);
    expect(store.synced).toBe(501);
    expect(store.queue).toHaveLength(0);
  });
});
