# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A TypeScript Slack bot that wraps the `@anthropic-ai/claude-agent-sdk`. The bot is customized as **OpenClaw SRE** — an SRE assistant for the OpenClaw platform running on the user's Mac Mini (`yunjun-mini`). The system prompt is loaded from `prompts/system-prompt.md` (overridable via `SYSTEM_PROMPT_PATH` env var) and contains detailed OpenClaw-specific runbooks, agent/workspace mappings, and red-line rules in Chinese.

## Commands

```bash
npm run dev       # Run with tsx watch (hot reload), reads .env automatically
npm start         # Run once with tsx (no hot reload)
npm run build     # Compile to dist/ via tsc
npm run prod      # Run compiled output from dist/
npm test          # Run vitest test suite
npm run test:watch # Run vitest in watch mode

# Production launcher (used by LaunchAgent):
./start.sh        # Sources .env, loads nvm, runs tsx src/index.ts
```

## Architecture

### Request flow

1. **`src/index.ts`** — boots Slack app (Socket Mode), initializes `McpManager` → `ClaudeHandler` → `SlackHandler`, sets up event handlers and graceful shutdown (SIGTERM/SIGINT).
2. **`src/slack-handler.ts`** — the main controller. Handles all Slack events: DMs, `app_mention`, file uploads, `member_joined_channel`, interactive button clicks (approve/deny). Includes per-user rate limiting and admin authorization for destructive commands.
3. **`src/claude-handler.ts`** — wraps `query()` from `@anthropic-ai/claude-agent-sdk`. Manages sessions keyed by `${userId}-${channelId}-${threadTs|'direct'}`. System prompt loaded from external file at startup.
4. **`src/permission-mcp-server.ts`** — spawned as a subprocess by Claude SDK. Posts Slack messages with Approve/Deny buttons. Uses file-based IPC (`src/permission-bridge.ts`) to receive approval decisions from the main process.

### Key data flows

**Session keying**: DMs use `userId-channelId-direct` (no thread isolation); channel threads use `userId-channelId-{threadTs}`. DMs share one continuous context; each channel thread gets its own.

**Working directory hierarchy** (`src/working-directory-manager.ts`): thread-specific > channel default > `DEFAULT_WORKING_DIRECTORY` env. Set with `cwd <path>`. If `BASE_DIRECTORY` env is set, short names resolve against it. A working directory is **required** — messages without one are rejected with guidance. No fallback to `$HOME`.

**Permission bridge** (`src/permission-bridge.ts`): File-based IPC between the main process and MCP subprocess. The subprocess writes approval requests and polls for result files; the main process writes results when Slack buttons are clicked.

**Todo tracking** (`src/todo-manager.ts`): When Claude calls `TodoWrite`, `SlackHandler` intercepts it, then posts/updates a dedicated Slack message with the formatted task list in-place.

**MCP servers** (`src/mcp-manager.ts`): Loaded from `mcp-servers.json` at startup. The `permission-prompt` MCP server is always injected when processing a Slack message.

### Shortcut commands

`SlackHandler.handleMessage()` intercepts several commands before hitting Claude:
- `!new` / `/new` — delete the current SDK session (forces fresh context)
- `!quit` / `/quit` — kill the tmux session (**admin only**, requires `ADMIN_USERS`)
- `!model [name|default]` — show or switch model (**admin only** to change)
- `!status`, `!restart`, `!logs`, `!config`, `!fix`, `!ps` — expand to canned prompts sent to Claude
- `cwd <path>` — set working directory
- `mcp [reload]` — show/reload MCP config

### Key source files

- `src/rate-limiter.ts` — sliding window per-user rate limiter
- `src/permission-bridge.ts` — file-based IPC for cross-process permission approvals
- `src/image-handler.ts` — image processing utilities
- `prompts/system-prompt.md` — externalized system prompt (Chinese, OpenClaw SRE)
- `vitest.config.ts` — test configuration (excludes dist/)

## Environment

```env
# Required
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
ANTHROPIC_API_KEY=...

# Optional
BASE_DIRECTORY=/Users/yunjun-mini/Code/   # Enables short project names in cwd
DEFAULT_WORKING_DIRECTORY=...             # Explicit default (no HOME fallback)
SYSTEM_PROMPT_PATH=...                    # Override system prompt file path
ADMIN_USERS=U123,U456                     # Comma-separated Slack user IDs for admin commands
RATE_LIMIT_PER_MINUTE=10                  # Per-user rate limit (default: 10)
DEBUG=true
```

The bot runs via `~/Library/LaunchAgents/com.yunjun.cc-slack-bot.plist` in production.
