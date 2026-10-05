/**
 * Fixed-window, in-process limiter for public mutations (hold creation). It is a backstop
 * against one caller draining inventory with holds; production deployments with several
 * instances must also rate-limit at the edge.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true if the call is allowed. */
  take(key: string, nowMs: number): boolean {
    const w = this.windows.get(key);
    if (!w || w.resetAt <= nowMs) {
      if (this.windows.size > 10_000) this.sweep(nowMs);
      this.windows.set(key, { count: 1, resetAt: nowMs + this.windowMs });
      return true;
    }
    if (w.count >= this.limit) return false;
    w.count += 1;
    return true;
  }

  private sweep(nowMs: number): void {
    for (const [k, w] of this.windows) if (w.resetAt <= nowMs) this.windows.delete(k);
  }
}
