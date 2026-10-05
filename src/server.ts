import { serve } from "@hono/node-server";
import { createSupabaseJwtVerifier } from "./api/auth.js";
import { createApp } from "./api/app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";

const config = loadConfig();
const db = createPool(config.databaseUrl);
const app = createApp({
  db,
  auth: createSupabaseJwtVerifier(config.jwt),
  operationalApiEnabled: config.operationalApiEnabled,
  controlKeys: config.controlKeys,
  holdTtlSeconds: config.holdTtlSeconds,
  publicHoldsPerMinute: config.publicHoldsPerMinute,
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `alkao listening on :${info.port} — operational API ${config.operationalApiEnabled ? "ENABLED" : "disabled (default)"}`,
  );
});
