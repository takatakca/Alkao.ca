import { describe, expect, it } from "vitest";
import { derivePrivateKey, publicKeyB64, signMessage, verifyMessage } from "../../src/credentials/keys.js";
import { b64ToUuid, buildPayload, parsePayload, signedPart, uuidToB64 } from "../../src/credentials/payload.js";

const secret = "s".repeat(40);
const client = "0b7e3c1a-2f4d-4c8e-9a1b-3c5d7e9f1a2b";
const credentialId = "7e3c1a2f-4d4c-4e9a-9b3c-5d7e9f1a2b3c";

function payloadFor(kid: string, version = 1, clientId = client) {
  const key = derivePrivateKey(secret, clientId, version);
  return buildPayload(kid, credentialId, signMessage(key, signedPart(kid, credentialId)));
}

describe("credential payload ALK1", () => {
  it("carries only the format tag, key id and credential id — no dates or ticket data", () => {
    const payload = payloadFor("kabc1234567");
    const [tag, kid, id, sig] = payload.split(".");
    expect([tag, kid]).toEqual(["ALK1", "kabc1234567"]);
    expect(b64ToUuid(id!)).toBe(credentialId);
    expect(Buffer.from(sig!, "base64url")).toHaveLength(64);
    expect(payload.split(".")).toHaveLength(4); // tag, kid, credential id, signature — nothing else
    expect(payload.length).toBeLessThan(140);
  });

  it("verifies with the Client's public key only", () => {
    const parsed = parsePayload(payloadFor("kabc1234567"))!;
    const pub = publicKeyB64(derivePrivateKey(secret, client, 1));
    expect(verifyMessage(pub, parsed.signedMessage, parsed.signature)).toBe(true);
    const otherClient = publicKeyB64(derivePrivateKey(secret, "1b7e3c1a-2f4d-4c8e-9a1b-3c5d7e9f1a2b", 1));
    const otherVersion = publicKeyB64(derivePrivateKey(secret, client, 2));
    expect(verifyMessage(otherClient, parsed.signedMessage, parsed.signature)).toBe(false);
    expect(verifyMessage(otherVersion, parsed.signedMessage, parsed.signature)).toBe(false);
  });

  it("derives the same key every time, and never from a short secret", () => {
    expect(publicKeyB64(derivePrivateKey(secret, client, 1))).toBe(publicKeyB64(derivePrivateKey(secret, client, 1)));
    expect(() => derivePrivateKey("short", client, 1)).toThrow();
  });

  it("rejects tampered and malformed payloads", () => {
    const payload = payloadFor("kabc1234567");
    const pub = publicKeyB64(derivePrivateKey(secret, client, 1));
    const otherId = uuidToB64("7e3c1a2f-4d4c-4e9a-9b3c-5d7e9f1a2b3d");
    const swapped = parsePayload(payload.replace(uuidToB64(credentialId), otherId))!;
    expect(verifyMessage(pub, swapped.signedMessage, swapped.signature)).toBe(false);
    for (const bad of ["", "ALK1", "ALK2.kabc1234567.x.y", payload.slice(0, -2), `${payload}x`, payload.replace("kabc", "KABC")]) {
      expect(parsePayload(bad), bad).toBeNull();
    }
  });
});
