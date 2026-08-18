# MagPi ACP

A customized [Agent Client Protocol](https://agentclientprotocol.com) adapter for the [Pi coding agent](https://github.com/earendil-works/pi-mono), designed for use with stock [Zed](https://zed.dev).

```text
Zed → magpi-acp → Pi RPC → selected model
```

The adapter speaks ACP JSON-RPC over stdio and runs Pi in `--mode rpc`. 
## Features

- Streams assistant text and thought output into native ACP content.
- Maps Pi tools to ACP tool calls with status, file locations, structured diffs, and terminal output.
- Reports context usage and cost to Zed.
- Lists, loads, and resumes Pi sessions stored under `~/.pi/agent/sessions`.
- Loads Pi skills and file-based prompt commands.
- Shows Pi startup information in Zed.
- Exposes controls in this order: **Role**, **Model**, **Thinking**.
- Switches model and thinking level together through named roles in `~/.pi/agent/roles.json`.
- Translates [`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo) results into Zed's native plan card and restores plans when sessions reload.
- Maps Pi extension select, confirm, input, and editor requests to ACP elicitation.
- Generates a 2–6 word title from the first user message using the active model in an isolated no-session call.
- Supports persistent manual titles with `/name <title>`.
- Provides `/tree` navigation and rewind through a bundled Pi extension.

## Requirements

- macOS with [Homebrew](https://brew.sh)
- Node.js 22+
- Pi available on `PATH`
- Access to this private repository
- Model authentication configured in Pi

## Install

```sh
brew install git gh node
```

```sh
brew install --cask zed
```

```sh
gh auth login
```

```sh
npm install -g @earendil-works/pi-coding-agent
```

```sh
git clone git@github.com:kylehumphrey-ao/magpi-acp.git
```

```sh
cd magpi-acp && npm ci && npm test && npm run build
```

## Pi extensions used by MagPi ACP

Install todo support for native Zed plan cards:

```sh
pi install npm:@juicesharp/rpiv-todo
```

Install structured user prompts for ACP elicitation:

```sh
pi install npm:pi-ask-user
```

## Roles

Create `~/.pi/agent/roles.json`:

```json
{
  "Plan": {
    "model": "openai-codex/gpt-5.6-sol",
    "thinkingLevel": "max"
  },
  "Build": {
    "model": "openai-codex/gpt-5.6-terra",
    "thinkingLevel": "high"
  },
  "Fast": {
    "model": "openai-codex/gpt-5.6-luna",
    "thinkingLevel": "medium"
  }
}
```

JSON key order controls cycling order. In Zed, `shift-tab` cycles roles through `agent::CycleModeSelector`. Selecting a role calls Pi's `set_model` and `set_thinking_level` RPC commands.

## Zed configuration

Add the adapter to `~/.config/zed/settings.json`, replacing the absolute path:

```json
{
  "agent_servers": {
    "magpi-acp": {
      "type": "custom",
      "command": "node",
      "args": ["/absolute/path/to/magpi-acp/dist/index.js"],
      "env": {},
      "default_config_options": {
        "role": "Build",
        "model": "openai-codex/gpt-5.6-terra",
        "thought_level": "high"
      }
    }
  }
}
```

Open a new `magpi-acp` thread after rebuilding the adapter or changing roles.

## Commands

### File-based commands

- User commands: `~/.pi/agent/prompts/**/*.md`
- Project commands: `<cwd>/.pi/prompts/**/*.md`

### Adapter commands

- `/compact [instructions...]` — compact the current session.
- `/autocompact on|off|toggle` — configure automatic compaction.
- `/export` — export the session to HTML.
- `/session` — show session, message, token, and cost statistics.
- `/name <title>` — persist a manual session title and update Zed.
- `/steering all|one-at-a-time` — read or set Pi steering delivery.
- `/follow-up all|one-at-a-time` — read or set Pi follow-up delivery.
- `/changelog` — show Pi's changelog.
- `/tree` — choose an earlier user message and continue from it.

Skill commands are exposed when enabled in Pi settings. Pi extension commands are not advertised as ACP slash commands.

## Configuration

Set `quietStartup: true` in `~/.pi/agent/settings.json` or `<project>/.pi/settings.json` to suppress startup details. Update notices remain visible.

Set `MAGPI_ACP_ENABLE_EMBEDDED_CONTEXT=true` in the Zed agent's `env` object to advertise embedded ACP resources. Without it, embedded resources degrade to plain-text context.

## Authentication

Configure model providers through Pi. For terminal-based authentication:

```sh
node dist/index.js --terminal-login
```

## Development

```sh
npm run dev
```

```sh
npm test
```

```sh
npm run typecheck
```

```sh
npm run lint
```

```sh
npm run build
```

Project layout:

- `src/acp` — ACP server and translation layer.
- `src/pi-rpc` — Pi subprocess and RPC protocol wrapper.
- `src/pi-extension` — bundled Pi extensions used by the adapter.
- `test` — unit and component tests.
- [`docs/SETUP-HANDOFF.md`](docs/SETUP-HANDOFF.md) — complete developer setup and workflow handoff.

## Limitations

- Pi reads, writes, and executes locally; ACP filesystem and terminal delegation are not implemented.
- MCP servers supplied by the ACP client are retained in session state but not forwarded to Pi.
- UI-only Pi extensions require ACP translation to render natively in Zed.

##Attributution

It is independently versioned from [`svkozak/pi-acp`](https://github.com/svkozak/pi-acp), the upstream project from which it was derived. The npm package and executable are named `magpi-acp`.


## License

MIT — see [LICENSE](LICENSE).
