/**
 * Smoke test for codex-client JSON-RPC framing. Mocks child_process.spawn
 * so we never touch a real `codex` binary.
 */

import { describe, it, expect, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// Inline a tiny spy-friendly spawn mock. Replace globalThis's child_process
// resolution before the module under test is imported.
function fakeSpawn() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    kill: (sig: string) => void;
  };
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.exitCode = null;
  proc.kill = () => undefined;
  return proc;
}

mock.module("node:child_process", () => {
  const proc = fakeSpawn();
  (globalThis as { __codexFakeProc?: ReturnType<typeof fakeSpawn> }).__codexFakeProc = proc;
  return {
    spawn: () => proc,
  };
});

const { CodexClient } = await import("../codex-client");

describe("CodexClient JSON-RPC framing", () => {
  it("matches responses to their request id", async () => {
    const proc = (globalThis as { __codexFakeProc: ReturnType<typeof fakeSpawn> })
      .__codexFakeProc;
    const client = new CodexClient();

    // Capture what the client wrote to stdin so we can mirror an id back.
    const writes: string[] = [];
    proc.stdin.on("data", (chunk: Buffer) => {
      writes.push(chunk.toString("utf8"));
    });

    const responsePromise = client.request<{ ok: boolean }>("test/method", { x: 1 });

    // Wait one tick so the request lands in writes[].
    await new Promise((r) => setTimeout(r, 10));
    const msg = JSON.parse(writes[0]!.trim());
    expect(msg.method).toBe("test/method");
    expect(msg.params).toEqual({ x: 1 });
    expect(typeof msg.id).toBe("number");

    // Emit a matching response on stdout.
    proc.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\n");

    const result = await responsePromise;
    expect(result).toEqual({ ok: true });
  });

  it("emits notifications for server-initiated messages", async () => {
    const proc = (globalThis as { __codexFakeProc: ReturnType<typeof fakeSpawn> })
      .__codexFakeProc;
    const client = new CodexClient();

    const events: Array<{ method: string; params: unknown }> = [];
    client.on("notification", (method: string, params: unknown) => {
      events.push({ method, params });
    });

    proc.stdout.write(
      JSON.stringify({ method: "turn/started", params: { turn: { id: "t1" } } }) + "\n",
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(events).toHaveLength(1);
    expect(events[0]?.method).toBe("turn/started");
  });
});
