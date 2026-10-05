import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { controlContractJsonSchema } from "../src/contracts/json-schema.js";

const out = join(import.meta.dirname, "..", "contracts", "alkao-control.v1.schema.json");
writeFileSync(out, `${JSON.stringify(controlContractJsonSchema(), null, 2)}\n`);
console.log(`wrote ${out}`);
