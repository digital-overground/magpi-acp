# Remote, GUI-first agent IDE landscape

Research snapshot: 2026-08-20

## Question

Is there an environment that combines:

1. persistent, reconnectable agent sessions like tmux or HerdR;
2. graphical, structured agent interaction rather than a raw TUI;
3. project, worktree, and session navigation;
4. file browsing, editing, and diff review;
5. remote access from another desktop or a browser; and
6. support for a user-owned agent such as Pi or MagPi ACP?

## Conclusion

Yes. **Kandev is the closest existing match when a browser application is acceptable**. It already combines a server-owned session model, structured ACP chat, worktree executors, task/session browsing, a file tree and Monaco editor, Git review, terminals, an embedded code-server instance, browser access, and remote SSH execution. Pi is a built-in agent through `pi-acp`, with Pi TUI passthrough also available.

If a truly native UI is mandatory, **Waku is the closest match**. It is a Rust/GPUI desktop application with direct Pi RPC integration, daemon-owned sessions, task worktrees, structured transcripts and tool activity, Git-backed rewind, file editing, diffs, and terminals. Its compact editor is not a full LSP IDE, but it can open the active project or worktree directly in Zed.

For narrower variants:

- **Waku** is the best truly native Pi workbench, but it bypasses MagPi ACP and currently cancels Pi extension input requests.
- **PI WEB** is the best Pi-native, remote-first control surface, but it is a workbench rather than a full IDE.
- **Agent of Empires** is the best tmux-backed option with a structured web ACP view and a configurable custom ACP command, making it a strong MagPi target, but it lacks a full source editor/file explorer.
- **Jean** is a polished desktop/web workbench with direct Pi RPC support, worktrees, file previews, diffs, and terminals, but its built-in file surface is not a full IDE.
- **Orca** has an excellent editor/worktree/diff/SSH/mobile shell around Pi, but agent interaction remains terminal-centric.
- **VS Code can be assembled into this**, but third-party ACP sessions do not yet receive the complete native Agents-window/worktree/remote-control experience.
- **A minimal Zed fork is the least attractive implementation path**. Zed's public extension model cannot add arbitrary UI panels, while a core fork inherits a large, fast-moving Rust application.

The shortest path is to test Kandev before building anything.

## Capability matrix

Legend: ✅ strong match, ◐ partial or integration-dependent, ❌ missing.

