import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-ignore Browser entrypoint ships as an untyped JS ES module.
import { newOfflineStore, saveOffline, loadOffline, syncOffline, archiveOfflineIncidents, loadIncidentReport, incidentReportCsv } from "../../ops-ui/offline.js";

const session = "run88-incident-session";
const now = "2026-10-16T19:00:00.000Z";
const qr = "ALK1.k1234567890." + "A".repeat(22) + "." + "B".repeat(86);

function storage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (name: string) => data.get(name) ?? null,
    setItem: (name: string, value: string) => { data.set(name, value); },
    removeItem: (name: string) => { data.delete(name); },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("Run 88: offline admission discrepancy evidence persists after exiting", () => {
  it("retains a dispute after deleting the temporary offline audit without storing any signed QR", async () => {
    vi.stubGlobal("localStorage", storage());
    const store = newOfflineStore({});
    store.queue.push({ payload: qr, scannedAt: now, admittedOffline: true });
    saveOffline(session, store);
    expect(await syncOffline(store, async () => [{ index: 0, result: "revoked" }])).toBe(true);
    expect(store.conflicts).toBe(1);
    expect(store.incidents).toHaveLength(1);
    expect(store.incidents[0]).toMatchObject({
      qrId: "A".repeat(22), scannedAt: now, result: "revoked",
    });
    expect(JSON.stringify(store.incidents)).not.toContain(qr);

    saveOffline(session, store);
    const archived = archiveOfflineIncidents(session, loadOffline(session));
    saveOffline(session, null);
    expect(loadOffline(session)).toBeNull();
    expect(loadIncidentReport(session)).toEqual(archived);
    expect(archived).toHaveLength(1);
    const csv = incidentReportCsv(archived);
    expect(csv).toContain('"revoked"');
    expect(csv).toContain('"A'.concat("A".repeat(21), '"'));
    expect(csv).not.toContain(qr);
    expect(csv).not.toContain("B".repeat(86));
    // A repeated exit/recovery must not duplicate an already archived record.
    expect(archiveOfflineIncidents(session, store)).toHaveLength(1);
  });

  it("maintains one ledger per session, including legacy counts without QR identifiers", () => {
    vi.stubGlobal("localStorage", storage());
    const old = newOfflineStore({});
    old.conflicts = 3;
    delete old.incidents;
    const existing = archiveOfflineIncidents("session-a", old);
    expect(existing).toMatchObject([{ result: "legacy_unspecified", count: 3, qrId: "" }]);
    expect(loadIncidentReport("session-b")).toEqual([]);
    const later = newOfflineStore({});
    later.incidents.push({ id: "one", qrId: "Q".repeat(22), scannedAt: now,
      reconciledAt: now, result: "already_admitted" });
    later.conflicts = 1;
    expect(archiveOfflineIncidents("session-b", later)).toHaveLength(1);
    expect(loadIncidentReport("session-a")).toHaveLength(1);
  });

  it("never discards a local audit if archiving fails or an existing report is corrupted", () => {
    const local = storage();
    vi.stubGlobal("localStorage", {
      ...local,
      setItem: (name: string, value: string) => {
        if (name.startsWith("alkao.ops.incidents.")) throw Error("quota exceeded");
        local.setItem(name, value);
      },
    });
    const store = newOfflineStore({});
    store.queue.push({ payload: qr, scannedAt: now, admittedOffline: true });
    store.incidents.push({ id: "one", qrId: "A".repeat(22), scannedAt: now,
      reconciledAt: now, result: "revoked" });
    store.conflicts = 1;
    saveOffline(session, store);
    expect(() => archiveOfflineIncidents(session, store)).toThrow("quota exceeded");
    expect(loadOffline(session)?.queue).toHaveLength(1);

    vi.stubGlobal("localStorage", local);
    local.data.set("alkao.ops.incidents." + session, "{invalid");
    expect(() => loadIncidentReport(session)).toThrow("offline_incident_report_corrupt");
    expect(() => archiveOfflineIncidents(session, store)).toThrow("offline_incident_report_corrupt");
    expect(loadOffline(session)?.queue).toHaveLength(1);
  });

  it("does not archive a conflicting batch unless every server index is acknowledged", async () => {
    vi.stubGlobal("localStorage", storage());
    const store = newOfflineStore({});
    store.queue.push({ payload: qr, scannedAt: now, admittedOffline: true });
    expect(await syncOffline(store, async () => [{ index: 3, result: "revoked" }])).toBe(false);
    expect(store.incidents).toEqual([]);
    expect(store.conflicts).toBe(0);
    expect(await syncOffline(store, async () => [{ index: 0, result: "revoked" }])).toBe(true);
    expect(store.incidents).toHaveLength(1);
  });


  it("archives old-session incidents before the 24-hour automatic cleanup", async () => {
    vi.stubGlobal("localStorage", storage());
    const s = "old-admission-audit";
    const expired = new Date(Date.now() - 25 * 3600_000).toISOString();
    const store = newOfflineStore({ session: { admission: { closesAt: expired } } });
    store.conflicts = 1;
    store.incidents.push({
      id: "old-case", qrId: "R".repeat(22), scannedAt: now,
      reconciledAt: now, result: "revoked",
    });
    saveOffline(s, store);
    expect(loadOffline(s)).toBeNull();
    expect(loadIncidentReport(s)).toMatchObject([{
      id: "old-case", result: "revoked", qrId: "R".repeat(22),
    }]);
  });
  it("keeps the scanner usable and the original audit when aged report storage fails", () => {
    const local = storage();
    vi.stubGlobal("localStorage", local);
    const sessionId = "run89-storage-recovery";
    const expired = new Date(Date.now() - 26 * 3600_000).toISOString();
    const source = newOfflineStore({ session: { admission: { closesAt: expired } } });
    source.conflicts = 1;
    source.incidents.push({
      id: "audit-recovery", qrId: "R".repeat(22),
      scannedAt: now, reconciledAt: now, result: "revoked",
    });
    saveOffline(sessionId, source);
    local.data.set("alkao.ops.incidents." + sessionId, "not-json");
    const recovered = loadOffline(sessionId);
    expect(recovered).toMatchObject({ incidentArchiveFailed: true, conflicts: 1 });
    expect(recovered?.incidents).toHaveLength(1);
    expect(local.getItem("alkao.ops.offline." + sessionId)).not.toBeNull();
    // Once old storage is repaired the same auto-expiry can archive safely.
    local.data.delete("alkao.ops.incidents." + sessionId);
    expect(loadOffline(sessionId)).toBeNull();
    expect(loadIncidentReport(sessionId)).toMatchObject([{ id: "audit-recovery" }]);
  });

  it("escapes untrusted CSV spreadsheet formulas (defense in depth)", () => {
    const csv = incidentReportCsv([{ id: "id", qrId: "=SUM(1,1)", result: "@risk",
      scannedAt: now, reconciledAt: now }]);
    expect(csv).toContain('"\'=SUM(1,1)"');
    expect(csv).toContain('"\'@risk"');
  });
});
