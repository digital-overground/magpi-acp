# MagPi ACP

The [Pi coding agent](https://github.com/earendil-works/pi-mono) runtime adapter for [Mischief](https://github.com/digital-overground/mischief).

```text
Mischief → MagPi ACP → Pi RPC → selected model
```

MagPi ACP speaks [Agent Client Protocol](https://agentclientprotocol.com) JSON-RPC over stdio and runs Pi in `--mode rpc`. Mischief is its supported client.

## Mischief integration

MagPi ACP provides the Agent runtime behind Mischief Threads:

- Streams messages, thoughts, tool calls, plans, usage, and structured diffs.
- Lists, loads, and resumes Pi sessions for Mischief Thread History.
- Supports message-targeted Thread forks and rollback through Pi's native session tree.
- Exposes role, model, and thinking controls.
- Maps Pi extension prompts to inline Mischief elicitation.
- Advertises Terminal Auth so Mischief can open Pi setup in an integrated terminal.
- Generates a short title from the first prompt and supports persistent manual titles.
- Loads Pi skills and file-based prompt commands.

Mischief and MagPi ACP should be updated together because Thread fork and rollback use MagPi-specific ACP metadata in addition to standard ACP methods.

## Requirements

Install these where the Mischief extension host runs:

- [Mischief](https://github.com/digital-overground/mischief).
- [Node.js](https://nodejs.org/) 22 or newer.
- [Pi](https://github.com/earendil-works/pi-mono), available as `pi` on `PATH`.
- A model provider configured through Pi.

For Remote SSH, Dev Containers, or WSL, install Node.js, Pi, and MagPi ACP in that remote environment.

## Install

Mischief's first-Thread setup can install Pi and MagPi ACP. To install them manually:

```sh
npm install -g @earendil-works/pi-coding-agent magpi-acp
```

Mischief launches `magpi-acp` from `PATH`. Set `mischief.magpiAcpPath` to use another executable or a built `dist/index.js`.

Update the adapter with:

```sh
npm install -g magpi-acp@latest
```

Restart the Mischief Thread after updating.

## Optional Pi extensions

Install todo support for Mischief plans:

```sh
pi install npm:@juicesharp/rpiv-todo
```

Install structured prompts for inline elicitation:

```sh
pi install npm:pi-ask-user
```

## Roles

Mischief displays named role controls from `~/.pi/agent/roles.json`:

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

JSON key order controls role order. Models shown above are examples; use provider and model IDs available in your Pi installation.

## Commands

### File-based commands

- User commands: `~/.pi/agent/prompts/**/*.md`
- Project commands: `<cwd>/.pi/prompts/**/*.md`

### Adapter commands

- `/compact [instructions...]` — compact the current Thread context.
- `/autocompact on|off|toggle` — configure automatic compaction.
- `/export` — export the Thread to HTML.
- `/session` — show session, message, token, and cost statistics.
- `/name <title>` — persist a manual Thread title.
- `/steering all|one-at-a-time` — read or set Pi steering delivery.
- `/follow-up all|one-at-a-time` — read or set Pi follow-up delivery.
- `/changelog` — show Pi's changelog.
- `/tree` — choose an earlier Pi session entry and continue from it.

Skill commands are exposed when enabled in Pi settings. Pi extension commands are not advertised as ACP slash commands.

## Configuration

Set `quietStartup: true` in `~/.pi/agent/settings.json` or `<project>/.pi/settings.json` to suppress startup details. Update notices remain visible.

Mischief enables embedded ACP context automatically. Set `MAGPI_ACP_PI_COMMAND` in the Agent process environment to override the `pi` executable path.

## Authentication

When Pi needs authentication, Mischief launches MagPi ACP's Terminal Auth flow. For manual setup:

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

- `src/acp` — Mischief-facing ACP server and translation layer.
- `src/pi-rpc` — Pi subprocess and RPC protocol wrapper.
- `src/pi-extension` — bundled Pi session-tree integration.
- `test` — unit and component tests.

## Limitations

- Pi reads, writes, and executes locally; ACP filesystem and terminal delegation are not implemented.
- MCP servers supplied by Mischief are retained in session state but not forwarded to Pi.
- Pi extension UI requires an ACP translation before Mischief can render it.

## Attribution

MagPi ACP was originally derived from [Sergii Kozak's `pi-acp`](https://github.com/svkozak/pi-acp).

## License

MIT — see [LICENSE](LICENSE).
