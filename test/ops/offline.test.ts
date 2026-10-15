import { describe, expect, it } from "vitest";
// @ts-ignore Browser JavaScript entrypoint is intentionally untyped.
import { newOfflineStore, offlineScan } from "../../ops-ui/offline.js";

describe("Run 79: fail closed on expired scanner manifests", () => {
  const now = Date.parse("2026-10-15T13:00:00.000Z");

  it("refuses expired lists without recording or admitting scans", async () => {
    const store = newOfflineStore({
      validUntil: new Date(now - 1).toISOString(),
    }, now - 30_000);
    const result = await offlineScan(store, "malformed", now);
    expect(result).toEqual({ result: "manifest_expired" });
    expect(store.queue).toHaveLength(0);
    expect(store.localAdmitted).toHaveLength(0);
  });

  it("refuses missing validity instead of assuming an old offline list is safe", async () => {
    const old = newOfflineStore({}, now - 999_999);
    expect(await offlineScan(old, "malformed", now)).toEqual({ result: "manifest_expired" });
    expect(old.queue).toHaveLength(0);
  });

  it("processes an available list only before the exact expiry instant", async () => {
    const store = newOfflineStore({ validUntil: new Date(now + 1).toISOString() }, now);
    expect((await offlineScan(store, "malformed", now)).result).toBe("malformed");
    expect(store.queue).toHaveLength(1);
    expect((await offlineScan(store, "malformed", now + 1)).result).toBe("manifest_expired");
    expect(store.queue).toHaveLength(1);
  });
});
