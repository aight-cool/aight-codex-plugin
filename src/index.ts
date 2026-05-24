#!/usr/bin/env bun
/**
 * Aight Codex Plugin — entry point.
 *
 * Spawns `codex app-server` as a subprocess, opens a WebSocket to the Aight
 * relay (channels.aight.cool), and bridges messages bidirectionally.
 *
 * Topology is inverted from aight-channel-plugin (Claude Code): there, our
 * plugin runs as a child of Claude. Here, we run as the parent of Codex.
 *
 * Usage:
 *   AIGHT_RELAY_URL=https://channels.aight.cool bun src/index.ts
 *
 * Configuration (env):
 *   CODEX_BIN              path to codex binary (default: "codex")
 *   AIGHT_RELAY_URL        relay host (default: https://channels.aight.cool)
 *   AIGHT_AUTO_APPROVE_CWD true to auto-accept all in-cwd ops (default: true)
 */

import { writeFileSync, mkdirSync, readFileSync, unlinkSync, statSync } from "fs";
import { join, extname, basename } from "path";
import { homedir } from "os";

import { CodexClient } from "./codex-client";
import { RelayClient } from "./relay-client";
import { type InboundMessage, type InboundAttachment, LIMITS } from "./protocol";
import { MIME_MAP, sanitizeFileName, createRateLimiter, cleanInbox } from "./utils";

const RELAY_URL = process.env.AIGHT_RELAY_URL || "https://channels.aight.cool";
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const STATE_DIR = join(homedir(), ".codex", "channels", "aight");
const INBOX_DIR = join(STATE_DIR, "inbox");
const CODE_FILE = join(STATE_DIR, `pairing-code-${process.pid}.txt`);
// The shell function `cd`s into the plugin dir for bun's dep resolution, so
// process.cwd() ends up pointing at the plugin instead of where the user ran
// `aight-codex`. The setup script forwards the user's invocation cwd via
// AIGHT_CODEX_CWD; fall back to process.cwd() if it's missing (e.g. direct
// `bun src/index.ts` invocation from inside the plugin dir).
const threadCwd = process.env.AIGHT_CODEX_CWD || process.cwd();

mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 });
cleanInbox(INBOX_DIR, LIMITS.MAX_INBOX_SIZE);

const rateLimiter = createRateLimiter();
let messageCounter = 0;
let threadId: string | null = null;
let activeTurnId: string | null = null;
// itemId → accumulated agent message text (Codex streams deltas)
const pendingAgentText: Map<string, string> = new Map();
// relay approval id → JSON-RPC request id + timeout cleanup
// (the relay-side id maps the chip in the app to a pending Codex request)
const pendingApprovals: Map<
  string,
  { requestId: number | string; timeoutHandle: NodeJS.Timeout }
> = new Map();

// ─── Setup ──────────────────────────────────────────────────────────────────

const codex = new CodexClient({ cwd: threadCwd, codexBin: CODEX_BIN });
codex.on("error", (err) => {
  console.error(`[codex-client] error: ${err.message}`);
});
codex.on("exit", (code, sig) => {
  console.error(`[codex-client] exited (code=${code}, signal=${sig})`);
  // Decline any pending approvals so the relay/app sees a final state.
  for (const [id] of pendingApprovals) sendApprovalDecision(id, "denied");
  process.exit(code ?? 1);
});

await codex.initialize({ name: "aight-codex-plugin", version: "0.1.0" });

