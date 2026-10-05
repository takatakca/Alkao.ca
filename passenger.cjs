"use strict";

// Run 39: ALKAO on MochaHost (cPanel "Setup Node.js App", Phusion Passenger). Set this file
// as the application startup file. Passenger hands the server its socket through listen(),
// so PORT does not matter there. Elsewhere, `npm start` stays the way to run ALKAO.
//
// Settings come from .env in the application root, never from the artifact. A value the
// panel sets already wins over the file. Nothing here prints a setting's value.
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const envFile = join(__dirname, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";

import("tsx/esm/api")
  .then(({ register }) => {
    register();
    return import("./src/server.ts");
  })
  .catch((error) => {
    console.error(`[alkao] startup failed: ${error && error.message ? error.message : error}`);
    process.exit(1);
  });
