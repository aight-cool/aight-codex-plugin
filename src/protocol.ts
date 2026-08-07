/**
 * Typed WebSocket message protocol for the aight channel.
 *
 * All messages between plugin ↔ relay ↔ app are defined here
 * as discriminated unions for type safety.
 */

// ── Inbound: App → Plugin (via relay) ──

export interface AppMessage {
  type: "message";
  id: string;
  content: string;
  sender: { name?: string; device?: string };
  attachments?: InboundAttachment[];
}

export interface AppPing {
  type: "ping";
}

export interface AppRequestSkills {
  type: "request_skills";
}

// ── Inbound: Relay control → Plugin ──

export interface RelayPaired {
  type: "paired";
}

export interface RelayPartnerConnected {
  type: "partner_connected";
  timestamp?: string;
}

export interface RelayPartnerDisconnected {
  type: "partner_disconnected";
  timestamp?: string;
}

export interface RelayWaitingForPair {
  type: "waiting_for_pair";
}

export interface RelayPong {
  type: "pong";
}

export interface RelayReconnected {
  type: "reconnected";
  partnerConnected: boolean;
}

export interface RelayAuthRequired {
  type: "auth_required";
}

/** Codex-specific: phone responds to a pending approval request. */
export interface AppApprovalResponse {
  type: "approval_response";
  id: string;
  decision: "accept" | "decline";
}

/** All possible inbound messages the plugin can receive */
export type InboundMessage =
  | AppMessage
  | AppPing
  | AppRequestSkills
  | AppApprovalResponse
  | RelayPaired
  | RelayPartnerConnected
  | RelayPartnerDisconnected
  | RelayWaitingForPair
  | RelayPong
  | RelayReconnected
  | RelayAuthRequired;

// ── Outbound: Plugin → App (via relay) ──

export interface OutboundReply {
  type: "reply";
  id: string;
  replyTo: string | null;
  content: string;
  sender: { id: string; name: string; emoji: string; username: string };
  attachments?: OutboundAttachment[];
  timestamp: string;
}

export interface OutboundReaction {
  type: "reaction";
  emoji: string;
  messageId: string;
  timestamp: string;
}

export interface OutboundAck {
  type: "ack";
  messageId: string;
  timestamp: string;
}

export interface OutboundTyping {
  type: "typing";
  timestamp: string;
}

export interface OutboundConnected {
  type: "connected";
  channelName: string;
  timestamp: string;
}

export interface OutboundToolEvent {
  type: "tool_event";
  event: "start" | "end" | "error" | "subagent_start" | "subagent_end";
  tool: string;
  /** Required for "start" events; "end"/"error" omit it. */
  input?: string;
  result?: string;
  error?: string;
  timestamp: string;
}

export interface OutboundAssistantMessage {
  type: "assistant_message";
  content: string;
  timestamp: string;
}

export interface OutboundTurnEvent {
  type: "turn_event";
  event: "started" | "ended";
  timestamp: string;
}

/** Codex-specific: forward an approval request to the phone for accept/deny. */
export interface OutboundApprovalRequest {
  type: "approval_request";
  id: string;
  approvalKind: "command" | "fileChange" | "network";
  approvalSummary: string;
  approvalDetails?: string;
  outsideWorkspace?: boolean;
  timestamp: string;
}

export interface OutboundSkillsList {
  type: "skills_list";
  skills: Array<{ name: string; description: string; source: string }>;
  timestamp: string;
}