| Product                                                                  |                                                           Own Pi / ACP agent |             Structured GUI agent chat |                          Worktrees and session browser |                                    Files and diffs |                                                   Durable remote access |                     Full editor |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------: | ------------------------------------: | -----------------------------------------------------: | -------------------------------------------------: | ----------------------------------------------------------------------: | ------------------------------: |
| [Waku](https://github.com/egoist/waku)                                   |                   ✅ direct Pi RPC; other agents use native protocols or ACP |                                    ✅ |        ✅ daemon sessions, task worktrees, checkpoints |      ✅ native compact editor, file tree, Git diff |                ✅ remote daemon protocol; some remote PTY/picker limits |               ◐ no LSP/full IDE |
| [Kandev](https://github.com/kdlbs/kandev)                                | ✅ Pi built in; adding another ACP integration requires backend registration |                                    ✅ |                                                     ✅ | ✅ file tree, Monaco, Git review, embedded VS Code |                                  ✅ server mode, browser, SSH executors |                              ✅ |
| [PI WEB](https://github.com/jmfederico/pi-web)                           |                                                                 ✅ Pi-native |                                    ✅ | ◐ discovers/switches worktrees; persistent Pi sessions |                  ✅ browsing/previews and Git diff |                         ✅ browser daemon and remote-machine federation |     ◐ no full IDE/LSP workbench |
| [Agent of Empires](https://github.com/agent-of-empires/agent-of-empires) |                                               ✅ Pi plus custom ACP commands |            ✅ ACP structured web view |                         ✅ tmux sessions and worktrees |         ◐ diff review/edit, no full project editor |                               ✅ browser/PWA, tmux persistence, tunnels |                              ❌ |
| [Jean](https://github.com/coollabsio/jean)                               |                                                             ✅ direct Pi RPC |                                    ✅ |                                                     ✅ |                      ✅ file preview, Git and diff |                                       ✅ Web Access and headless server |      ◐ opens an external editor |
| [Arbor](https://github.com/penso/arbor)                                  |                                                       ✅ Pi through ACP/acpx |                                    ✅ |                                                     ✅ |                 ✅ file tree and side-by-side diff |                                    ✅ daemon, web UI, SSH/mosh outposts | ◐ workbench, not a language IDE |
| [remote-agent](https://github.com/d-kimuson/remote-agent)                |                                         ✅ Pi preset and custom ACP provider |                                    ✅ |                      ◐ sessions and selected worktrees |      ✅ tool/file/diff viewers and review comments |                                                   ✅ PWA, Tailscale/LAN |                              ❌ |
| [Orca](https://github.com/stablyai/orca)                                 |                                                  ✅ Pi or any terminal agent | ◐ terminal-oriented agent interaction |                                                     ✅ |                      ✅ editor and annotated diffs |                                   ✅ SSH worktrees and mobile companion |                              ✅ |
| VS Code native Agents window                                             |                                 ❌ Pi is not a supported first-class harness |                                    ✅ |                                                     ✅ |                                                 ✅ |                                    ◐ remote control is harness-specific |                              ✅ |
| VS Code + community ACP client                                           |                                                   ✅ MagPi can be configured |                                    ✅ |          ◐ ACP session list, separate worktree tooling |                     ✅ editor; ACP tool cards vary | ◐ remote host works, live ACP process durability does not come for free |                              ✅ |
| Cursor                                                                   |                                                   ❌ no arbitrary Pi harness |                                    ✅ |                                                     ✅ |                                                 ✅ |                              ✅ local, worktree, cloud, SSH, web/mobile |                              ✅ |
| Custom Eclipse Theia product                                             |                                                    ✅ after integration work |             ✅ after integration work |                                        ◐ must be built |                       ✅ platform primitives exist |                                          ✅ browser/server architecture |                              ✅ |

## Native-only addendum: Waku

[Waku](https://github.com/egoist/waku) is a fully native Rust/GPUI desktop application rather than a webview wrapper. Its daemon owns projects, sessions, provider processes, worktrees, checkpoints, filesystem operations, and Git operations; the desktop is a native RPC client.

It provides:

- direct Pi RPC integration using one long-lived `pi --mode rpc` process per session;
- native structured transcripts, thinking, tool activity, model and reasoning controls, steering, and queued prompts;
- isolated task worktrees under `~/.waku/worktrees`;
- conversation-aware Git checkpoints, rewind, and branching;
- a file tree, compact editable file surface, Git changes/diffs, and terminal;
- a standalone authenticated daemon protocol; and
- an **Open in Zed** target discovered through macOS Launch Services.

Sources:

- [Waku README and architecture](https://github.com/egoist/waku/blob/main/README.md)
- [Provider lifecycle and Pi RPC details](https://github.com/egoist/waku/blob/main/docs/providers.md#pi-and-oh-my-pi)
- [Daemon-owned worktrees](https://github.com/egoist/waku/blob/main/crates/waku-core/src/worktree.rs)
- [Native external-app catalog including Zed](https://github.com/egoist/waku/blob/main/src/platform.rs)

Important limitations:

- Waku invokes Pi directly, not MagPi ACP. MagPi-only roles, ACP plan translation, and ACP metadata do not carry over.
- Its Pi driver currently cancels extension `select`, `confirm`, `input`, and `editor` requests. Pi extensions such as `ask_user` and MagPi's `/tree` interaction therefore need Waku integration work.
- The built-in editor is deliberately compact, using an in-house lexer rather than LSP. Zed remains the better source editor.
- With an externally managed remote daemon, file/diff/Git operations work over RPC, but the native folder picker and PTY are unavailable until corresponding daemon-host APIs land.

For a native-only workflow, the best current composition is **Waku for agents, sessions, worktrees, and review; Zed for full editing**. Both are GPUI applications, and Waku already opens the selected worktree in Zed. This avoids a Zed fork and avoids browser UI entirely.

## 1. Kandev: closest complete browser-based answer

Kandev describes itself as a server-first, self-hostable agent development environment. Its repository documents:

- structured ACP chat for Pi and many other agents;
- parallel tasks and Git worktree isolation;
- task/session history and resume;
- a file tree and editable Monaco surface;
- language-server integration;
- Git changes and review;
- terminals and browser previews;
- an embedded code-server/VS Code panel;
- local, worktree, Docker, SSH, and cloud executors; and
- service installation for persistent browser access.

Sources:

- [Kandev README](https://github.com/kdlbs/kandev/blob/main/README.md)
- [Agents and profiles](https://github.com/kdlbs/kandev/blob/main/docs/public/agents-and-profiles.md)
- [Executors](https://github.com/kdlbs/kandev/blob/main/docs/public/executors.md)
- [Developer tools](https://github.com/kdlbs/kandev/blob/main/docs/public/developer-tools.md)
- [Run as a service](https://github.com/kdlbs/kandev/blob/main/docs/run-as-a-service.md)

### Pi support

Kandev's Pi integration currently launches structured sessions with `npx -y pi-acp` and terminal passthrough with `pi`. Its source declares session resume under `~/.pi`, Pi project MCP injection, and standard ACP transport:

- [Pi ACP implementation](https://github.com/kdlbs/kandev/blob/main/apps/backend/internal/agent/agents/pi_acp.go)
- [Pi MCP injection decision](https://github.com/kdlbs/kandev/blob/main/docs/decisions/0020-pi-project-mcp-config-injection.md)

This is a genuine Pi integration, not terminal scraping.

### MagPi fit

Kandev does not currently expose an arbitrary ACP command as a user-created structured agent. User-created agents are TUI passthrough only. Full ACP integrations are registered in Go; the frontend discovers them automatically, so no frontend change is required:

- [Adding an agent CLI integration](https://github.com/kdlbs/kandev/blob/main/docs/add-agent-cli.md)

A MagPi integration would therefore be much smaller than a Zed fork: add or modify one backend agent definition to launch `node /absolute/path/to/magpi-acp/dist/index.js`, register it, and test ACP capabilities. Kandev already handles permissions, model/mode/config options, usage, todos, and session resume. MagPi's unstable form elicitation should be tested separately; when a client does not advertise form elicitation, MagPi already falls back to ACP permission choices for select/confirm and cancels free-text/editor requests.

### Important limitations

- Kandev is AGPL-3.0.
- Authentication is disabled by default. The project says to enable it and use TLS/private networking when reachable by other users: [Authentication](https://github.com/kdlbs/kandev/blob/main/docs/public/authentication.md).
- Embedded VS Code starts code-server with `--auth none` inside the task environment. Kandev explicitly requires a trusted executor/network boundary.
- Kandev is opinionated and much larger than HerdR or MagPi. Its kanban/workflow concepts may be useful or may be excess UI for a personal workflow.
- Kandev's own LSP integration currently supports Local and Local Docker, not SSH/Sprites. Embedded code-server inside those remote environments can still provide its own editor capabilities.

## 2. PI WEB: best Pi-native remote control plane

PI WEB is specifically built around persistent Pi sessions. Its daemon owns sessions outside the browser, so browser disconnects and web/API restarts do not normally stop active agent work. It supports projects, discovered Git worktrees, session trees, file browsing and previews, Git status/diff, terminals, Pi packages/extensions, and trusted remote-machine federation.

Sources:

- [PI WEB README](https://github.com/jmfederico/pi-web/blob/main/README.md)
- [Remote-first model](https://pi-web.dev/remote-first)
- [Machines and fleets](https://pi-web.dev/machines)
- [Plugin and extension UI behavior](https://github.com/jmfederico/pi-web/blob/main/docs/plugins.md)

It is likely to preserve more native Pi behavior than an ACP adapter because it directly hosts Pi and explicitly supports `ctx.ui.confirm`, `select`, and `input` from Pi extensions.

Limitations:

- It is a Pi workbench, not a full editor with language services and debugging.
- The bundled Git provider discovers existing worktrees on demand; worktree creation is not the core GUI workflow.
- MagPi-only behavior such as `roles.json`, ACP plan translation, ACP titles, and ACP-specific metadata does not apply because PI WEB does not run through MagPi ACP.

PI WEB is the best choice if the priority is **Pi fidelity plus browser persistence**, with Zed or VS Code left open separately for deep editing.

## 3. Agent of Empires: strongest tmux + structured ACP hybrid

Agent of Empires runs terminal sessions in tmux and also provides a structured ACP web view with tool cards, plan panels, approvals, models/modes/configuration, and persisted transcripts. Its web UI is accessible as a PWA, and worktrees and diff review are first-class.

Sources:

- [Agent of Empires README](https://github.com/agent-of-empires/agent-of-empires/blob/main/README.md)
- [Structured View](https://github.com/agent-of-empires/agent-of-empires/blob/main/docs/structured-view.md)
- [Configuration: custom structured ACP agent](https://github.com/agent-of-empires/agent-of-empires/blob/main/docs/guides/configuration.md#running-a-custom-agent-in-the-structured-view)
- [Structured worker persistence](https://github.com/agent-of-empires/agent-of-empires/blob/main/docs/structured-view/controls.md)

AoE has a built-in `pi` mapping to `pi-acp`, but, importantly, a custom agent can provide `session.agent_acp_cmd`. That makes it possible to register MagPi's absolute command without changing AoE source.

Limitations:

- It remains terminal/session-manager-shaped rather than a complete IDE.
- Diff review and direct edits exist, but there is no Zed/VS Code-class file editor and project navigation surface.
- It has more orchestration and configuration than HerdR.

AoE is the lowest-code route to **MagPi over ACP with remote structured interaction**, if a full editor is not required inside the same app.

## 4. Jean: polished Pi desktop/web workbench

Jean explicitly supports Pi through a detached `pi --mode rpc` host on Unix. The host keeps Pi alive after Jean exits, logs events, and accepts prompt, steering, and abort commands over a local socket. Jean also provides worktree automation, session management, structured chat, terminals, file previews, Git operations, unified/side-by-side diffs, Web Access, and a headless Linux server.

Sources:

- [Jean README](https://github.com/coollabsio/jean/blob/main/README.md)
- [Pi RPC behavior in repository guidance](https://github.com/coollabsio/jean/blob/main/AGENTS.md#pi-cli-json-output-format)
- [Headless server](https://github.com/coollabsio/jean/blob/main/docs/headless-server.md)

Limitations:

- Jean's file surface is described as a preview; it offers “open in editor” integrations rather than replacing Zed/VS Code.
- Its direct Pi RPC path bypasses MagPi ACP, so MagPi-specific controls and ACP translation are not inherited automatically.
- Its own session/run log is authoritative for Jean's UI, while Pi's session format is used for parsing and resume IDs.

## 5. Other relevant products

### Arbor

Arbor is a native GPUI application with a shared daemon and web UI. It combines repositories, issue-driven worktrees, persistent terminal sessions, file trees, diffs, and ACP chat through `acpx`, including Pi. It also supports remote daemons, bearer auth, SSH/mosh outposts, and remote worktrees.

Source: [Arbor README](https://github.com/penso/arbor/blob/main/README.md).

It is a better starting point than extracting a “minimal Zed” because it already uses GPUI for this narrower problem. Its ACP path is less direct/configurable than Kandev or AoE, and it is a workbench rather than a complete language IDE.

### remote-agent

`remote-agent` is a self-hosted browser/PWA ACP client with a built-in Pi provider, custom ACP providers, visual tool/file/diff viewers, plans, approvals, worktree selection, line comments, Tailscale support, and API-key/IP controls.

Source: [remote-agent README](https://github.com/d-kimuson/remote-agent/blob/main/README.md).

It is a good small ACP control surface, but it does not supply a complete IDE/file-tree experience and is significantly younger than the leading candidates.

### Orca

Orca has perhaps the strongest all-in-one **terminal-agent IDE**: Pi and arbitrary CLI agents, worktrees, persistent terminal splits, a VS Code-derived editor, annotated diffs, SSH worktrees, and a mobile companion.

Sources:

- [Orca README](https://github.com/stablyai/orca/blob/main/README.md)
- [SSH worktrees](https://www.onorca.dev/docs/ssh)

It does not satisfy the central requirement as cleanly because agent interaction remains the CLI/TUI rendered in a terminal. Its surrounding review/edit workflow is graphical, but the conversation itself is not ACP-native structured chat.

### Cursor

Cursor's Agents window claims local, worktree, cloud, and remote-SSH agents in one multi-repository GUI, plus web/mobile cloud-agent access and integrated diff review.

Sources:

- [Cursor 3 Agents window](https://cursor.com/changelog/3-0)
- [Cursor web and mobile](https://cursor.com/blog/agent-web)

It is close functionally but is proprietary and does not offer an arbitrary Pi/MagPi harness. Running Pi in its terminal returns to the same loss of structured interaction.

## 6. Can VS Code plus extensions provide this?

### What VS Code already provides

VS Code's current Agents window has nearly the requested UX for its supported harnesses:

- parallel local/background/cloud sessions;
- optional worktree isolation;
- a session sidebar;
- Files, Changes, Terminal/Tasks, and Browser views per session;
- range comments on diffs;
- session history and sync; and
- remote steering of Copilot harness sessions from GitHub.com/mobile.

Sources:

- [Agents window](https://code.visualstudio.com/docs/agents/run/agents-window)
- [Agent harnesses](https://code.visualstudio.com/docs/agents/run/agent-harnesses)
- [Session history and sync](https://code.visualstudio.com/docs/agents/run/sessions/session-history)
- [Remote SSH](https://code.visualstudio.com/docs/remote/ssh)
- [Remote Tunnels](https://code.visualstudio.com/docs/remote/tunnels)

The blocker is **harness extensibility**. The documented first-class local harnesses are Local, Copilot, Claude, and Codex. Remote control is specifically documented for Copilot sessions. A generic ACP harness is not a stable built-in feature.

### Community ACP clients

[`formulahendry/vscode-acp`](https://github.com/formulahendry/vscode-acp) is a stable-extension-API ACP client with:

- configurable agent commands, so it can launch MagPi;
- per-agent session lists;
- structured chat, thinking, tool cards, permissions, config options, file and terminal handlers; and
- session restoration through ACP `session/list` or a local cache.

Its limitations for this use case are material:

- one active agent at a time;
- its session list is separate from VS Code's native Agents window;
- no integrated worktree-per-session management;
- no Herdr-style long-lived owner outside the extension host;
- file attachments are currently listed as nonfunctional.

An experimental [`vscode-acp-provider`](https://github.com/gayanper/vscode-acp-provider) uses VS Code's proposed `chatSessionsProvider` APIs to appear more natively, but requires VS Code Insiders and `enable-proposed-api`. It is not a stable foundation yet. Microsoft's native ACP request remains under discussion: [microsoft/vscode#265496](https://github.com/microsoft/vscode/issues/265496).

### A viable VS Code architecture

If Kandev is unsuitable and the VS Code UX is mandatory, do **not** fork VS Code initially. Build or extend an extension around a separate daemon:

```text
VS Code extension / browser UI
        │ HTTP + WebSocket
        ▼
long-lived agent/worktree daemon
        │ ACP stdio
        ▼
MagPi ACP → Pi RPC
```

The daemon, not the extension host, should own:

- ACP processes and leases;
- session event replay;
- worktrees and their lifecycle;
- terminal PTYs;
- reconnect state and prompt ownership; and
- authentication for remote clients.

The extension can stay on stable APIs:

- `TreeView` for worktrees/sessions;
- `WebviewView` for structured ACP chat;
- `vscode.diff` and SCM APIs for review;
- workspace-folder/open-folder commands for worktree navigation; and
- normal VS Code editor, LSP, debugger, and terminal surfaces.

For browser access, host the workspace with code-server or OpenVSCode Server, or connect through VS Code Remote SSH/Tunnels. The separate daemon is still needed if an agent turn must survive an extension-host restart or browser disconnect.

Useful building blocks:

- [VS Code Chat Participant API](https://code.visualstudio.com/api/extension-guides/ai/chat)
- [VS Code Tree View API](https://code.visualstudio.com/api/extension-guides/tree-view)
- [VS Code remote extension architecture](https://github.com/microsoft/vscode-docs/blob/main/api/advanced-topics/remote-extensions.md)
- [code-server](https://github.com/coder/code-server)
- [OpenVSCode Server](https://github.com/gitpod-io/openvscode-server)
- [ACP Components](https://github.com/zvzuola/acp-components), which already supplies ACP session, plan, permission, diff, Monaco file-tree/viewer, and transport components.

This is feasible, but Kandev already implements most of this architecture.

## 7. Should Zed be forked?

Not for this purpose.

Zed's documented extension features are languages, debuggers, themes, icon themes, snippets, and MCP servers. Extensions are WASM-based and there is no public arbitrary panel/webview API comparable to VS Code:

- [Developing Zed extensions](https://zed.dev/docs/extensions/developing-extensions.md)
- [Extension capabilities](https://zed.dev/docs/extensions/capabilities)

Therefore, a Herdr session browser or remote multi-client ACP surface cannot currently be delivered as an ordinary Zed extension. It requires upstream core work or a fork.

A local checkout measurement on 2026-08-20 found approximately:

- 4,210 tracked files;
- 1,911 Rust files;
- 1.5 million lines of Rust; and
- roughly 179,000 Rust lines under agent-related crates.

Those numbers are not a clean extraction boundary; they demonstrate the maintenance scale. Thread UI, ACP, project/worktree state, terminals, remote projects, persistence, and GPUI are spread across multiple crates. Zed is primarily GPL-3.0-or-later with marked Apache-2.0 components: [Zed README licensing](https://github.com/zed-industries/zed/blob/main/README.md#licensing).

A “minimal Zed” would still need most of the hard parts and would continuously chase upstream changes. If GPUI/native performance is important, Arbor is already the narrower GPUI experiment to evaluate or contribute to.

## 8. If building a new IDE product, prefer Theia over a Zed fork

Eclipse Theia is explicitly a framework for custom browser and desktop IDEs. It supplies Monaco, LSP/DAP, file and SCM surfaces, custom widgets, browser/server deployment, and Theia AI's custom agents and structured change sets.

Sources:

- [Theia platform FAQ](https://theia-ide.org/docs/faq)
- [Theia AI framework](https://theia-ide.org/docs/theia_ai)
- [Theia Coder change review](https://theia-ide.org/docs/theia_coder)
- [Theia IDE AI-first layout](https://theia-ide.org/docs/user_ai)

Theia still requires an ACP integration, persistent session daemon, and worktree UX. It is the right base only if the objective is a distributable custom IDE rather than a personal workflow.

## Recommendation

### When native UI is mandatory: Waku first

Install Waku and validate its built-in Pi path against a disposable repository:

1. Create an isolated task worktree.
2. Run simultaneous Pi sessions and restart/reconnect to the daemon.
3. Review tool activity, file changes, diffs, rewind, and branching.
4. Open the active worktree in Zed.
5. Confirm whether cancelled Pi extension UI requests are a blocker.

If they are, extending Waku's existing Pi RPC driver to render those requests is narrower than either adding a full editor to Waku or forking Zed.

### When browser UI is acceptable: Kandev, unmodified

Use a disposable repository and test:

1. Kandev as a user service bound to localhost/private VPN.
2. The Worktree executor.
3. The built-in Pi ACP profile.
4. Structured tool calls, todos/plans, model/thinking controls, permissions, session resume, Files, Changes, terminal, and Embedded VS Code.
5. Reconnect from a second browser/device while a turn is active.

Do not expose the default unauthenticated service publicly. Enable authentication and TLS/private networking first.

### Second experiment: MagPi in Kandev

If stock `pi-acp` loses required MagPi behavior, add a MagPi ACP backend definition or make the Pi ACP command configurable. This is a contained integration change and does not require forking an editor.

Validate specifically:

- Role / Model / Thinking config options;
- `rpiv-todo` plan updates;
- automatic and manual titles;
- session list/load;
- `/tree` selection;
- extension select/confirm/input behavior;
- terminal metadata, file locations, and structured diffs; and
- disconnect/reconnect during an active turn.

### Fallbacks

- Choose **PI WEB** when Pi fidelity and remote browser access matter more than an integrated IDE.
- Choose **Agent of Empires** when tmux persistence plus MagPi ACP structured chat matters more than a full source editor.
- Build a **VS Code extension + daemon** only if VS Code itself is a hard requirement.
- Do not fork Zed unless the goal expands into maintaining a long-lived editor distribution.
