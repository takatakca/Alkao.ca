import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { controlContractJsonSchema } from "../../src/contracts/json-schema.js";

it("the published control-contract JSON Schema matches the code (run npm run contracts:generate)", () => {
  const published = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "contracts", "alkao-control.v1.schema.json"), "utf8"));
  expect(published).toEqual(controlContractJsonSchema());
});
