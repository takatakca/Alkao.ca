import { describe, expect, it } from "vitest";
import { scan, scanRepository } from "../../scripts/check-secrets.js";

// Fake values only, built at run time so this file itself holds no key-shaped string.
const fake = (prefix: string, n = 24) => `${prefix}${"a1B2c3D4".repeat(8).slice(0, n)}`;

describe("secret guard", () => {
  it("finds key-shaped values and says where, never what", () => {
    const text = [
      `const key = "${fake("sk_" + "live_")}";`,
      `webhook: ${fake("wh" + "sec_", 20)}`,
      `SUPA=${fake("sb_" + "secret_", 16)}`,
      `mail ${fake("re_" + "abcdef12_", 16)}`,
      `postgresql://postgres.ref:${"Rea1Pa55"}word@aws-0-ca-central-1.pooler.supabase.com:5432/postgres`,
    ].join("\n");
    const found = scan("src/x.ts", text);
    expect(found.map((f) => [f.line, f.kind])).toEqual([
      [1, "Stripe secret key"],
      [2, "Stripe or Resend webhook secret"],
      [3, "Supabase secret key"],
      [4, "Resend API key"],
      [5, "database password"],
    ]);
    expect(JSON.stringify(found)).not.toContain("a1B2");
  });

  it("accepts local test databases and documentation placeholders", () => {
    const text = [
      "DATABASE_URL: postgres://postgres:postgres@db:5432/alkao",
      "postgres://alkao:secret@db.internal:5432/alkao",
      "postgresql://postgres.<ref>:<password>@aws-0-ca-central-1.pooler.supabase.com:5432/postgres",
      "TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres",
    ].join("\n");
    expect(scan("docs/x.md", text)).toEqual([]);
  });

  it("wants every secret of .env.example left empty", () => {
    const text = ["STRIPE_SECRET_KEY=", "ALKAO_CONTROL_KEYS=takatak-1:abc", "ALKAO_PUBLIC_URL=https://billets.example.com", "TWILIO_AUTH_TOKEN=''"].join("\n");
    expect(scan(".env.example", text)).toEqual([{ file: ".env.example", line: 2, kind: "ALKAO_CONTROL_KEYS filled in .env.example" }]);
    // The same line elsewhere is a setting, not a template: only key-shaped values count there.
    expect(scan("docs/setup.md", text)).toEqual([]);
  });

  it("passes on this repository", () => {
    expect(scanRepository()).toEqual([]);
  });
});
