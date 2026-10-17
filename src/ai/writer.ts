import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

/**
 * Run 92: the writing assistant's one call to a language model. Staff ask for a draft (a
 * campaign, an event description); the model answers in a fixed JSON shape. Behind an
 * interface so tests, and a deployment without a key, never reach the network.
 */
export interface WriteRequest<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
}

export interface WriteResult<T> {
  output: T;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface Writer {
  readonly model: string;
  write<T>(req: WriteRequest<T>): Promise<WriteResult<T>>;
}

/** The model declined, answered outside the shape, or the service failed: staff write it themselves. */
export class WriterError extends Error {
  constructor(readonly reason: "refused" | "unparsed" | "unavailable" | "rate_limited") {
    super(`writer ${reason}`);
  }
}

export function claudeWriter(opts: { apiKey: string; model: string }): Writer {
  const client = new Anthropic({ apiKey: opts.apiKey, timeout: 60_000, maxRetries: 1 });
  return {
    model: opts.model,
    async write<T>({ system, prompt, schema }: WriteRequest<T>): Promise<WriteResult<T>> {
      let res;
      try {
        res = await client.beta.messages.parse({
          model: opts.model,
          max_tokens: 8000,
          // A short marketing text: low effort is enough and keeps the cost per draft down.
          output_config: { effort: "low", format: betaZodOutputFormat(schema) },
          // When the model declines, the API retries on the model Anthropic picks for that case.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system,
          messages: [{ role: "user", content: prompt }],
        });
      } catch (err) {
        if (err instanceof Anthropic.RateLimitError) throw new WriterError("rate_limited");
        if (err instanceof Anthropic.APIError) throw new WriterError("unavailable");
        throw err;
      }
      if (res.stop_reason === "refusal") throw new WriterError("refused");
      if (res.parsed_output == null) throw new WriterError("unparsed");
      return {
        output: res.parsed_output as T,
        model: res.model,
        usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      };
    },
  };
}
