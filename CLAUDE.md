# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A TypeScript Slack bot that wraps the `@anthropic-ai/claude-code` SDK. The bot is customized as **OpenClaw SRE** — an SRE assistant for the OpenClaw platform running on the user's Mac Mini (`yunjun-mini`). The system prompt (defined inline in `src/claude-handler.ts`) is in Chinese and contains detailed OpenClaw-specific runbooks, agent/workspace mappings, and red-line rules.

## Commands

```bash
npm run dev       # Run with tsx watch (hot reload), reads .env automatically
npm start         # Run once with tsx (no hot reload)
npm run build     # Compile to dist/ via tsc
npm run prod      # Run compiled output from dist/

# Production launcher (used by LaunchAgent):
./start.sh        # Sources .env, sets PATH, runs tsx src/index.ts
```

No test suite exists in this project.

## Architecture

### Request flow

1. **`src/index.ts`** — boots Slack app (Socket Mode), initializes `McpManager` → `ClaudeHandler` → `SlackHandler`, then calls `setupEventHandlers()`.
2. **`src/slack-handler.ts`** — the main controller. Handles all Slack events: DMs, `app_mention`, file uploads, `member_joined_channel`, interactive button clicks (approve/deny). Dispatches to `ClaudeHandler.streamQuery()` and formats responses back to Slack.
3. **`src/claude-handler.ts`** — wraps `query()` from `@anthropic-ai/claude-code`. Manages sessions keyed by `${userId}-${channelId}-${threadTs|'direct'}`. Each call to `streamQuery()` yields `SDKMessage` events. Session IDs from the SDK's `system/init` message are stored so subsequent calls use `options.resume`.
4. **`src/permission-mcp-server.ts`** — an in-process MCP server (also spawnable as a child process) that implements `permission_prompt`. When Claude wants to execute a tool, it can call this to post an interactive Slack message with Approve/Deny buttons. `SlackHandler` wires up the button clicks to `permissionServer.resolveApproval()`.

### Key data flows

**Session keying**: DMs use `userId-channelId-direct` (no thread isolation); channel threads use `userId-channelId-{threadTs}`. This means DMs share one continuous context, while each channel thread gets its own.

**Working directory hierarchy** (`src/working-directory-manager.ts`): thread-specific > channel default > DM-specific. Set with `cwd <path>`. If `BASE_DIRECTORY` env is set, short names resolve against it. A working directory is **required** — messages without one are rejected with guidance.

**Todo tracking** (`src/todo-manager.ts`): When Claude calls `TodoWrite`, `SlackHandler` intercepts it (returns empty string to suppress the tool message), then posts/updates a dedicated Slack message with the formatted task list. This message is updated in-place via `chat.update` rather than spamming new messages.

**MCP servers** (`src/mcp-manager.ts`): Loaded from `mcp-servers.json` at startup. All MCP tools allowed by default via `mcp__serverName` pattern. The `permission-prompt` MCP server is always injected when processing a Slack message (it needs `SLACK_CONTEXT` env to post buttons to the right channel/thread).

### Shortcut commands

`SlackHandler.handleMessage()` intercepts several commands before hitting Claude:
- `!new` / `/new` — delete the current SDK session (forces fresh context)
- `!quit` / `/quit` — kill the tmux session (stops the bot)  
- `!model [name|default]` — show or switch the model used in `ClaudeHandler`
- `!status`, `!restart`, `!logs`, `!config`, `!fix`, `!ps` — expand to canned prompts sent to Claude
- `cwd <path>` — set working directory (handled by `WorkingDirectoryManager`, not Claude)
- `mcp [reload]` — show/reload MCP config (handled locally, not Claude)

### Files not in the original README

- `src/image-handler.ts` — separate image processing utilities
- `src/permission-mcp-server.ts` — interactive permission prompts via Slack buttons
- `src/permission-server-start.js` — standalone entrypoint to run the permission MCP server as a subprocess
- `src/slack-handler.ts.bak` — stale backup, safe to ignore
- `slack-app-manifest.json` / `slack-app-manifest.yaml` — Slack app configuration for creating/updating the app

## Environment

```env
# Required
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
ANTHROPIC_API_KEY=...

# Optional
BASE_DIRECTORY=/Users/yunjun-mini/Code/   # Enables short project names in cwd
DEBUG=true
```

The bot runs via `~/Library/LaunchAgents/com.yunjun.cc-slack-bot.plist` in production.
