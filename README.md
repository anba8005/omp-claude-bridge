# omp-claude-bridge

[![npm version](https://img.shields.io/npm/v/@thealtoclef/omp-claude-bridge)](https://www.npmjs.com/package/@thealtoclef/omp-claude-bridge)

[omp](https://github.com/can1357/oh-my-pi) extension that integrates Claude Code via the [Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). It is a port of [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) by Eli Dickinson (from its 0.8.0 release) to omp's provider contract; all the streaming, MCP tool bridging, session sync and resume machinery is upstream's.

1. **Provider** — Use Claude Opus, Sonnet and Haiku as models in omp, with all tool calls flowing through omp's TUI
2. **AskClaude tool** — Delegate tasks or questions to Claude Code when using another provider

**Using pi rather than omp?** Install upstream [`pi-claude-bridge`](https://www.npmjs.com/package/pi-claude-bridge). This package registers only an `omp` entry and follows omp's system-prompt, message and event shapes.

**Subscription terms.** The bridge drives an unmodified Claude Code (`claude -p` through the Agent SDK) logged in with your own Claude subscription, which Anthropic support confirmed is permitted ([pi-claude-bridge#118](https://github.com/elidickinson/pi-claude-bridge/issues/118)). It does not use omp's own Anthropic OAuth login. Anthropic has [announced and then unannounced](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) a billing change for Agent SDK tools; it currently uses your regular subscription quota just like Claude Code.

<p>
<a href="assets/claude-bridge1.png"><img src="assets/claude-bridge1.png" width="49%"></a>&nbsp;
<a href="assets/claude-bridge2.png"><img src="assets/claude-bridge2.png" width="49%"></a>
</p>

## Install

```
omp plugin install @thealtoclef/omp-claude-bridge
```

Verified against omp 18.8.9. Claude Code must be logged in (`claude` → `/login`) with your subscription.

## Provider

Use `/model` to select `claude-bridge/opus`, `claude-bridge/sonnet` or `claude-bridge/haiku`. These are Claude Code's [model aliases](https://code.claude.com/docs/en/model-config#model-aliases), passed to it as-is: Claude Code resolves each to the newest model of its family (today Opus 5.5, Sonnet 5.5 and Haiku 5.5), so a new model arrives when Claude Code moves the alias, with no bridge or omp update. To pin a version, set Claude Code's `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL` or `ANTHROPIC_DEFAULT_HAIKU_MODEL` for the omp process.

Behind the scenes, omp's tools are bridged to Claude Code over MCP, but it should all work like normal in omp. Bash commands get a 120-second default timeout (matching Claude Code's default). Steering works mid-turn: a message sent while Claude is running a tool reaches it at that tool boundary, not after the whole turn finishes.

**Context and thinking:** the aliased models run with a 1M context window by default (no `[1m]` suffix needed) and 128K output, and take every Claude Code effort level: low, medium, high, xhigh and max. The thinking level you pick in omp is sent as Claude Code's effort; omp's minimal is sent as low.

### What Claude Code sees of omp's system prompt

Claude Code keeps its own `claude_code` system prompt; omp's prompt is appended to it, block by block:

- **omp's harness block** (the "You are omp's trusted coding assistant" template) is not forwarded — it describes omp's own tool loop. Only its `<skills>`, `<generic-rules>` and `<domain-rules>` sections are carried over. Skills and domain rules are listed with an instruction to read `skill://<name>` / `rule://<name>` through the bridged `read` tool, and are left out when `read` is not available.
- **Everything else is forwarded verbatim**: the `<project-context>` block (your `AGENTS.md`/`CLAUDE.md` context files, workstation, workspace roots), blocks other extensions add in `before_agent_start`, and a custom system prompt if you set one.

### Summaries, `/clear`, and session switches

- omp's one-off summary requests — compaction, branch summaries, handoff — run in a separate, isolated Claude Code process with omp's summarization prompt, so they never enter the shared Claude Code session.
- After `/clear`, the next turn rebuilds the Claude Code session from what omp still has, rather than resuming the cleared conversation.
- Switching, resuming, forking or branching a session drops the shared Claude Code session, and the next turn rebuilds or resumes it from omp's history.

## AskClaude Tool

Opt-in: set `askClaude.enabled` to `true` (see [Configuration](#configuration)). Available when using any non-claude-bridge provider. omp's model can delegate tasks to Claude Code and wait for it to answer a question or perform a task. Examples of how to use:

- "Ask Claude to plan a fix"
- "If you get stuck, ask claude for help"
- "Ask claude to review the plan in @foo.md, implement it, then ask an isolated=true claude to review the implementation"
- "Find all the places in the codebase that handle auth"

Delegated calls are isolated from your `~/.claude` estate: children don't read global `CLAUDE.md` files or Claude Code's skill listing, get no omp skills, and always get Claude Code's own system prompt preset.

### Parameters

- **`prompt`** — the question or task for Claude Code
- **`mode`** — `read` (default, read files and search/fetch on web), `none`, or `full` (read+write+bash, disable this mode with `allowFullMode: false` in config)
- **`model`** — `opus` (default), `sonnet`, `haiku`, or a full model ID; passed to Claude Code as-is
- **`thinking`** — effort level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`
- **`isolated`** — when `true`, Claude gets a clean session with no conversation history (default: `false`)

## Configuration

Config: `~/.omp/agent/claude-bridge.json` (global) or `.omp/claude-bridge.json` in the project (merged over global).

```json
{
  "askClaude": {
    "enabled": true,
    "allowFullMode": true,
    "defaultIsolated": false,
    "description": "Custom tool description override"
  },
  "provider": {
    "strictMcpConfig": true,
    "pathToClaudeCodeExecutable": "/home/you/.nix-profile/bin/claude"
  }
}
```

`askClaude`:
- `enabled` — register the AskClaude tool (default `false`). If it's unset, the startup notice below points this out once.
- `name` — override the tool's omp-side name (default `"AskClaude"`)
- `label` — override the TUI label (default `"Ask Claude Code"`)
- `description` — override the tool description
- `defaultMode` — `"read"` (default), `"none"`, or `"full"`
- `defaultIsolated` — start each call in a fresh session (default `false`)
- `allowFullMode` — allow `mode: "full"`; set `false` to lock it out

`provider`:
- `strictMcpConfig` — block MCP servers from `~/.claude.json` / `.mcp.json` (default `true`). Cloud MCP (Gmail/Drive via claude.ai OAuth) is always blocked.
- `autoMemoryEnabled` — enable Claude Code's auto-memory system (default `false`)
- `pathToClaudeCodeExecutable` — path to the `claude` binary. Useful if your OS/filesystem has the SDK's bundled musl/glibc binaries in a place where they can't run (e.g. Nix: `"/home/you/.nix-profile/bin/claude"`).

**Startup notice:** the first interactive session to reach Claude Code points out that `askClaude.enabled` is unset, then records `startupNoticeShown` (the date, `YYYY-MM-DD`) in the global config so it doesn't nag again.

## Tests

- `npm run test:unit` — offline tests (`tests/unit-*.mjs`).
- `node tests/omp-smoke.mjs` — loads the extension in your installed omp and checks the registered models. Makes no model call.
- `npm test` — upstream's integration suite (`tests/int-*.{sh,mjs}`). It drives `pi`, not omp, and makes real Claude Code calls, so it does not validate this port; it is kept for upstream merges.

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` to enable debug output:

- **Bridge log** at `~/.omp/agent/claude-bridge.log` — every provider call (with the system-prompt blocks received and the size of what was appended), session sync decision, tool result delivery, and CC's stderr. Override location with `CLAUDE_BRIDGE_DEBUG_PATH`.
- **Per-query Claude Code CLI logs** at `~/.omp/agent/cc-cli-logs/<timestamp>-<tag>-<seq>.log` — the CC subprocess's own debug stream, one file per `query()` call.

## Known issues

**Sessions get rebuilt more often than they need to be, and a rebuild is expensive.** The bridge rewrites Claude Code's session from omp's history whenever the history moves underneath it — after an abort, compaction, tree navigation, `/clear`, or an API error. A rebuild usually loses the prompt cache.

**Files Claude Code edits are not carried across a rebuild.** The edit itself survives in the history as a tool call and its result; Claude loses only the post-edit file snapshot. `@file` expansions *are* carried.

**Exported Anthropic environment variables override the Claude Code child.** An `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` exported for another gateway redirects Claude Code as well, and every turn fails with that gateway's auth error. Unset them for the omp process.

## Credits

Eli Dickinson's [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge), itself based on [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) by Prateek Sunal. MIT licensed.
