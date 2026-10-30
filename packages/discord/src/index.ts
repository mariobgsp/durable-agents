import { DiscordRuntime } from "./runtime.ts";

/**
 * The composition point for the Discord surface. The CLI/daemon imports this one function; core
 * never imports the transport. Discord has no per-agent bot labels, so botLabels is omitted.
 */
export async function createDiscordTransport(): Promise<{
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<Record<string, unknown>>;
  methods: Record<string, (params: Record<string, unknown>, connection: never) => Promise<unknown>>;
  verifyExtra(): Promise<import("../../core/src/verify.ts").Check[]>;
}> {
  const runtime = new DiscordRuntime();
  return {
    start: () => runtime.start(),
    stop: () => runtime.stop(),
    status: () => runtime.status(),
    methods: runtime.methods(),
    verifyExtra: () => runtime.verifyExtra(),
  };
}
