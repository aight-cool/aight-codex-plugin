/**
 * Codex App-Server JSON-RPC client.
 *
 * Spawns `codex app-server` as a subprocess and drives it over stdio with
 * newline-delimited JSON-RPC 2.0 messages (jsonrpc:"2.0" header omitted).
 *
 * Scope of this module is intentionally narrow: framing + a handful of method
 * wrappers we actually call. The full Codex schema is large — pull more in as
 * the integration grows.
 *
 * The protocol is documented at https://developers.openai.com/codex/app-server.
 * Run `codex app-server generate-ts` against your local install to confirm
 * exact field names before extending this file.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export type CodexNotification = {
  method: string;
  params: Record<string, unknown> | undefined;
};

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export interface CodexClientOptions {
  /** Override the codex binary path (defaults to `codex` from PATH). */
  codexBin?: string;
  /** Working directory for the subprocess. Inherits process.cwd() if unset. */
  cwd?: string;
  /** Extra environment to merge over process.env when spawning. */
  env?: Record<string, string>;
}

/**
 * EventEmitter contract:
 *   - 'notification' (method, params) — every server-initiated message
 *   - 'exit' (code, signal) — child process terminated
 *   - 'error' (err) — spawn or stdio error
 */
export class CodexClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buf = "";

  constructor(opts: CodexClientOptions = {}) {
    super();
    const bin = opts.codexBin ?? "codex";
    this.proc = spawn(bin, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
    });
    this.proc.on("error", (err) => this.emit("error", err));
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.on("data", (chunk: Buffer) =>
      process.stderr.write(chunk),
    );
    this.proc.on("exit", (code, signal) => {
      this.emit("exit", code, signal);
      const err = new Error(
        `codex app-server exited (code=${code}, signal=${signal})`,
      );
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        this.handleMessage(JSON.parse(line));
      } catch (err) {
        console.error(`[codex-client] parse error on line: ${line}`, err);
      }
    }
  }

  private handleMessage(msg: {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  }): void {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(
          Object.assign(new Error(msg.error.message), {
            code: msg.error.code,
            data: msg.error.data,
          }),
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      this.emit("notification", msg.method, msg.params);
    }
  }

  /** Send a JSON-RPC request and await the response. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.write({ id, method, params });
    });
  }

  /** Fire-and-forget notification (no `id`). */
  notify(method: string, params?: unknown): void {
    this.write({ method, params });
  }

  private write(msg: Record<string, unknown>): void {
    if (!this.proc.stdin.writable) {
      console.error("[codex-client] stdin is not writable");
      return;
    }
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  /** Tear down the subprocess. */
  async close(): Promise<void> {
    return new Promise((resolve) => {
      this.proc.once("exit", () => resolve());
      try {
        this.proc.stdin.end();
      } catch {
        // ignore
      }
      setTimeout(() => {
        if (this.proc.exitCode === null) {
          this.proc.kill("SIGTERM");
        }
      }, 1000);
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Method wrappers — names per https://developers.openai.com/codex/app-server.
  // Verify against `codex app-server generate-ts` output for your version.
  // ────────────────────────────────────────────────────────────────────────

  /** Required first call. Pair with an `initialized` notification. */
  async initialize(clientInfo: {
    name: string;
    title?: string;
    version: string;
  }): Promise<unknown> {
    const result = await this.request("initialize", {
      clientInfo,
      capabilities: { experimentalApi: false },
    });
    this.notify("initialized", {});
    return result;
  }

  startThread(opts: {
    cwd: string;
    approvalPolicy?: "never" | "untrusted" | "on_request";
    sandbox?: "read_only" | "workspace_write" | "danger_full_access";
    model?: string;
  }): Promise<{ thread: { id: string } }> {
    return this.request<{ thread: { id: string } }>("thread/start", opts);
  }

  startTurn(threadId: string, text: string): Promise<unknown> {
    return this.request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
    });
  }

  steerTurn(
    threadId: string,
    expectedTurnId: string,
    text: string,
  ): Promise<unknown> {
    return this.request("turn/steer", {
      threadId,
      expectedTurnId,
      input: [{ type: "text", text }],
    });
  }

  interruptTurn(threadId: string): Promise<unknown> {
    return this.request("turn/interrupt", { threadId });
  }

  listSkills(cwd: string): Promise<unknown> {
    return this.request("skills/list", { cwd });
  }
}
