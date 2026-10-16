import { generateKeyPairSync, sign, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-ignore Browser JavaScript entrypoint is intentionally untyped.
import { newOfflineStore, offlineScan } from "../../ops-ui/offline.js";

const now = Date.parse("2026-10-16T13:00:00.000Z");
const kid = "k0000000001";
const qrId = Buffer.alloc(16, 7).toString("base64url");
const signer = generateKeyPairSync("ed25519");
const signed = `ALK1.${kid}.${qrId}`;
const authenticSignature = sign(null, Buffer.from(signed), signer.privateKey).toString("base64url");
const publicKey = signer.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
const payload = `${signed}.${authenticSignature}`;
const altered = `${signed}.${Buffer.alloc(64, 0).toString("base64url")}`;

function manifest() {
  return {
    format: "alkao.scanner.v1",
    validUntil: new Date(now + 600_000).toISOString(),
    keys: [{ kid, publicKey }],
    credentials: [{ qrId, ticketTypeName: "Admission générale" }],
    revoked: [],
    admitted: [],
    session: { admission: {
      opensAt: new Date(now - 60_000).toISOString(),
      closesAt: new Date(now + 3_600_000).toISOString(),
    } },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Run 83: offline admissions must verify Ed25519", () => {
  it("fails closed on a device with no WebCrypto, even with a known credential id", async () => {
    vi.stubGlobal("crypto", undefined);
    const store = newOfflineStore(manifest(), now);
    expect((await offlineScan(store, payload, now)).result).toBe("signature_unavailable");
    expect(store.localAdmitted).toEqual([]);
    expect(store.queue).toHaveLength(0);
    // Rejected QR never enters a queue that would later auto-admit online.
  });

  it("also fails closed when subtle crypto is present but cannot import Ed25519", async () => {
    vi.stubGlobal("crypto", { subtle: {
      importKey: async () => { throw Error("Ed25519 unsupported"); },
    } });
    const store = newOfflineStore(manifest(), now);
    expect((await offlineScan(store, payload, now)).result).toBe("signature_unavailable");
    expect(store.localAdmitted).toEqual([]);
  });

  it("rejects a forged signature even when its QR id is in the manifest", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const store = newOfflineStore(manifest(), now);
    expect((await offlineScan(store, altered, now)).result).toBe("invalid_signature");
    expect(store.localAdmitted).toEqual([]);
  });

  it("admits a correctly signed QR once, rejects revoked QR from a refreshed manifest", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const store = newOfflineStore(manifest(), now);
    expect((await offlineScan(store, payload, now)).result).toBe("admitted");
    expect(store.localAdmitted).toEqual([qrId]);
    expect((await offlineScan(store, payload, now + 1000)).result).toBe("already_admitted");
    const latest = manifest();
    latest.revoked.push({ qrId } as never);
    const afterTransfer = newOfflineStore(latest, now);
    expect((await offlineScan(afterTransfer, payload, now + 2000)).result).toBe("revoked");
    expect(afterTransfer.localAdmitted).toEqual([]);
  });

  it("an old manifest expires, requiring a refreshed revocation list", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const original = newOfflineStore(manifest(), now);
    expect((await offlineScan(original, payload, now + 600_000)).result).toBe("manifest_expired");
    expect(original.localAdmitted).toEqual([]);
    expect(original.queue).toEqual([]);
  });
});
