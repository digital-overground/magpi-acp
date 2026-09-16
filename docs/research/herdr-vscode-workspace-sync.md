# Herdr ↔ VS Code workspace synchronization

Research snapshot: 2026-08-24

## Question

Does an existing integration make an externally running Herdr session open or focus the matching Git-worktree workspace in VS Code when a Herdr workspace or agent thread is focused, optionally reusing one VS Code window? Does it also move the running Pi conversation into that worktree?

## Conclusion

**The pieces exist, but the exact end-to-end behavior does not.**

- VS Code natively supports replacing the **last active** VS Code window with a folder via `code --reuse-window <path>`.
- Herdr 0.8.2 natively creates and focuses worktree-backed workspaces and emits `workspace.focused` events.
- **Herdr Switcher** already provides a substantial VS Code integration, but its navigation begins inside VS Code and deliberately opens other spaces in separate windows. A plain focus change in an external Herdr client refreshes the extension's data; it does not open or replace a VS Code workspace.
- **Herdex** provides a richer Herdr tree and interactive pane terminals inside VS Code, but workspace routing also begins inside VS Code and opens other folders in new windows. It is an unarchived but dormant one-day `0.1.0` MVP built for Herdr protocol 17; the local Herdr 0.8.2 server reports protocol 20.
- **IDE Jump** can manually raise the VS Code window matching Herdr's focused project, or run a configurable `code` command when no matching window exists. It is action/keybinding-driven rather than automatic.
- The installed **Zed Workspace Sync** plugin implements the desired automatic Herdr → editor direction for Zed. No equivalent automatic VS Code adapter was found.
- The community **Pi Herdr Worktree** extension can let Pi create/open a Herdr worktree workspace safely, but its documented scope excludes pane and agent control. It does not relocate or restart the Pi conversation in the worktree.

Therefore:

- If navigation may start in VS Code and separate windows are acceptable, install **Herdr Switcher**; most of the requested experience already exists.
- If external Herdr must be authoritative, a small bridge is still required: consume Herdr focus events, resolve the focused workspace's worktree path, then tell VS Code to open it. Pi session replacement remains a separate integration step.

## Existing functionality

### VS Code CLI and extension API

VS Code documents:

```text
code --reuse-window /absolute/worktree/path
```

`--reuse-window` “forces opening a file or folder in the last active window.” It does not identify a particular window by workspace ID, so an external process cannot deterministically select among several VS Code windows using this flag alone.

The extension command `vscode.openFolder` supports `forceReuseWindow` and `forceNewWindow`. Opening in the same window shuts down the current extension host and starts a new one for the destination workspace. Any Herdr listener responsible for the switch should therefore live outside that extension host, or tolerate restart and reconnect.

Sources:

