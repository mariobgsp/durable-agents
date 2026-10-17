import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

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
  if (!ALLOWED_HOSTNAMES.has(hostnameOf(request.headers.host) ?? "")) {
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
