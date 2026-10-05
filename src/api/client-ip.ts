import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

/**
 * The caller's IP for rate limiting. X-Forwarded-For is spoofable: only the entries added by
 * our own proxies count. With `trustedProxyHops` = n, the client is the n-th address from the
 * right of X-Forwarded-For (what the outermost trusted proxy saw); with 0, the socket peer.
 */
export function clientIp(c: Context, trustedProxyHops: number): string {
  if (trustedProxyHops > 0) {
    const chain = (c.req.header("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (chain.length >= trustedProxyHops) return chain[chain.length - trustedProxyHops]!;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown"; // in-process requests (tests)
  }
}
