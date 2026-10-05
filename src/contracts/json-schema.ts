import { z } from "zod";
import { CONTROL_CONTRACT_VERSION, ControlEvent } from "./control-v1.js";

/** JSON Schema of alkao.control.v1, published for the TAKATAK side (contracts/*.schema.json). */
export function controlContractJsonSchema(): Record<string, unknown> {
  return {
    $id: `https://alkao.ca/contracts/${CONTROL_CONTRACT_VERSION}.schema.json`,
    title: CONTROL_CONTRACT_VERSION,
    ...z.toJSONSchema(ControlEvent, { io: "input" }),
  };
}
