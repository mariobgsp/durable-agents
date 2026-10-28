import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { createServer, Socket, type Server } from "node:net";
import { dirname, resolve } from "node:path";

/**
 * The local control plane. A Unix socket, NDJSON frames, one request per line, one response, plus
 * server-initiated events for subscribers (fleet snapshots, log lines). File permissions are the
 * authentication: the socket is 0600 and its directory 0700, so only the owning user can connect.
 *
 * No TCP port, no token header, no Host allowlist: there is nothing to expose.
 */

export type IpcRequest = { id: string; method: string; params?: Record<string, unknown> };
export type IpcResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };
export type IpcEvent = { event: string; data: unknown };

export type IpcConnection = {
  /** Push one event to this client. Silently ignored after the socket closed. */
  send(event: string, data: unknown): void;
  readonly id: number;
};

export type IpcHandler = (method: string, params: Record<string, unknown>, connection: IpcConnection) => Promise<unknown>;

export type IpcServer = {
  close(): Promise<void>;
  broadcast(event: string, data: unknown): void;
  clientCount(): number;
};

function line(value: unknown): string {
  return JSON.stringify(value) + "\n";
}

async function socketIsLive(path: string): Promise<boolean> {
  return stat(path).then((entry) => entry.isSocket()).catch(() => false);
}

export async function createIpcServer(socketPath: string, handler: IpcHandler): Promise<IpcServer> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  if (await socketIsLive(socketPath)) {
    // A socket file with no listener is left behind by a crash. Probe it before unlinking.
    const probe = await new Promise<boolean>((done) => {
      const socket = new Socket();
      socket.once("connect", () => {
        socket.destroy();
        done(true);
      });
      socket.once("error", () => done(false));
      socket.connect(socketPath);
    });
    if (probe) throw new Error("another daemon is already listening on " + socketPath);
    await rm(socketPath, { force: true });
  }

  const clients = new Set<{ socket: Socket; connection: IpcConnection; buffer: string }>();
  let nextId = 1;

  const server: Server = createServer((socket) => {
    socket.setEncoding("utf8");
    const connection: IpcConnection = {
      id: nextId++,
      send: (event, data) => {
        if (socket.destroyed) return;
        socket.write(line({ event, data } satisfies IpcEvent));
      },
    };
    const entry = { socket, connection, buffer: "" };
    clients.add(entry);
    socket.on("data", (chunk: string) => {
      entry.buffer += chunk;
      let index: number;
      while ((index = entry.buffer.indexOf("\n")) >= 0) {
        const raw = entry.buffer.slice(0, index).trim();
        entry.buffer = entry.buffer.slice(index + 1);
        if (!raw) continue;
        void handleLine(raw, entry);
      }
    });
    const drop = (): void => {
      clients.delete(entry);
    };
    socket.on("close", drop);
    socket.on("error", drop);
  });

  async function handleLine(
    raw: string,
    entry: { socket: Socket; connection: IpcConnection },
  ): Promise<void> {
    let request: IpcRequest;
    try {
      request = JSON.parse(raw) as IpcRequest;
    } catch {
      entry.socket.write(line({ id: "?", ok: false, error: { code: "bad_json", message: "each line must be a JSON request" } }));
      return;
    }
    if (typeof request?.id !== "string" || typeof request?.method !== "string") {
      entry.socket.write(line({ id: String(request?.id ?? "?"), ok: false, error: { code: "bad_request", message: "id and method are required" } }));
      return;
    }
    try {
      const result = await handler(request.method, request.params ?? {}, entry.connection);
      if (!entry.socket.destroyed) entry.socket.write(line({ id: request.id, ok: true, result } satisfies IpcResponse));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "error";
      if (!entry.socket.destroyed) {
        entry.socket.write(line({ id: request.id, ok: false, error: { code, message } } satisfies IpcResponse));
      }
    }
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  await chmod(socketPath, 0o600);
  await chmod(dirname(socketPath), 0o700).catch(() => undefined);

  return {
    close: async () => {
      for (const entry of clients) entry.socket.destroy();
      clients.clear();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(socketPath, { force: true });
    },
    broadcast: (event, data) => {
      for (const entry of clients) entry.connection.send(event, data);
    },
    clientCount: () => clients.size,
  };
}
