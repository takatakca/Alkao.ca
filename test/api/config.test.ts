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
    // Run 80: even an active Ticketing deployment does not expose transfer APIs
    // until explicitly enabled by the operator after full recipient UI/mail QA.
    expect(loadConfig(base).transferApiEnabled).toBe(false);
    expect(loadConfig({ ...base, ALKAO_OPERATIONAL_API_ENABLED: "true" }).transferApiEnabled).toBe(false);
    expect(loadConfig({ ...base, ALKAO_TRANSFER_API_ENABLED: "true" }).transferApiEnabled).toBe(true);
    expect(() => loadConfig({ ...base, ALKAO_TRANSFER_API_ENABLED: "maybe" })).toThrow();
    expect(() => loadConfig({ ...base, ALKAO_CREDENTIAL_MASTER_SECRET: "short" })).toThrow();
    expect(() => loadConfig({ ...base, ALKAO_CONTROL_KEYS: "kid:short" })).toThrow();
    expect(() => loadConfig({ ...base, ALKAO_PUBLIC_URL: "http://billets.example.ca" })).toThrow();
    expect(loadConfig({ ...base, ALKAO_HOME_URL: "https://www.example.ca/billets" }).homeUrl).toBe("https://www.example.ca/billets");
    expect(() => loadConfig({ ...base, ALKAO_HOME_URL: "http://www.example.ca/billets" })).toThrow();
  });

  it("starts with a setting left empty, and names the setting to fix without its value (Run 102)", () => {
    // Coolify keeps a cleared variable as "": the server must still start, as if it were not set.
    const cleared = loadConfig({ ...base, ALKAO_HOME_URL: "", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "  ", RESEND_WEBHOOK_SECRET: "" });
    expect(cleared.homeUrl).toBeNull();
    expect(cleared.stripe).toBeNull();
    expect(cleared.resendWebhookSecret).toBeNull();
    // A pasted key with a space or a line break around it still works.
    expect(loadConfig({ ...base, STRIPE_SECRET_KEY: " sk_live_abc\n", STRIPE_WEBHOOK_SECRET: "whsec_x " }).stripe).toMatchObject({ secretKey: "sk_live_abc", webhookSecret: "whsec_x", mode: "live" });
    // A wrong value still stops it, naming the setting, never the value.
    const wrong = () => loadConfig({ ...base, STRIPE_SECRET_KEY: "pk_live_secretvalue", ALKAO_HOME_URL: "http://x.test" });
    expect(wrong).toThrow(/^ALKAO cannot start: fix STRIPE_SECRET_KEY, ALKAO_HOME_URL/);
    expect(wrong).not.toThrow(/secretvalue/);
  });

  it("knows Stripe test keys from live keys (Run 32)", () => {
    const webhook = { STRIPE_WEBHOOK_SECRET: "whsec_x" };
    expect(loadConfig({ ...base, ...webhook, STRIPE_SECRET_KEY: "sk_test_abc" }).stripe?.mode).toBe("test");
    expect(loadConfig({ ...base, ...webhook, STRIPE_SECRET_KEY: "rk_test_abc" }).stripe?.mode).toBe("test");
    expect(loadConfig({ ...base, ...webhook, STRIPE_SECRET_KEY: "sk_live_abc" }).stripe?.mode).toBe("live");
    expect(loadConfig(base).stripe).toBeNull();
    expect(() => loadConfig({ ...base, ...webhook, STRIPE_SECRET_KEY: "pk_test_abc" })).toThrow();
  });
});