try {
  const result = await codex.startThread({
    cwd: threadCwd,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
  threadId = result.thread.id;
  console.log(`[aight-codex] thread started: ${threadId} (cwd: ${threadCwd})`);
} catch (err) {
  const e = err as { message?: string; code?: number };
  console.error(`[aight-codex] Failed to start codex thread: ${e.message ?? err}`);
  if (e.code === -32600 || /unauthorized|sign.in|login/i.test(e.message ?? "")) {
    console.error(`[aight-codex] If you haven't authenticated, run: codex login`);
  }
  process.exit(2);
}

// ─── Codex → Relay ──────────────────────────────────────────────────────────

codex.on("notification", (method: string, params: unknown) => {
  if (!params || typeof params !== "object") return;
  const p = params as Record<string, unknown>;

  switch (method) {
    case "turn/started": {
      const turn = p.turn as { id?: string } | undefined;
      activeTurnId = turn?.id ?? null;
      relay.send({ type: "turn_event", event: "started", timestamp: new Date().toISOString() });
      break;
    }
    case "turn/completed": {
      activeTurnId = null;
      relay.send({ type: "turn_event", event: "ended", timestamp: new Date().toISOString() });
      break;
    }
    case "item/agentMessage/delta": {
      const itemId = String(p.itemId ?? "");
      const delta = String(p.delta ?? "");
      pendingAgentText.set(itemId, (pendingAgentText.get(itemId) ?? "") + delta);
      break;
    }
    case "item/started": {
      const item = p.item as { id?: string; type?: string; details?: unknown } | undefined;
      if (!item) break;
      if (
        item.type === "commandExecution" ||
        item.type === "fileChange" ||
        item.type === "mcpToolCall"
      ) {
        relay.send({
          type: "tool_event",
          event: "start",
          tool: item.type,
          input: summarizeItem(item),
          timestamp: new Date().toISOString(),
        });
      }
      break;
    }
    case "item/completed": {
      const item = p.item as
        | { id?: string; type?: string; status?: string; output?: string; exitCode?: number }
        | undefined;
      if (!item) break;
      if (item.type === "agentMessage") {
        const text = pendingAgentText.get(String(item.id)) ?? "";
        pendingAgentText.delete(String(item.id));
        if (text.trim()) {
          relay.send({
            type: "assistant_message",
            content: text,
            timestamp: new Date().toISOString(),
          });
        }
      } else if (
        item.type === "commandExecution" ||
        item.type === "fileChange" ||
        item.type === "mcpToolCall"
      ) {
        const isFailed = item.status === "failed";
        relay.send({
          type: "tool_event",
          event: isFailed ? "error" : "end",
          tool: item.type,
          ...(item.output
            ? isFailed
              ? { error: item.output.slice(0, 500) }
              : { result: item.output.slice(0, 500) }
            : {}),
          timestamp: new Date().toISOString(),
        });
      }
      break;
    }
  }
});

// Server-initiated JSON-RPC requests from Codex (approvals, etc).
// Schema source: `codex app-server generate-ts` (ServerRequest.ts).
codex.on("request", (method: string, params: unknown, requestId: number | string) => {
  if (
    method !== "item/commandExecution/requestApproval" &&
    method !== "item/fileChange/requestApproval"
  ) {
    // Decline anything we don't understand — safer than hanging the turn.
    codex.respondError(requestId, -32601, `unsupported approval method: ${method}`);
    return;
  }

  const p = (params ?? {}) as Record<string, unknown>;
  const kind: "command" | "fileChange" = method.includes("commandExecution")
    ? "command"
    : "fileChange";
  const summary = summarizeApprovalParams(p, kind);
  const approvalId = `approval_${String(p.itemId ?? requestId)}`;

  relay.send({
    type: "approval_request",
    id: approvalId,
    approvalKind: kind,
    approvalSummary: summary,
    approvalDetails: stringifyDetails(p),
    outsideWorkspace: true,
    timestamp: new Date().toISOString(),
  });

  const timeoutHandle = setTimeout(() => {
    if (pendingApprovals.has(approvalId)) {
      console.error(`[aight-codex] approval ${approvalId} expired — declining`);
      sendApprovalDecision(approvalId, "timed_out");
    }
  }, 60_000);
  pendingApprovals.set(approvalId, { requestId, timeoutHandle });
});

type ReviewDecision = "approved" | "denied" | "timed_out" | "abort";

function sendApprovalDecision(approvalId: string, decision: ReviewDecision) {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) return;
  clearTimeout(pending.timeoutHandle);
  pendingApprovals.delete(approvalId);
  // Codex's wire-level ReviewDecision is "approved"|"denied". Map our local
  // labels (timed_out, abort) onto "denied" so Codex receives a valid value.
  const wireDecision = decision === "approved" ? "approved" : "denied";
  codex.respond(pending.requestId, { decision: wireDecision });
}

function stringifyDetails(params: Record<string, unknown>): string {
  try {
    return JSON.stringify(params, null, 2).slice(0, 1024);
  } catch {
    return "";
  }
}

function summarizeApprovalParams(
  p: Record<string, unknown>,
  kind: "command" | "fileChange",
): string {
  if (kind === "command") {
    const cmd = p.command as string | undefined;
    if (cmd) return cmd;
    const reason = p.reason as string | undefined;
    if (reason) return reason;
    return "Codex wants to run a command outside the workspace";
  }
  // fileChange — schema doesn't include the path, just threadId/turnId/itemId/reason.
  // Best we can show is the reason.
  const reason = p.reason as string | undefined;
  return reason ?? "Codex wants to make a file change outside the workspace";
}

function summarizeItem(item: { type?: string; details?: unknown }): string {
  const details = (item.details ?? {}) as Record<string, unknown>;
  if (item.type === "commandExecution") {
    const cmd = details.command as string[] | string | undefined;
    if (Array.isArray(cmd)) return cmd.join(" ").slice(0, 200);
    if (typeof cmd === "string") return cmd.slice(0, 200);
  }
  if (item.type === "fileChange") {
    const path = details.path as string | undefined;
    if (path) return path;
  }
  return item.type ?? "unknown";
}

// ─── Relay → Codex ──────────────────────────────────────────────────────────

function saveAttachment(att: InboundAttachment): string {
  // Reap stale + cap-evict before writing so a paired peer can't fill
  // local disk by streaming attachments at the per-minute rate limit forever.
  cleanInbox(INBOX_DIR, LIMITS.MAX_INBOX_SIZE);
  const ts = Date.now();
  const safeName = sanitizeFileName(att.fileName);
  const filePath = join(INBOX_DIR, `${ts}-${safeName}`);
  const buffer = Buffer.from(att.content, "base64");
  writeFileSync(filePath, buffer, { mode: 0o600 });
  return filePath;
}

async function handleInboundMessage(data: InboundMessage): Promise<void> {
  if (!threadId) return;

  // The phone sends "accept"/"decline"; Codex's ReviewDecision is
  // "approved"/"denied". Translate here so the wire protocol with the app
  // stays human-friendly.
  if (data.type === "approval_response") {
    const codexDecision: ReviewDecision =
      data.decision === "accept" ? "approved" : "denied";
    sendApprovalDecision(data.id, codexDecision);
    return;
  }

  if (data.type !== "message") return;

  if (!rateLimiter.allow()) {
    console.error("[aight-codex] rate limit exceeded, dropping message");
    return;
  }

  const savedPaths: string[] = [];
  if (data.attachments?.length) {
    for (const att of data.attachments) {
      try {
        savedPaths.push(saveAttachment(att));
      } catch (err) {
        console.error(`[aight-codex] save attachment failed: ${err}`);
      }
    }
  }

  let text = data.content;
  if (savedPaths.length > 0) {
    text +=
      `\n\n[Attached files — use the Read tool to view]\n` +
      savedPaths.map((p) => `- ${p}`).join("\n");
  }

  try {
    if (activeTurnId) {
      await codex.steerTurn(threadId, activeTurnId, text);
    } else {
      await codex.startTurn(threadId, text);
    }
    if (data.id) {
      relay.send({
        type: "ack",
        messageId: data.id,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error(`[aight-codex] turn send failed: ${err}`);
    relay.send({
      type: "reply",
      id: `codex_err_${++messageCounter}`,
      replyTo: null,
      content:
        "I couldn't send that to Codex. If you just signed in, try again. " +
        "If this keeps happening, run `codex login` in your terminal.",
      sender: {
        id: "codex",
        name: "Codex",
        emoji: "\u{1F9E0}",
        username: "codex",
      },
      timestamp: new Date().toISOString(),
    });
  }
}

// ─── Relay client lifecycle ─────────────────────────────────────────────────

const relay = new RelayClient(RELAY_URL, {
  onMessage: async (data: InboundMessage) => {
    if (data.type === "ping") {
      relay.send({ type: "pong", timestamp: new Date().toISOString() });
      return;
    }
    await handleInboundMessage(data);
  },
  onStateChange: (state) => {
    console.log(`[aight-codex-relay] state: ${state}`);
  },
  onPairingCode: (code) => {
    process.stderr.write(`\n[aight-codex] ════════════════════════════════════════\n`);
    process.stderr.write(`[aight-codex]   Pairing Code: ${code}\n`);
    process.stderr.write(`[aight-codex] ════════════════════════════════════════\n`);
    process.stderr.write(`[aight-codex]   Enter this in the Aight app to connect.\n`);
    process.stderr.write(`[aight-codex]   Code expires in 5 minutes.\n\n`);

    try {
      writeFileSync(CODE_FILE, `${code}\n`, { mode: 0o600 });
    } catch (err) {
      process.stderr.write(`[aight-codex] Failed to write code file: ${err}\n`);
    }
  },
});

// ─── Cleanup ────────────────────────────────────────────────────────────────

function cleanup() {
  for (const f of [CODE_FILE]) {
    try {
      unlinkSync(f);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[aight-codex] cleanup failed for ${f}: ${err}`);
      }
    }
  }
  for (const [id] of pendingApprovals) sendApprovalDecision(id, "denied");
  codex.close().catch(() => undefined);
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

// Reference the imports so the build doesn't tree-shake helpers we'll need
// when attachments and outbound files are wired in v2.
void MIME_MAP;
void readFileSync;
void basename;
void extname;

console.log(`[aight-codex] Connecting to relay at ${RELAY_URL}`);
await relay.start();
