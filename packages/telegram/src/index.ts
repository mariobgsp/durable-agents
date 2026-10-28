import { TelegramRuntime } from "./runtime.ts";

/**
 * The composition point: the CLI/daemon imports this one function, and core never imports the
 * transport. The runtime exposes start/stop, status, verification checks and IPC methods.
 */
export async function createTelegramTransport(): Promise<{
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<Record<string, unknown>>;
  methods: Record<string, (params: Record<string, unknown>, connection: never) => Promise<unknown>>;
  verifyExtra(): Promise<import("../../core/src/verify.ts").Check[]>;
  botLabels(): Promise<string[]>;
}> {
  const runtime = new TelegramRuntime();
  return {
    start: () => runtime.start(),
    stop: () => runtime.stop(),
    status: () => runtime.status(),
    methods: runtime.methods(),
    verifyExtra: () => runtime.verifyExtra(),
    botLabels: async () => runtime.botLabels(),
  };
}
