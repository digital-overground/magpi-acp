# MagPi ACP

An [Agent Client Protocol](https://agentclientprotocol.com) adapter for the [Pi coding agent](https://github.com/earendil-works/pi-mono).

```text
ACP client → MagPi ACP → Pi RPC → selected model
```

MagPi ACP speaks ACP v1 JSON-RPC over stdio and runs Pi in `--mode rpc`. It works with ACP-compliant clients and integrations for editors such as Zed, VS Code, Sublime Text, and others.

## ACP support

MagPi exposes standard ACP behavior for:

- creating, prompting, cancelling, listing, loading, and current-leaf forking of sessions;
- streaming messages, thoughts, tool calls, plans, usage, and structured diffs;
- model, thinking-level, and role configuration through session configuration options;
- form elicitation for compatible Pi extension prompts;
- Pi extension, skill, and prompt-template commands;
- automatic first-prompt titles and persistent manual Pi session names;
- Terminal Auth backed by Pi's authentication setup.

Pi owns session IDs, session files, branch creation, command expansion, model state, and thinking state. MagPi discovers persisted sessions from Pi's configured session directory and translates between Pi RPC and ACP.

## Ask User elicitation

MagPi bundles a minimal Pi extension that registers the model-facing `ask_user` tool. `ask_user` is not a built-in Pi tool, and no separate `pi-ask-user` package is required when running through MagPi.

```text
model calls ask_user → Pi extension UI request → MagPi → ACP form elicitation → client response → Pi tool result
```

The Pi extension UI request is internal to MagPi's Pi subprocess. ACP clients see standard ACP elicitation rather than a MagPi-specific Ask User protocol. Clients that advertise form elicitation can render structured choices and free-form answers; option-only questions retain an ACP permission fallback for clients without form support.

The bundled tool intentionally omits the external package's terminal overlays and other standalone Pi TUI features.

## Mischief

[Mischief](https://github.com/digital-overground/mischief) is the recommended way to use MagPi. It provides polished multi-thread workspaces, Pi session history, inline elicitation, integrated authentication, and other UI tailored to MagPi while preserving standard ACP behavior.

## Requirements

Install these where your ACP client runs agents:

- [Node.js](https://nodejs.org/) 22 or newer.
- [Pi](https://github.com/earendil-works/pi-mono), available as `pi` on `PATH`.
- A model provider configured through Pi.

For Remote SSH, Dev Containers, or WSL, install Node.js, Pi, and MagPi ACP in that remote environment.

## Install

Install Pi and MagPi ACP globally:

```sh
npm install -g @earendil-works/pi-coding-agent magpi-acp
```

Configure your ACP client to launch `magpi-acp` from `PATH`. Mischief can install it during first-Thread setup; set `mischief.magpiAcpPath` to use another executable or a built `dist/index.js`.

Update MagPi with:

```sh
npm install -g magpi-acp@latest
```

Restart the ACP agent process after updating.

## Optional Pi extensions

Install todo support for ACP plans:

```sh
pi install npm:@juicesharp/rpiv-todo
```

## Roles

MagPi reads named role presets from `~/.pi/agent/roles.json` and exposes them as standard ACP session configuration options with category `mode`. Compatible clients, including Mischief and Zed, can display them alongside model and thinking controls:

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

Each role is a named preset that applies its model and thinking level together. ACP clients surface roles as a mode selector in the session controls; choose a role to switch both settings with one standard configuration update. MagPi reports the matching role as active whenever the current model and thinking level match a preset. Selecting a model or thinking level independently may leave no role selected.

JSON key order controls role order. Use provider/model IDs available in your Pi installation and one of Pi's supported thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Restart the agent process after editing `roles.json` so clients receive the updated options.

## Commands

Pi's `get_commands` response is the source of truth for extension, skill, and prompt-template commands. MagPi advertises that command list over ACP and passes invocations to Pi for native expansion. Pi discovers user prompts from `~/.pi/agent/prompts/**/*.md` and project prompts from `<cwd>/.pi/prompts/**/*.md`.

MagPi additionally provides these adapter commands backed by explicit Pi RPC operations:

- `/compact [instructions...]` — compact the current session context.
- `/autocompact on|off|toggle` — configure automatic compaction.
- `/export` — export the session to HTML.
- `/session` — show session, message, token, and cost statistics.
- `/name <title>` — persist a manual session title.
- `/steering all|one-at-a-time` — read or set Pi steering delivery.
- `/follow-up all|one-at-a-time` — read or set Pi follow-up delivery.
- `/changelog` — show Pi's changelog.

Skill commands follow Pi's settings. The bundled internal tree-navigation bridge is not advertised as a composer command.

## Configuration

Set `quietStartup: true` in `~/.pi/agent/settings.json` or `<project>/.pi/settings.json` to suppress startup details. Update notices remain visible.

Set `MAGPI_ACP_ENABLE_EMBEDDED_CONTEXT=true` when the client should be allowed to send embedded ACP resources. Set `MAGPI_ACP_PI_COMMAND` in the agent process environment to override the `pi` executable path.

## Authentication

When Pi needs authentication, clients with Terminal Auth support can launch MagPi ACP's setup flow. For manual setup:

```sh
magpi-acp --terminal-login
```

Credentials remain managed by Pi and are not stored by MagPi ACP.

## Development

```sh
npm ci
npm run check
```

Build before running the sibling Mischief development extension; Mischief automatically detects `../magpi-acp/dist/index.js`:

```sh
npm run build
```

Project layout:

- `src/acp` — client-facing ACP server and translation layer.
- `src/pi-rpc` — Pi subprocess and RPC protocol wrapper.
- `src/pi-extension` — bundled Pi tools and session-tree integration.
- `test` — unit and component tests.

## Limitations

- Pi reads, writes, and executes locally; ACP filesystem and terminal delegation are not implemented.
- Non-empty MCP server configuration is retained in session state but is not forwarded to Pi.
- Permanent ACP session deletion is not implemented; Pi session history remains on disk.
- Targeted native forks accept Pi user-message entry IDs; assistant-message targets are unsupported.
- Pi extension UI methods require an ACP translation before clients can render them.

## Attribution

MagPi ACP was originally derived from [Sergii Kozak's `pi-acp`](https://github.com/svkozak/pi-acp).

## License

MIT — see [LICENSE](LICENSE).
