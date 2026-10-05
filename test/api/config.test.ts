import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

const base = { DATABASE_URL: "postgres://x" };

describe("configuration hardening", () => {
  it("lets only HTTPS origins frame /ops in production, localhost in development", () => {
    const origins = "https://app.takatak.ca, http://localhost:3000, http://evil.example, javascript:alert(1)";
    expect(loadConfig({ ...base, NODE_ENV: "production", ALKAO_OPS_FRAME_ANCESTORS: origins }).opsUi.frameAncestors).toEqual(["https://app.takatak.ca"]);
    expect(loadConfig({ ...base, NODE_ENV: "development", ALKAO_OPS_FRAME_ANCESTORS: origins }).opsUi.frameAncestors).toEqual(["https://app.takatak.ca", "http://localhost:3000"]);
  });

  it("trusts one proxy hop by default and refuses unbounded values", () => {
    expect(loadConfig(base).trustedProxyHops).toBe(1);
    expect(loadConfig({ ...base, ALKAO_TRUSTED_PROXY_HOPS: "0" }).trustedProxyHops).toBe(0);
    expect(() => loadConfig({ ...base, ALKAO_TRUSTED_PROXY_HOPS: "50" })).toThrow();
  });

  it("starts with the operational API off and refuses weak secrets", () => {
    expect(loadConfig(base).operationalApiEnabled).toBe(false);
    expect(() => loadConfig({ ...base, ALKAO_CREDENTIAL_MASTER_SECRET: "short" })).toThrow();
    expect(() => loadConfig({ ...base, ALKAO_CONTROL_KEYS: "kid:short" })).toThrow();
    expect(() => loadConfig({ ...base, ALKAO_PUBLIC_URL: "http://billets.example.ca" })).toThrow();
  });
});