export interface OutboundAskUserQuestion {
  type: "ask_user_question";
  questionId: string;
  questions: Array<{
    header: string;
    question: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
  timestamp: string;
}

export interface OutboundPing {
  type: "ping";
}

export interface OutboundPong {
  type: "pong";
  timestamp: string;
}

export interface OutboundAuth {
  type: "auth";
  token: string;
}

export type OutboundMessage =
  | OutboundReply
  | OutboundReaction
  | OutboundAck
  | OutboundTyping
  | OutboundConnected
  | OutboundToolEvent
  | OutboundAssistantMessage
  | OutboundTurnEvent
  | OutboundSkillsList
  | OutboundPing
  | OutboundPong
  | OutboundAuth
  | OutboundApprovalRequest
  | OutboundAskUserQuestion;

// ── Shared types ──

export interface InboundAttachment {
  fileName: string;
  mimeType: string;
  content: string; // base64
}

export interface OutboundAttachment {
  fileName: string;
  mimeType: string;
  data: string; // base64
}

export interface RelaySession {
  code: string;
  sessionToken: string;
  sessionId: string;
}

// ── Limits ──

export const LIMITS = {
  /** Max inbound message size in bytes (1MB) */
  MAX_MESSAGE_SIZE: 1_048_576,
  /** Max inbound message content length in chars */
  MAX_CONTENT_LENGTH: 51_200,
  /** Max single attachment size in bytes (10MB) */
  MAX_ATTACHMENT_SIZE: 10_485_760,
  /** Max outbound file size in bytes (25MB) */
  MAX_OUTBOUND_FILE_SIZE: 26_214_400,
  /** Max attachments per message */
  MAX_ATTACHMENTS_PER_MESSAGE: 10,
  /** Max sender name/device length */
  MAX_SENDER_FIELD_LENGTH: 200,
  /** Max messages per minute (rate limit) */
  MAX_MESSAGES_PER_MINUTE: 30,
  /** Max total inbox size in bytes (500MB) */
  MAX_INBOX_SIZE: 524_288_000,
} as const;

// ── Validation ──

/**
 * Validate an inbound message has the expected shape.
 * Returns null if invalid, the typed message if valid.
 */
export function parseInboundMessage(raw: unknown): InboundMessage | null {
  if (typeof raw !== "object" || raw === null || !("type" in raw)) return null;
  const msg = raw as Record<string, unknown>;

  switch (msg.type) {
    case "message": {
      if (typeof msg.content !== "string") return null;
      if (typeof msg.id !== "string") return null;
      if (msg.content.length > LIMITS.MAX_CONTENT_LENGTH) return null;

      const sender = msg.sender as Record<string, unknown> | undefined;
      if (sender) {
        if (sender.name && typeof sender.name === "string" && sender.name.length > LIMITS.MAX_SENDER_FIELD_LENGTH) return null;
        if (sender.device && typeof sender.device === "string" && sender.device.length > LIMITS.MAX_SENDER_FIELD_LENGTH) return null;
      }

      // Validate attachments if present
      if (msg.attachments !== undefined) {
        if (!Array.isArray(msg.attachments)) return null;
        if (msg.attachments.length > LIMITS.MAX_ATTACHMENTS_PER_MESSAGE) return null;
        for (const att of msg.attachments) {
          if (typeof att.fileName !== "string" || typeof att.mimeType !== "string" || typeof att.content !== "string") return null;
          // Base64 size ≈ 4/3 of binary size
          const estimatedSize = (att.content.length * 3) / 4;
          if (estimatedSize > LIMITS.MAX_ATTACHMENT_SIZE) return null;
        }
      }

      return msg as unknown as AppMessage;
    }
    case "ping":
      return { type: "ping" };
    case "request_skills":
      return { type: "request_skills" };
    case "paired":
      return { type: "paired" };
    case "partner_connected":
      return msg as unknown as RelayPartnerConnected;
    case "partner_disconnected":
      return msg as unknown as RelayPartnerDisconnected;
    case "waiting_for_pair":
      return { type: "waiting_for_pair" };
    case "pong":
      return { type: "pong" };
    case "reconnected":
      return msg as unknown as RelayReconnected;
    case "auth_required":
      return { type: "auth_required" };
    case "approval_response": {
      if (typeof msg.id !== "string") return null;
      if (msg.decision !== "accept" && msg.decision !== "decline") return null;
      return msg as unknown as AppApprovalResponse;
    }
    default:
      return null;
  }
}
