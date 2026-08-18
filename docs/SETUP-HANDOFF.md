# Pied workflow handoff

This setup uses stock Zed as the ACP client, the private `pied-acp` adapter, and Pi as the agent runtime.

```text
Zed → pied-acp (ACP ↔ Pi RPC adapter) → Pi → selected model
```

## Required tools

| Tool | Purpose | Link |
| --- | --- | --- |
| Zed | Editor and ACP client | [zed.dev/download](https://zed.dev/download) · [External Agents docs](https://zed.dev/docs/ai/external-agents) |
| Pi | Coding-agent runtime | [GitHub](https://github.com/earendil-works/pi-mono) · [npm](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) · [pi.dev](https://pi.dev) |
| pied-acp | Customized ACP adapter | [kylehumphrey-ao/pied-acp](https://github.com/kylehumphrey-ao/pied-acp) (private; collaborator access required) |
| ACP | Protocol used between Zed and the adapter | [agentclientprotocol.com](https://agentclientprotocol.com) |
| Node.js 22+ | Runs Pi and pied-acp | [nodejs.org](https://nodejs.org) |
| Git | Clones the private adapter and Git-based Pi packages | [git-scm.com](https://git-scm.com) |

Versions at handoff: Zed 1.15.0, Pi 0.84.2, Node 26.6.0, npm 12.0.2.

Package snapshot: `rpiv-todo` 2.5.1, `pi-ask-user` 0.14.0, `pi-linear-tools` 0.7.3, `pi-session-recall` 1.0.6, Tavily 0.1.2, Ponytail commit `2ed6c52`, Matt Pocock skills commit `8b78b53`, and private skills commit `dc6672d`.

## Install the core

```sh
npm install -g @earendil-works/pi-coding-agent
```

```sh
git clone git@github.com:kylehumphrey-ao/pied-acp.git
```

```sh
cd pied-acp && npm ci && npm test && npm run build
```

The private repository's `main` branch contains the pied changes at commit `b57a8e4`. It is based on upstream [`svkozak/pi-acp`](https://github.com/svkozak/pi-acp) 0.0.31; add that repository as `upstream` before syncing newer releases.

```sh
git remote add upstream https://github.com/svkozak/pi-acp.git
```

## Pi packages, plugins, and skills

### Required for the workflow

| Package | What it provides | Link |
| --- | --- | --- |
| `@juicesharp/rpiv-todo` | Persistent `todo` tool; pied-acp translates its state into Zed's native plan card | [npm](https://www.npmjs.com/package/@juicesharp/rpiv-todo) · [source](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) |
| `pi-ask-user` | Structured decision prompts; pied-acp maps them to Zed ACP elicitation | [npm](https://www.npmjs.com/package/pi-ask-user) · [source](https://github.com/edlsh/pi-ask-user) |
| Ponytail | Minimal/YAGNI implementation and review skills; also requires tracing the real code path before editing | [source](https://github.com/DietrichGebert/ponytail) |
| Matt Pocock skills | `grill-me`, debugging, code review, research, TDD, handoff, and related workflow skills | [source](https://github.com/mattpocock/skills) |

```sh
pi install npm:@juicesharp/rpiv-todo
```

```sh
pi install npm:pi-ask-user
```

```sh
pi install git:github.com/DietrichGebert/ponytail
```

```sh
pi install git:github.com/mattpocock/skills
```

Key skills used most often:

- [`ponytail`](https://github.com/DietrichGebert/ponytail/tree/main/skills/ponytail): smallest correct implementation, no speculative abstractions.
- [`grill-me`](https://github.com/mattpocock/skills/tree/main/skills/productivity/grill-me): requirements exploration before implementation.
- [`diagnosing-bugs`](https://github.com/mattpocock/skills/tree/main/skills/engineering/diagnosing-bugs): root-cause debugging.
- [`code-review`](https://github.com/mattpocock/skills/tree/main/skills/engineering/code-review): standards/spec review.
- [`research`](https://github.com/mattpocock/skills/tree/main/skills/engineering/research): primary-source research written into the repository.
- [`tdd`](https://github.com/mattpocock/skills/tree/main/skills/engineering/tdd): red-green-refactor when requested.
- The `ask-user` skill bundled with [`pi-ask-user`](https://github.com/edlsh/pi-ask-user) gates ambiguous or high-stakes decisions.

### Optional integrations currently installed

| Package/tool | Use | Link |
| --- | --- | --- |
| `@tavily/pi-extension` | `web_search` and `web_fetch`; requires `TAVILY_API_KEY` | [npm](https://www.npmjs.com/package/@tavily/pi-extension) · [Tavily](https://tavily.com) |
| `@fink-andreas/pi-linear-tools` | Linear issue, project, update, team, and milestone tools | [npm](https://www.npmjs.com/package/@fink-andreas/pi-linear-tools) · [source](https://github.com/fink-andreas/pi-linear-tools) |
| `@ogulcancelik/pi-session-recall` | Search and query previous Pi sessions | [npm](https://www.npmjs.com/package/@ogulcancelik/pi-session-recall) · [source](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-session-recall) |
| `kylehumphrey-ao/skills` | Private custom skills, currently including `stubble` | [private repository](https://github.com/kylehumphrey-ao/skills) |
| ripgrep | Fast backend for session recall | [source](https://github.com/BurntSushi/ripgrep) |

```sh
pi install npm:@tavily/pi-extension
```

```sh
pi install npm:@fink-andreas/pi-linear-tools
```

```sh
pi install npm:@ogulcancelik/pi-session-recall
```

```sh
pi install git:git@github.com:kylehumphrey-ao/skills
```

## Pi configuration

Create `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "npm:@juicesharp/rpiv-todo",
    "npm:pi-ask-user",
    "git:github.com/DietrichGebert/ponytail",
    "git:github.com/mattpocock/skills",
    "npm:@tavily/pi-extension",
    "npm:@fink-andreas/pi-linear-tools",
    "npm:@ogulcancelik/pi-session-recall",
    "git:git@github.com:kylehumphrey-ao/skills"
  ],
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.6-terra",
  "defaultThinkingLevel": "high",
  "theme": "dark"
}
```

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

JSON key order controls role cycling order. In Zed, `shift-tab` invokes `agent::CycleModeSelector` and cycles these roles. A role switch calls Pi's `set_model` and `set_thinking_level` RPC commands.

Keep global instructions in `~/.pi/agent/AGENTS.md`; keep repository-specific instructions in each repository's `AGENTS.md`. Ponytail supplies the explore/trace-before-edit behavior used in this workflow.

## Authentication and secrets

Each developer must authenticate independently. Never copy `~/.pi/agent/auth.json`, Linear settings, or API keys.

- Configure the OpenAI Codex provider through Pi's authentication flow.
- Set `TAVILY_API_KEY` in the environment that launches Zed/Pi if using Tavily.
- Run `/linear-tools-config` in a terminal Pi session to configure the developer's own Linear account and team.
- Grant the developer access to the private `pied-acp` and private skills repositories.

## Stock Zed configuration

Add this to stock Zed's `~/.config/zed/settings.json`, replacing the adapter path:

```json
{
  "agent_servers": {
    "pied-acp": {
      "type": "custom",
      "command": "node",
      "args": ["/absolute/path/to/pied-acp/dist/index.js"],
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

Open a new `pied-acp` thread after rebuilding the adapter or changing roles.

## What the pied-acp fork adds

- Native ACP model and thinking selectors.
- A combined role selector ordered left-to-right as Role, Model, Thinking.
- `Plan`, `Build`, and `Fast` role switching from `roles.json`.
- Native Zed plan cards from `rpiv-todo` results, including plan restoration on session load.
- ACP elicitation for Pi extension select, confirm, input, and editor requests.
- Automatic 2–6 word thread titles generated immediately from the first user message with the active model in an isolated no-session call.
- Pi session listing/loading and title persistence.
- Native structured diffs, tool locations, terminal output metadata, usage/cost updates, and startup information.
- `/tree` navigation and rewind integration using the bundled Pi tree extension.
- `/name <title>` for manual persistent thread naming.

## Working workflow

1. Start a stock Zed `pied-acp` thread.
2. Choose `Plan`, `Build`, or `Fast`; use `shift-tab` to cycle roles.
3. For unclear work, invoke `grill-me` before implementation.
4. Ask Pi to explore the repository and trace the relevant flow before editing.
5. For multi-step work, ask Pi to create and maintain todos; they render as Zed's native plan card.
6. Use Ponytail's smallest-correct-solution rule during implementation.
7. Use `/name` only when overriding the automatic title.
8. Run the repository's tests/typecheck/build before handoff.

## Maintaining pied-acp

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

Zed launches the adapter's built `dist/index.js` as a custom agent.
