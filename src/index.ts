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
import { MIME_MAP, sanitizeFileName, createRateLimiter } from "./utils";

const RELAY_URL = process.env.AIGHT_RELAY_URL || "https://channels.aight.cool";
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const STATE_DIR = join(homedir(), ".codex", "channels", "aight");
const INBOX_DIR = join(STATE_DIR, "inbox");
const CODE_FILE = join(STATE_DIR, `pairing-code-${process.pid}.txt`);

mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 });

const rateLimiter = createRateLimiter();
let messageCounter = 0;
let threadId: string | null = null;
let activeTurnId: string | null = null;
// itemId → accumulated agent message text (Codex streams deltas)
const pendingAgentText: Map<string, string> = new Map();
// approvalId → unresolved request (resolve when phone responds)
const pendingApprovals: Map<
  string,
  { resolve: (decision: "accept" | "decline") => void; timeoutHandle: NodeJS.Timeout }
> = new Map();

// ─── Setup ──────────────────────────────────────────────────────────────────

const codex = new CodexClient({ cwd: process.cwd(), codexBin: CODEX_BIN });
codex.on("error", (err) => {
  console.error(`[codex-client] error: ${err.message}`);
});
codex.on("exit", (code, sig) => {
  console.error(`[codex-client] exited (code=${code}, signal=${sig})`);
  // Decline any pending approvals so the relay/app sees a final state.
  for (const [id] of pendingApprovals) sendApprovalResolve(id, "decline");
  process.exit(code ?? 1);
});

await codex.initialize({ name: "aight-codex-plugin", version: "0.1.0" });

try {
  const result = await codex.startThread({
    cwd: process.cwd(),
    approvalPolicy: "never",
    sandbox: "workspace_write",
  });
  threadId = result.thread.id;
  console.error(`[aight-codex] thread started: ${threadId}`);
} catch (err) {
  console.error(
    `[aight-codex] Failed to start codex thread. ` +
      `Make sure you're signed in: \`codex login\``,
  );
  console.error(err);
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
      relay.send({ type: "typing", timestamp: new Date().toISOString() });
      break;
    }
    case "turn/completed": {
      activeTurnId = null;
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
        | { id?: string; type?: string; status?: string }
        | undefined;
      if (!item) break;
      if (item.type === "agentMessage") {
        const text = pendingAgentText.get(String(item.id)) ?? "";
        pendingAgentText.delete(String(item.id));
        if (text.trim()) {
          relay.send({
            type: "reply",
            id: `codex_${++messageCounter}`,
            replyTo: null,
            content: text,
            sender: {
              id: "codex",
              name: "Codex",
              emoji: "\u{1F9E0}",
              username: "codex",
            },
            timestamp: new Date().toISOString(),
          });
        }
      } else if (
        item.type === "commandExecution" ||
        item.type === "fileChange" ||
        item.type === "mcpToolCall"
      ) {
        relay.send({
          type: "tool_event",
          event: item.status === "failed" ? "error" : "end",
          tool: item.type,
          timestamp: new Date().toISOString(),
        });
      }
      break;
    }
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval": {
      // Forward outside-cwd / network / shell-escalation requests to the app.
      // Inside-cwd cases are already auto-approved by approvalPolicy:"never"
      // + sandbox:"workspace_write" — the ones that reach this branch are
      // genuinely sensitive.
      const item = p.item as
        | { id?: string; details?: Record<string, unknown> }
        | undefined;
      if (!item?.id) break;
      const kind: "command" | "fileChange" | "network" =
        method.includes("commandExecution") ? "command" : "fileChange";
      const summary = summarizeApproval(item, kind);
      const approvalId = `approval_${item.id}`;
      relay.send({
        type: "approval_request",
        id: approvalId,
        approvalKind: kind,
        approvalSummary: summary,
        approvalDetails: JSON.stringify(item.details ?? {}, null, 2).slice(0, 1024),
        outsideWorkspace: true,
        timestamp: new Date().toISOString(),
      });
      // Wait up to 60s; if no response, decline.
      const timeoutHandle = setTimeout(() => {
        if (pendingApprovals.has(approvalId)) {
          console.error(`[aight-codex] approval ${approvalId} expired — declining`);
          sendApprovalResolve(approvalId, "decline");
        }
      }, 60_000);
      pendingApprovals.set(approvalId, {
        resolve: (decision) => sendApprovalResolve(approvalId, decision),
        timeoutHandle,
      });
      break;
    }
  }
});

function sendApprovalResolve(approvalId: string, decision: "accept" | "decline") {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) return;
  clearTimeout(pending.timeoutHandle);
  pendingApprovals.delete(approvalId);
  // NOTE: pin this method name + payload via `codex app-server generate-ts`
  // before shipping. Docs hint at `serverRequest/resolve` but the exact name
  // may differ by Codex CLI version.
  codex
    .request("serverRequest/resolve", {
      requestId: approvalId.replace(/^approval_/, ""),
      decision,
    })
    .catch((err: unknown) => {
      console.error(`[aight-codex] approval resolve failed: ${err}`);
    });
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

function summarizeApproval(
  item: { details?: Record<string, unknown> },
  kind: "command" | "fileChange" | "network",
): string {
  const d = item.details ?? {};
  if (kind === "command") {
    const cmd = d.command as string[] | string | undefined;
    if (Array.isArray(cmd)) return cmd.join(" ");
    if (typeof cmd === "string") return cmd;
  }
  if (kind === "fileChange") {
    const path = d.path as string | undefined;
    if (path) return `Edit ${path}`;
  }
  return kind;
}

// ─── Relay → Codex ──────────────────────────────────────────────────────────

function saveAttachment(att: InboundAttachment): string {
  const ts = Date.now();
  const safeName = sanitizeFileName(att.fileName);
  const filePath = join(INBOX_DIR, `${ts}-${safeName}`);
  const buffer = Buffer.from(att.content, "base64");
  writeFileSync(filePath, buffer, { mode: 0o600 });
  return filePath;
}

async function handleInboundMessage(data: InboundMessage): Promise<void> {
  if (!threadId) return;

  // Approval response from app — resolve the pending Codex request.
  if (
    (data as { type?: string }).type === "approval_response" &&
    (data as { id?: string; decision?: "accept" | "decline" }).id
  ) {
    const d = data as { id: string; decision: "accept" | "decline" };
    const pending = pendingApprovals.get(d.id);
    if (pending) pending.resolve(d.decision);
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
    console.error(`[aight-codex-relay] state: ${state}`);
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
  for (const [id] of pendingApprovals) sendApprovalResolve(id, "decline");
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
void LIMITS;
void readFileSync;
void statSync;
void basename;
void extname;

console.error(`[aight-codex] Connecting to relay at ${RELAY_URL}`);
await relay.start();
