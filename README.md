# MagPi ACP

An [Agent Client Protocol](https://agentclientprotocol.com) adapter for the [Pi coding agent](https://github.com/earendil-works/pi-mono).

```text
ACP client → magpi-acp → Pi RPC → selected model
```

MagPi ACP speaks ACP JSON-RPC over stdio and runs Pi in `--mode rpc`.

## Features

- Streams assistant text and thought output as ACP content.
- Maps Pi tools to ACP tool calls with status, file locations, structured diffs, and terminal output.
- Reports context usage and cost.
- Lists, loads, and resumes Pi sessions stored under `~/.pi/agent/sessions`.
- Loads Pi skills and file-based prompt commands.
- Exposes native ACP role, model, and thinking controls.
- Switches model and thinking level together through named roles in `~/.pi/agent/roles.json`.
- Translates [`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo) results into ACP plan updates and restores plans when sessions reload.
- Maps Pi extension select, confirm, input, and editor requests to ACP elicitation.
- Generates a 2–6 word session title from the first user message using the active model in an isolated no-session call.
- Supports persistent manual titles with `/name <title>`.
- Provides `/tree` navigation and rewind through Pi's native session tree.
- Advertises ACP Terminal Auth for interactive Pi provider setup.

## Requirements

- Node.js 20+
- Pi installed and available on `PATH`
- A model provider configured through Pi

## Install from GitHub

Install Pi first:

```sh
npm install -g @earendil-works/pi-coding-agent
```

Clone and build MagPi ACP:

```sh
git clone https://github.com/kylehumphrey-ao/magpi-acp.git
```

```sh
cd magpi-acp && npm ci && npm test && npm run build
```

## ACP client configuration

Configure your ACP client to launch the built stdio process, replacing the absolute path:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/magpi-acp/dist/index.js"]
}
```

The exact configuration format depends on the client.

## Update

Pull, install any dependency changes, and rebuild:

```sh
cd /absolute/path/to/magpi-acp && git pull --ff-only && npm ci && npm run build
```

Source changes are not hot-reloaded. Restart the ACP agent process or open a new session after rebuilding.

## Optional Pi extensions

Install todo support for ACP plan updates:

```sh
pi install npm:@juicesharp/rpiv-todo
```

Install structured prompts for ACP elicitation:

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

JSON key order controls role order. Selecting a role calls Pi's `set_model` and `set_thinking_level` RPC commands. Models shown above are examples; use provider and model IDs available in your Pi installation.

## Commands

### File-based commands

- User commands: `~/.pi/agent/prompts/**/*.md`
- Project commands: `<cwd>/.pi/prompts/**/*.md`

### Adapter commands

- `/compact [instructions...]` — compact the current session.
- `/autocompact on|off|toggle` — configure automatic compaction.
- `/export` — export the session to HTML.
- `/session` — show session, message, token, and cost statistics.
- `/name <title>` — persist a manual session title.
- `/steering all|one-at-a-time` — read or set Pi steering delivery.
- `/follow-up all|one-at-a-time` — read or set Pi follow-up delivery.
- `/changelog` — show Pi's changelog.
- `/tree` — choose an earlier Pi session entry and continue from it.

Skill commands are exposed when enabled in Pi settings. Pi extension commands are not advertised as ACP slash commands.

## Configuration

Set `quietStartup: true` in `~/.pi/agent/settings.json` or `<project>/.pi/settings.json` to suppress startup details. Update notices remain visible.

Set `MAGPI_ACP_ENABLE_EMBEDDED_CONTEXT=true` in the agent process environment to advertise embedded ACP resources. Without it, embedded resources degrade to plain-text context.

Set `MAGPI_ACP_PI_COMMAND` to override the `pi` executable path.

## Authentication

MagPi ACP advertises Terminal Auth in its ACP initialize response. To configure Pi interactively:

```sh
node /absolute/path/to/magpi-acp/dist/index.js --terminal-login
```

Credentials remain managed by Pi and are not stored by MagPi ACP.

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

## Compatibility

MagPi ACP uses standard ACP behavior where available. Optional `_meta` capabilities provide enhancements for clients that recognize them and are safe for other clients to ignore.

## Limitations

- Pi reads, writes, and executes locally; ACP filesystem and terminal delegation are not implemented.
- MCP servers supplied by the ACP client are retained in session state but not forwarded to Pi.
- UI-only Pi extensions require ACP translation to render through an ACP client.

## Attribution

MagPi ACP is independently versioned from [`svkozak/pi-acp`](https://github.com/svkozak/pi-acp), the upstream project from which it was derived.

## License

MIT — see [LICENSE](LICENSE).
