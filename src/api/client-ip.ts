import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

/**
 * Run 39: whether an address is a buyer's public one. Behind a host's proxy (cPanel
 * Passenger, a load balancer) a wrong ALKAO_TRUSTED_PROXY_HOPS yields "unknown" or the
 * proxy's private address, and every buyer would then share one rate-limit bucket.
 */
export function ipKind(ip: string): "public" | "private" | "unknown" {
  const v = ip.replace(/^::ffff:/i, "").toLowerCase();
  if (!v || v === "unknown") return "unknown";
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(v) || /^172\.(1[6-9]|2\d|3[01])\./.test(v) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v)) return "private";
  if (v === "::1" || v === "::" || /^(fc|fd|fe[89ab])[0-9a-f]{0,2}:/.test(v)) return "private";
  return "public";
}

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
