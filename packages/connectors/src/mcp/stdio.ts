/**
 * An MCP server as a child process.
 *
 * The framing is one JSON message per line on stdin and stdout, which is all
 * the stdio transport is. Ids are correlated here so the session above can be a
 * plain request/response port.
 *
 * The server's stderr is not swallowed but it is not read back into a prompt
 * either: a server that logs on startup is normal, and a model has no use for
 * it. It is kept for the last failure message, which is the one place it
 * actually helps — "the command exited" is useless on its own.
 *
 * Nothing here spawns anything until the first request, so building a broker
 * for an office with six connectors starts no processes.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpTransport,
} from "./session.js";

export interface StdioOptions {
  readonly command: string;
  readonly args: readonly string[];
  /** Variables to pass on, by name: values come from this process, never the office. */
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

/** How much of a server's own logging is kept to explain a failure. */
export const MAX_STDERR_CHARS = 2_000;

/**
 * How long a server is given to go on its own after its input is closed.
 *
 * Closing stdin is how a stdio server is told the conversation is over, and a
 * well-behaved one finishes what it was doing and exits. Killing it in the same
 * breath makes that impossible — anything it was flushing is lost, which is a
 * nasty way to end a tool call that already happened.
 */
export const CLOSE_GRACE_MS = 1_000;

interface Waiting {
  readonly resolve: (response: JsonRpcResponse) => void;
  readonly reject: (error: Error) => void;
}

export function stdioTransport(options: StdioOptions): McpTransport {
  let child: ChildProcessWithoutNullStreams | null = null;
  let closedBecause: string | null = null;
  let logged = "";
  let buffer = "";
  const waiting = new Map<number | string, Waiting>();
  let deliver: ((notification: JsonRpcNotification) => void) | null = null;

  const fail = (reason: string): void => {
    closedBecause = reason;
    const message = logged.length === 0 ? reason : `${reason}. It said: ${logged.trim()}`;
    for (const [, one] of waiting) one.reject(new Error(message));
    waiting.clear();
  };

  const take = (line: string): void => {
    if (line.trim().length === 0) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // A line that is not JSON is a server writing to the wrong stream. It is
      // not an answer to anything, so there is nothing to fail.
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const record = message as Record<string, unknown>;
    const id = record["id"];
    if (id === undefined || id === null) {
      const method = record["method"];
      if (typeof method === "string") {
        deliver?.({
          jsonrpc: "2.0",
          method,
          ...(record["params"] === undefined
            ? {}
            : { params: record["params"] as Record<string, unknown> }),
        });
      }
      return;
    }
    const pending = waiting.get(id as number | string);
    if (pending === undefined) return;
    waiting.delete(id as number | string);
    pending.resolve(message as JsonRpcResponse);
  };

  const start = (): ChildProcessWithoutNullStreams => {
    if (child !== null) return child;
    // Never restarted here. A fresh process has not been introduced to, and a
    // session that thinks it has shaken hands would be talking to a stranger —
    // reconnecting means a new transport and a new session, which the broker
    // above does deliberately.
    if (closedBecause !== null) throw new Error(closedBecause);
    const spawned = spawn(options.command, [...options.args], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...process.env, ...(options.env ?? {}) },
    });
    child = spawned;

    spawned.stdout.setEncoding("utf8");
    spawned.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        take(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });

    spawned.stderr.setEncoding("utf8");
    spawned.stderr.on("data", (chunk: string) => {
      logged = `${logged}${chunk}`.slice(-MAX_STDERR_CHARS);
    });

    spawned.on("error", (error: Error) => {
      child = null;
      fail(`${options.command} could not be run: ${error.message}`);
    });

    spawned.on("close", (code, signal) => {
      child = null;
      const how = signal === null ? `exit ${String(code ?? "unknown")}` : `signal ${signal}`;
      fail(`${options.command} closed (${how})`);
    });

    return spawned;
  };

  const write = (message: JsonRpcRequest | JsonRpcNotification): Promise<void> => {
    let running: ChildProcessWithoutNullStreams;
    try {
      running = start();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return new Promise((resolve, reject) => {
      running.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  };

  return {
    request(message: JsonRpcRequest): Promise<JsonRpcResponse> {
      return new Promise<JsonRpcResponse>((resolve, reject) => {
        waiting.set(message.id, { resolve, reject });
        write(message).catch((error: unknown) => {
          waiting.delete(message.id);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });
    },

    notify(message: JsonRpcNotification): Promise<void> {
      return write(message);
    },

    onNotification(handler) {
      deliver = handler;
    },

    close(): Promise<void> {
      const running = child;
      child = null;
      if (running === null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          running.kill();
        }, CLOSE_GRACE_MS);
        running.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        // Told, then given a moment, then insisted upon.
        running.stdin.end();
      });
    },
  };
}
