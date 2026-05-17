/**
 * Relay Client — connects the plugin to the Cloudflare relay.
 *
 * Flow:
 * 1. POST /pair → new session with pairing code
 * 2. Connect to /ws/plugin?id=<sessionId>
 * 3. Send auth token as first WS message (H3: no tokens in URLs)
 * 4. Display pairing code in terminal
 * 5. App enters code → connects, messages flow
 */

import {
  type InboundMessage,
  type RelaySession,
  type OutboundMessage,
  LIMITS,
  parseInboundMessage,
} from "./protocol";

const BASE_RECONNECT_MS = 3_000;
const MAX_RECONNECT_MS = 60_000;
const PING_INTERVAL_MS = 25_000;

export type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

export interface RelayClientCallbacks {
  /** Called when a validated message arrives from the app or relay */
  onMessage: (data: InboundMessage) => void;
  /** Called when connection state changes */
  onStateChange: (state: ConnectionState) => void;
  /** Called when a pairing code is available for display */
  onPairingCode: (code: string, relayUrl: string) => void;
}

export class RelayClient {
  private relayUrl: string;
  private session: RelaySession | null = null;
  private ws: WebSocket | null = null;
  private callbacks: RelayClientCallbacks;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private intentionalClose = false;

  constructor(relayUrl: string, callbacks: RelayClientCallbacks) {
    this.relayUrl = relayUrl.replace(/\/+$/, "");
    this.callbacks = callbacks;
  }

  get sessionInfo(): RelaySession | null {
    return this.session;
  }

  async start(): Promise<void> {
    this.intentionalClose = false;
    this.reconnectAttempt = 0;
    this.callbacks.onStateChange("connecting");
    try {
      const res = await fetch(`${this.relayUrl}/pair`, { method: "POST" });
      if (!res.ok) {
        throw new Error(`Pairing request failed: ${res.status}`);
      }
      this.session = (await res.json()) as RelaySession;
      console.error(
        `[aight-relay] Session created: ${this.session.sessionId} | Code: ${this.session.code}`,
      );
      this.callbacks.onPairingCode(this.session.code, this.relayUrl);
    } catch (err) {
      console.error(`[aight-relay] Failed to create session: ${err}`);
      this.callbacks.onStateChange("error");
      this.scheduleReconnect();
      return;
    }

    this.connectWebSocket();
  }

  private closeExistingSocket(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { /* already closed */ }
      this.ws = null;
    }
  }

  private connectWebSocket(): void {
    if (!this.session) return;

    this.closeExistingSocket();

    console.error(`[aight-relay] Connecting to relay...`);
    this.callbacks.onStateChange("connecting");

    const wsBase = this.relayUrl.replace(/^http/, "ws");
    const wsUrl = `${wsBase}/ws/plugin?id=${encodeURIComponent(this.session.sessionId)}`;

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error(`[aight-relay] WebSocket creation failed: ${err}`);
      this.callbacks.onStateChange("error");
      this.scheduleReconnect();
      return;
    }

    this.ws.addEventListener("open", () => {
      console.error(`[aight-relay] WebSocket open, authenticating...`);
      // H3: send token as first message, not in URL
      this.ws!.send(
        JSON.stringify({
          type: "auth",
          token: this.session!.sessionToken,
        } satisfies OutboundMessage),
      );
      this.callbacks.onStateChange("connected");
      this.reconnectAttempt = 0;
      this.startPing();
    });

    this.ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : "";

      if (raw.length > LIMITS.MAX_MESSAGE_SIZE) {
        console.error(
          `[aight-relay] Rejected oversized message: ${raw.length} bytes (max ${LIMITS.MAX_MESSAGE_SIZE})`,
        );
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        console.error("[aight-relay] Received malformed JSON, ignoring");
        return;
      }

      const msg = parseInboundMessage(parsed);
      if (!msg) {
        console.error(`[aight-relay] Received unknown or invalid message type: ${(parsed as Record<string, unknown>)?.type}`);
        return;
      }

      // Expected relay control messages — handle silently
      if (msg.type === "auth_required") return;

      if (msg.type === "waiting_for_pair") {
        console.error(`[aight-relay] Waiting for app to pair...`);
        return;
      }

      // Paired / reconnected — notify app we're connected
      if (msg.type === "paired" || msg.type === "partner_connected") {
        console.error(`[aight-relay] ${msg.type === "paired" ? "App paired successfully!" : "App connected"}`);
        this.send({
          type: "connected",
          channelName: "aight",
          timestamp: new Date().toISOString(),
        });
        this.callbacks.onMessage(msg);
        return;
      }

      if (msg.type === "partner_disconnected") {
        console.error(`[aight-relay] App disconnected`);
        return;
      }

      if (msg.type === "pong") return;

      this.callbacks.onMessage(msg);
    });

    this.ws.addEventListener("close", () => {
      this.stopPing();
      if (!this.intentionalClose) {
        console.error(`[aight-relay] Disconnected, reconnecting...`);
        this.callbacks.onStateChange("disconnected");
        this.scheduleReconnect();
      }
    });

    this.ws.addEventListener("error", () => {
      // onclose fires after onerror — reconnection handled there
    });
  }

  send(data: OutboundMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  stop(): void {
    this.intentionalClose = true;
    this.stopPing();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.closeExistingSocket();
    this.callbacks.onStateChange("disconnected");
  }

  /** Exponential backoff: min(3s * 2^attempt, 60s) + random jitter */
  private getReconnectDelay(): number {
    const exponential = Math.min(
      BASE_RECONNECT_MS * Math.pow(2, this.reconnectAttempt),
      MAX_RECONNECT_MS,
    );
    const jitter = Math.random() * 1000;
    return exponential + jitter;
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    const delay = this.getReconnectDelay();
    this.reconnectAttempt++;
    console.error(
      `[aight-relay] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempt})`,
    );
    this.reconnectTimeout = setTimeout(() => {
      if (this.session) {
        this.connectWebSocket();
      } else {
        this.start();
      }
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" } satisfies OutboundMessage));
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}
