import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Loopback is always accepted. Anything else comes from PI_ALLOWED_HOSTS (comma-separated), where a
 * leading dot matches every subdomain — ".ts.net" therefore covers a Tailscale MagicDNS name such as
 * "laptop.tail1a2b3c.ts.net". A token is still required on every request, so this list only decides
 * which names may reach /api at all; it is the anti-DNS-rebinding half of the check, not the auth half.
 */
const DEFAULT_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]", "::1"];

function hostAllowlist(): { exact: Set<string>; suffixes: string[] } {
  const exact = new Set(DEFAULT_HOSTNAMES);
  const suffixes: string[] = [];
  for (const raw of (process.env.PI_ALLOWED_HOSTS ?? "").split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith(".") && entry.length > 1) suffixes.push(entry);
    else if (entry && !entry.startsWith(".")) exact.add(entry);
  }
  return { exact, suffixes };
}

const ALLOWED_HOSTNAMES = hostAllowlist();

function isAllowedHostname(hostname: string | null): boolean {
  if (!hostname) return false;
  const name = hostname.toLowerCase();
  return ALLOWED_HOSTNAMES.exact.has(name) || ALLOWED_HOSTNAMES.suffixes.some((s) => name.endsWith(s));
}

function hostnameOf(host: string | undefined): string | null {
  if (!host) return null;
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.split(":")[0] ?? null;
}

/** Token from the X-PI-Token header, or ?token= (used by the browser WebSocket handshake). */
function tokenOf(request: FastifyRequest): string | null {
  const header = request.headers["x-pi-token"];
  if (typeof header === "string" && header.length > 0) return header;
  const url = new URL(request.url, "http://127.0.0.1");
  return url.searchParams.get("token");
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

export type AuthResult = { ok: true } | { ok: false; status: number; message: string };

/** Check the token plus the Host allowlist (anti DNS-rebinding). Used by every /api route. */
export function authenticate(request: FastifyRequest, expected: string): AuthResult {
  if (!isAllowedHostname(hostnameOf(request.headers.host))) {
    return { ok: false, status: 403, message: "Host not allowed" };
  }
  const token = tokenOf(request);
  if (!token) return { ok: false, status: 401, message: "Token missing" };
  if (!sameSecret(token, expected)) return { ok: false, status: 401, message: "Token invalid" };
  return { ok: true };
}

/** onRequest hook: answer 401/403 before the handler runs. */
export function makeAuthHook(expected: string) {
  return async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const result = authenticate(request, expected);
    if (!result.ok) await reply.code(result.status).send({ error: result.message });
  };
}