- [VS Code CLI reference](https://code.visualstudio.com/docs/configure/command-line#_command-line-help)
- [VS Code built-in command reference: `vscode.openFolder`](https://code.visualstudio.com/api/references/commands)

### Herdr core

Herdr 0.8.2 already supplies the required primitives:

- `herdr worktree create` creates a Git checkout, opens it as a Herdr workspace, and groups it with the parent repository workspace.
- `herdr workspace focus <workspace_id>` focuses a workspace.
- The socket API exposes `workspace.focused` subscriptions.

Herdr core does not provide a VS Code launch/synchronization command. A source search of the 0.8.2 tag found no VS Code editor adapter; its VS Code-specific source reference only detects VS Code Remote for clipboard transport selection.

Sources:

- [Herdr 0.8.2 CLI reference](https://github.com/herdrdev/herdr/blob/v0.8.2/docs/next/website/src/content/docs/cli-reference.mdx#worktrees)
- [Herdr 0.8.2 socket events](https://github.com/herdrdev/herdr/blob/v0.8.2/docs/next/website/src/content/docs/socket-api.mdx#events)
- [Herdr plugin model](https://herdr.dev/docs/plugins)

### Herdr Switcher for VS Code

[`statiolake.vscode-herdr-switcher`](https://marketplace.visualstudio.com/items?itemName=statiolake.vscode-herdr-switcher) is the closest existing VS Code solution. Version 0.1.28 requires VS Code 1.96+ and Herdr 0.8.0+ and provides:

- Herdr Spaces and Agents views in VS Code;
- live status and branch display;
- folder-to-Herdr-space association;
- clicking a Space to switch to its VS Code window;
- clicking an Agent to switch windows and focus its Herdr pane;
- optional bidirectional VS Code-window/Herdr-space synchronization through `herdr.synchronizeState`.

It does **not** implement the exact external-focus workflow:

1. `openSpace` and `openAgent` call `vscode.openFolder(..., { forceNewWindow: true })`, so navigation uses separate windows rather than replacing one window.
2. It subscribes to `workspace.focused`, but every Herdr event only schedules a snapshot refresh/reconciliation.
3. Cross-window navigation happens through a short-lived metadata intent published by the extension itself. A normal focus operation in an external Herdr UI does not publish that intent.

Sources:

- [Herdr Switcher README](https://github.com/statiolake/vscode-herdr-switcher/blob/6399abe55a8c8d266b7310254fbdda6ad47d02d4/README.md)
- [`openSpace`/`openAgent` use `forceNewWindow`](https://github.com/statiolake/vscode-herdr-switcher/blob/6399abe55a8c8d266b7310254fbdda6ad47d02d4/src/extension.ts#L313-L345)
- [Herdr events only schedule refresh/reconciliation](https://github.com/statiolake/vscode-herdr-switcher/blob/6399abe55a8c8d266b7310254fbdda6ad47d02d4/src/extension.ts#L1218-L1273)
- [Navigation intent implementation](https://github.com/statiolake/vscode-herdr-switcher/blob/6399abe55a8c8d266b7310254fbdda6ad47d02d4/src/navigationIntent.ts)

### Herdex for VS Code

[`mkellerman.herdex`](https://marketplace.visualstudio.com/items?itemName=mkellerman.herdex) is another VS Code-native Herdr client. It provides workspace/tab/pane and attention-sorted agent trees, interactive pane terminals, agent start/focus/prompt/interrupt commands, selection-to-agent sending, Git worktree grouping, and explicit workspace routing.

It is promising source material but not a maintained solution to this workflow:

- the repository's 25 commits all landed on 2026-07-28, its creation day;
- the Marketplace has only `0.1.0`, published the same day;
- it has one contributor, no GitHub releases, and no activity after that initial burst, although the repository is not archived;
- its README calls it a Phase 1 MVP and leaves worktrees, notifications, diff review, and jump-to-agent in the next phase;
- its source expects Herdr socket protocol 17, while the local Herdr 0.8.2 server reports protocol 20 and Herdex warns on any mismatch;
- `openWorkspace` uses `vscode.openFolder(..., { forceNewWindow: true })`; and
- external `workspace.focused`/`pane.focused` events only update internal IDs. Focus is deliberately excluded from its render signature, so those events neither route nor refresh VS Code.

Sources:

- [Herdex repository](https://github.com/mkellerman/herdex)
- [Herdex Marketplace listing](https://marketplace.visualstudio.com/items?itemName=mkellerman.herdex)
- [Workspace routing source](https://github.com/mkellerman/herdex/blob/65262a1e8c6cd9065f8c3c5adeb453f37cf458e7/src/commands/index.ts#L100-L143)
- [Focus events deliberately excluded from rendering](https://github.com/mkellerman/herdex/blob/65262a1e8c6cd9065f8c3c5adeb453f37cf458e7/src/model/sessionModel.ts#L38-L50)
- [Repository metadata and activity](https://api.github.com/repos/mkellerman/herdex)

### Herdr-side editor jump plugins

[`agentience/herdr-plugin-ide-jump`](https://github.com/agentience/herdr-plugin-ide-jump) is a macOS Herdr plugin that raises an existing editor window for the focused pane's project. If no matching window exists, it runs a configurable command whose default is:

```json
{ "open_command": ["code", "{path}"] }
```

It can be configured to use `code --reuse-window {path}`, but invocation is a Herdr plugin action/keybinding. It does not automatically run on every workspace focus. Matching an existing window also requires macOS Accessibility permission and a VS Code `window.title` that starts with the project root name.

[`alex-devdone/herdr-cursor-open`](https://github.com/alex-devdone/herdr-cursor-open) similarly opens the focused pane in Cursor or VS Code, including Remote-SSH paths, but is also an explicit action rather than continuous synchronization.

### Existing Zed implementation

[`ImArtisann/zed-herdr`](https://github.com/ImArtisann/zed-herdr) demonstrates the exact Herdr-authoritative pattern:

- starts on `workspace.created` and `workspace.focused`;
- reads Herdr snapshots and lifecycle events;
- resolves and validates the active Git root;
- asks Zed to add/focus it with `zed -e <absolute-git-root>`.

This plugin is installed locally as `artisann.zed-herdr`. Its architecture is reusable, but its editor adapter is Zed-specific.

### Pi worktree creation

[`@mcuste/pi-herdr-worktree`](https://github.com/mcuste/pi-herdr-worktree) adds a safe `herdr_worktree` tool to Pi. Its `create` operation runs `herdr worktree create`, verifies the resulting checkout and branch, and can optionally focus the new Herdr workspace.

Its README explicitly excludes Herdr workspace, tab, pane, and agent control. The source contains no Pi `newSession`, `switchSession`, or cwd-replacement call. The original Pi process therefore remains rooted in its original checkout; the new worktree workspace begins with a new shell pane.

Sources:

- [Pi Herdr Worktree README](https://github.com/mcuste/pi-herdr-worktree/blob/919f7c5c801f1f2c8b75da9f7e7cff0a5b299e21/README.md)
- [Operations reference](https://github.com/mcuste/pi-herdr-worktree/blob/919f7c5c801f1f2c8b75da9f7e7cff0a5b299e21/docs/operations.md)

## Local compatibility check

The current machine has:

- Herdr `0.8.2`;
- VS Code `1.134.0`;
- the Zed Workspace Sync Herdr plugin enabled;
- no installed VS Code extension whose ID contains `herdr` or `worktree`.

Herdr Switcher's published minimums are therefore satisfied, but it is not installed.

## Shortest practical paths

### Use what already exists

Install Herdr Switcher and navigate from its VS Code sidebar. Enable `herdr.synchronizeState` only if VS Code window activation should also focus the matching Herdr Space. Accept one VS Code window per worktree.

### External Herdr with manual editor jump

Install IDE Jump and bind its action. Set:

```json
{
  "app_name": "Visual Studio Code",
  "process_name": "Code",
  "open_command": ["code", "--reuse-window", "{path}"]
}
```

This is nearly the requested workflow, but requires an explicit jump action.

### Exact automatic workflow

Build a minimal VS Code adapter modeled after Zed Workspace Sync:

1. subscribe to `workspace.focused` and, if agent panes within one workspace may point at different roots, `pane.focused`;
2. obtain the authoritative worktree path from the Herdr snapshot;
3. deduplicate repeated focus events;
4. invoke `code --reuse-window <path>` for a one-window policy, or `code <path>`/the VS Code API for a multi-window policy;
5. separately start or replace Pi in that worktree and persist `Pi thread/session ↔ Herdr workspace ↔ worktree path`.

The bridge should remain outside the VS Code extension host if it replaces the current window, because same-window `openFolder` restarts that host.
