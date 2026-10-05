import { createPrivateKey, createPublicKey, hkdfSync, sign, verify, type KeyObject } from "node:crypto";

/**
 * Credential signing keys: Ed25519, one versioned key per Client.
 *
 * Private keys are never stored. Each is derived on demand from the deployment secret
 * ALKAO_CREDENTIAL_MASTER_SECRET with HKDF-SHA256 (salt "alkao.credential.v1",
 * info "<clientId>:<version>"). The database keeps only public keys, which scanners
 * receive in their manifest to verify QR codes offline. Rotating = a new version.
 */

const SALT = "alkao.credential.v1";
// PKCS#8 DER prefix for a raw 32-byte Ed25519 seed.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function derivePrivateKey(masterSecret: string, clientId: string, version: number): KeyObject {
  if (masterSecret.length < 32) throw new Error("credential master secret must be at least 32 characters");
  const seed = Buffer.from(hkdfSync("sha256", masterSecret, SALT, `${clientId}:${version}`, 32));
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
}

/** Raw 32-byte public key, base64url (43 chars). */
export function publicKeyB64(privateKey: KeyObject): string {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x: string };
  return jwk.x;
}

export function signMessage(privateKey: KeyObject, message: string): Buffer {
  return sign(null, Buffer.from(message, "utf8"), privateKey);
}

export function verifyMessage(publicKeyRawB64: string, message: string, signature: Buffer): boolean {
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKeyRawB64 }, format: "jwk" });
    return verify(null, Buffer.from(message, "utf8"), key, signature);
  } catch {
    return false;
  }
}
