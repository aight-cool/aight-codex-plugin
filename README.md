# aight-codex

Chat with your [OpenAI Codex CLI](https://developers.openai.com/codex/cli) session from your phone — works from anywhere.

```
┌──────────────┐  JSON-RPC/stdio ┌─────────────────┐
│ codex        │◄───────────────►│ aight-codex     │
│ app-server   │                 │ Plugin (Bun)    │
└──────────────┘                 └────────┬────────┘
                                          │ WSS
                                          ▼
                                 ┌─────────────────┐
                                 │ Channel Relay   │
                                 │ (channels.…)    │
                                 └────────┬────────┘
                                          │ WSS
                                          ▼
                                 ┌─────────────────┐
                                 │ Aight App       │
                                 │ (iPhone/Android)│
                                 └─────────────────┘
```

The wrapper spawns `codex app-server` as a subprocess and drives it over JSON-RPC. Bidirectional message flow with the same `channels.aight.cool` relay that powers the Claude Code channel — the wire protocol is the same, so the Aight app treats codex channels identically (with a different sender icon).

## Install — 30 seconds

**Prerequisites:** [Bun](https://bun.sh), [Codex CLI](https://developers.openai.com/codex/cli) (`npm i -g @openai/codex`), and the [Aight iOS app](https://aight.cool).

```bash
git clone https://github.com/aight-cool/aight-codex-plugin ~/.codex/channels/aight \
  && ~/.codex/channels/aight/setup
```

Then in your project directory:

```bash
aight-codex
```

A 6-digit pairing code appears in the terminal. Enter it in the Aight app under Settings → Codex CLI.

To run with the same unrestricted permissions as `codex --yolo`:

```bash
aight-codex --yolo
```

## How it works

1. `aight-codex` spawns `codex app-server` as a child process
2. The plugin connects outbound to `channels.aight.cool` via WSS and gets a 6-digit pairing code
3. You enter the code in the Aight app — pair complete
4. Messages from the app become `turn/start` (or `turn/steer`) RPC calls into Codex
5. Codex agent output streams back as `item/agentMessage/delta` notifications; on completion, the plugin sends a `reply` over the relay

### Approval policy

Codex runs with `approvalPolicy: "on-request"` and `sandbox: "workspace-write"` by default — any operation *inside* the current working directory is auto-approved silently. Anything that escapes the workspace (network access, shell escalation, files outside cwd) is forwarded to the Aight app as an `approval_request`. You tap Approve or Deny on the phone. If you don't respond within 60 seconds, the request auto-declines.

`--yolo` (or `--dangerously-bypass-approvals-and-sandbox`) changes the app-server thread to `approvalPolicy: "never"` and `sandbox: "danger-full-access"`, matching Codex CLI's unrestricted mode. Use it only in a workspace you trust.

### Trust model

The plugin authenticates to the relay over WSS (TLS-protected transport), but there is no end-to-end MAC between the phone and the plugin: any message that arrives on the post-pair WebSocket is treated as having come from the paired phone. The relay (`channels.aight.cool`) is therefore part of your trust base — a compromised relay could inject `turn/start` text into your Codex session (constrained by the default `workspace-write` sandbox, but unrestricted under `--yolo`). End-to-end signed messages under a key derived at pair time are on the roadmap.

## Environment

| Variable                  | Description                                           | Default                          |
| ------------------------- | ----------------------------------------------------- | -------------------------------- |
| `AIGHT_RELAY_URL`         | Custom relay server URL                               | `https://channels.aight.cool`    |
| `CODEX_BIN`               | Path to the codex binary                              | `codex` (from PATH)              |

## Status

Early. The exact JSON-RPC method names for resolving approval requests need pinning against `codex app-server generate-ts` output before this is fully reliable. Treat as beta.

## License

Apache-2.0
