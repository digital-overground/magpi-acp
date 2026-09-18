# Universal ACP simplification plan

**Status:** Proposed

## Goal

Make MagPi a small, standards-first ACP adapter over Pi RPC:

- Pi owns sessions, entry IDs, branching, context, commands, models, and thinking levels.
- ACP standard behavior works without Mischief metadata.
- Mischief-specific metadata only adds optional UI behavior.
- MagPi keeps custom code only where ACP or Pi RPC has no equivalent.
- Existing sessions remain readable without migration.

## Implementation order

### 1. Upgrade the ACP SDK

Complete [issue #3](https://github.com/digital-overground/magpi-acp/issues/3).

- Upgrade `@agentclientprotocol/sdk` to stable 1.4.0.
- Stay on stable ACP v1.
- Replace deprecated elicitation calls required by the SDK upgrade.
- Keep the SDK compatibility wrapper until replacing it provides a concrete benefit.
- Make no protocol behavior changes in the same commit.

This establishes current ACP types before changing MagPi's behavior.

### 2. Complete prompts on Pi settlement

Complete [issue #1](https://github.com/digital-overground/magpi-acp/issues/1).

- Treat `agent_end` as the end of one low-level run only.
- Resolve ACP prompts and start queued prompts on `agent_settled`.
- Preserve cancellation and error handling.
- Deliver final usage and pending updates before resolving the prompt.

This gives later session operations a stable point at which Pi has finished writing entries.

### 3. Replace custom targeting with Pi-native selectors

Complete [issue #4](https://github.com/digital-overground/magpi-acp/issues/4).

#### Fork

- Standard ACP fork without a target calls Pi `clone`.
- A dedicated Mischief fork picker reads Pi `get_fork_messages`.
- The selected native Pi entry ID is sent as `_meta["magpi-acp/fork-entry-id"]`.
- MagPi validates the ID and calls Pi `fork(entryId)`.
- Assistant-message fork remains unsupported because Pi RPC accepts user entries only.

#### Tree navigation

- A dedicated Mischief tree picker reads Pi `get_tree`.
- Initial navigation displays message entries only.
- Mischief sends the selected native Pi entry ID back to MagPi.
- MagPi invokes Pi's native `navigateTree` with `summarize: false`.
- Navigation reloads the same ACP session and Mischief Thread; it does not create a child.
- Until Pi exposes `navigateTree` through RPC, retain one minimal extension command that only calls it.

#### Remove

- Transcript-row fork and rollback actions.
- Composer `/tree` invocation.
- Prompt `_meta["magpi-acp/client-message-id"]`.
- Persisted `magpi-acp-client-message` entries.
- Client-ID-to-Pi-entry-ID maps.
- Assistant timestamp matching.
- Custom assistant fork behavior.
- The extension-owned tree selector.
- The private rewind method and capability.
- Tree-specific ACP elicitation handling.

Non-message tree entries and branch-summary controls remain tracked in Mischief issues [#26](https://github.com/digital-overground/mischief/issues/26) and [#27](https://github.com/digital-overground/mischief/issues/27).

### 4. Implement standard session deletion

Complete [issue #2](https://github.com/digital-overground/magpi-acp/issues/2).

- Implement idempotent ACP `session/delete`.
- Stop and remove any live process for the session.
- Remove the Pi session file safely.
- Return success when the session is already absent.
- Do not delete a different session because of a stale mapping or reused path.

## Next simplifications

### 5. Delete MagPi's `SessionStore`

MagPi currently persists another JSON file mapping ACP session IDs to Pi session files. Pi session headers already contain the session ID and working directory, and MagPi already scans those headers through `findPiSession()`.

Replace the duplicate store with Pi session discovery:

- Use Pi's session ID as the ACP session ID.
- Resolve loads, forks, and deletes through `findPiSession()`.
- Read the working directory and session file from Pi's session header.
- Remove `src/acp/session-store.ts` and its path/configuration support.
- Ignore the old MagPi map file; no migration is needed.

Before deleting it, verify that every create, load, fork, clone, and delete path uses the Pi-reported session ID and that custom Pi session directories remain discoverable.

### 6. Stop loading Pi prompt commands twice

Pi RPC provides `get_commands`, and Pi expands skill commands and prompt templates when prompting.

- Use Pi `get_commands` as the source for extension, skill, and prompt-template commands.
- Pass those commands back to Pi instead of expanding prompt files inside MagPi.
- Delete MagPi's prompt-directory scanning and file-command expansion once no caller remains.
- Keep only adapter commands backed by explicit Pi RPC operations, such as `/compact`, `/export`, `/session`, and `/name`.
- Do not restore `/tree` as a composer command.

The command list exposed over ACP should merge Pi's native command list with this small adapter-command list.

### 7. Reduce private metadata

Audit every remaining private field after the native navigation work lands.

Remove fields that duplicate standard ACP or are no longer consumed. In particular, verify removal of:

- `magpi-acp/client-message-id`;
- `magpi-acp/tree-rewind`;
- `_magpi-acp/session/rewind`;
- message IDs used only for transcript targeting.

Keep `_meta.magPiAcp` only when it adds optional Mischief presentation such as queue state or session previews. Standard fields must remain complete and authoritative when all metadata is stripped.

For every retained field:

- document its consumer;
- make absence safe;
- avoid client-name detection or a separate Mischief mode;
- remove it when ACP gains an equivalent standard field.

Add a wire test that removes all `_meta` and exercises create, prompt, clone/fork, load, and delete through standard ACP.

### 8. Advertise only negotiated capabilities

- Advertise Terminal Auth methods only when the client reports `clientCapabilities.auth.terminal === true`.
- Advertise optional ACP session methods only after their metadata-free behavior works.
- Keep private tree/fork-picker capabilities optional and namespaced.
- Do not infer support from the client name.

### 9. Handle unsupported MCP servers honestly

MagPi currently retains ACP MCP server configuration but does not forward it to Pi.

Choose one explicit behavior:

- implement forwarding when Pi exposes a native equivalent; or
- reject non-empty MCP server configuration with a clear unsupported error.

Do not silently accept configuration that will not affect the Pi session.

## Product decisions before further deletion

### Automatic titles

MagPi currently makes a separate model call to generate a short session title. Removing this would reduce code, latency, and model usage. Pi and Mischief can fall back to the first user prompt, while manual Pi session names remain supported.

Do not remove automatic titles until Mischief explicitly accepts that UI change.

### Roles

Mischief's named role profiles add a custom layer over model and thinking controls. Standard ACP model and thinking options should work independently of roles.

Keep roles only if the product still values the shortcut. Their absence must not prevent a generic ACP client from selecting a model or thinking level.

## Custom code that remains justified

### Pi session discovery

Keep the filesystem session scanner for now. Pi does not expose a headless global session-list RPC command, while ACP requires session listing and loading across processes.

The scanner should remain read-only and use Pi session headers as its source of truth.

### Tree navigation bridge

Keep the minimal bundled extension command only while Pi RPC lacks `navigateTree`. It may validate input and report native cancellation/errors, but Pi must perform all branch movement and summarization.

Delete the bridge when Pi publishes an equivalent RPC command.

### ACP translation

MagPi must continue translating Pi events into ACP updates for:

- messages and thinking;
- tool calls and structured diffs;
- plans and usage;
- permissions and elicitation;
- authentication;
- model, thinking, and session configuration.

This is MagPi's core responsibility, not removable customization.

## Validation

For each phase, add the nearest focused test and delete tests for removed behavior. Before finishing a phase, run:

`npm run format`

`npm run check`

`npm run smoke`

For coordinated Mischief changes, also run:

`pnpm format`

`pnpm check`

The final standard wire test must pass with every private `_meta` field removed.

## Completion criteria

- MagPi targets sessions and entries only with IDs created by Pi.
- Generic ACP clients can create, prompt, fork the current leaf, load, list, and delete sessions without private metadata.
- MagPi writes no custom identity markers into Pi sessions.
- MagPi stores no duplicate session map or message-ID map.
- Pi owns branch creation and same-session tree navigation.
- Mischief-specific selectors consume Pi's native fork/tree data.
- Pi commands are discovered and expanded by Pi, not reimplemented by MagPi.
- Unsupported client configuration is rejected rather than silently ignored.
- Remaining private metadata is optional, documented, and presentation-only.
- The only remaining tree extension code is the call Pi RPC does not yet expose.

## Non-goals

- Supporting ACP v2 before it stabilizes.
- Replacing Pi's session file format or session directory.
- Reimplementing Pi session listing without a native replacement.
- Assistant-message fork.
- Transcript-row fork or rollback shortcuts.
- Composer `/tree` support.
- Compatibility modes selected by client name.
- Maintaining parallel native and custom implementations of the same behavior.
