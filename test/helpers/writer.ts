import { WriterError, type WriteRequest, type WriteResult, type Writer } from "../../src/ai/writer.js";

/**
 * Run 92: stands in for Claude. Answers from a queue (one item per call, the last one again
 * after that) and keeps what it was asked; never reaches the network.
 */
export class FakeWriter implements Writer {
  readonly model = "claude-opus-5-5";
  asked: WriteRequest<unknown>[] = [];
  constructor(private answers: (unknown | WriterError)[]) {}
  async write<T>(req: WriteRequest<T>): Promise<WriteResult<T>> {
    this.asked.push(req as WriteRequest<unknown>);
    const next = this.answers.length > 1 ? this.answers.shift() : this.answers[0];
    if (next instanceof WriterError) throw next;
    return { output: req.schema.parse(next), model: this.model, usage: { inputTokens: 1800, outputTokens: 400 } };
  }
}
