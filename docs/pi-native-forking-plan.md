# Pi-native fork migration

**Status:** Proposed

## Tracking note

This plan spans MagPi ACP and the sibling Mischief repository. Mischief keeps canonical specifications in GitHub Issues, so create linked implementation issues in both repositories after this plan is approved. Do not release an intermediate state that leaves the two projects on different fork semantics.

## Goal

Use Pi's RPC session operations as the only fork implementation:

- Standard ACP `session/fork` without MagPi metadata calls Pi `clone`, copying the current active leaf.
- Mischief's targeted fork action is available only on user messages and calls Pi `fork(entryId)`, which creates a new session immediately before that user message.
- The selected user message is restored as an editable Mischief draft.
- MagPi no longer writes client-ID markers into Pi session JSONL or invokes a bundled extension command to create forks.
- Generic ACP clients can fork without knowing any MagPi metadata.

## Confirmed decisions

- Adopt Pi's native user-message fork semantics now.
- Remove fork actions from assistant messages rather than retaining a `position: "at"` shim.
- Keep one implementation. Do not add client-name detection, a Mischief mode, or a second adapter path.
- Reuse the existing `_meta["magpi-acp/client-message-id"]` only where ACP has no standard target field. Do not introduce another fork metadata shape.
- Keep `/tree` and rollback behavior separate from this migration. Pi RPC does not currently expose same-session tree navigation, so those operations may continue to use the bundled extension.
- Do not rewrite existing Pi JSONL files. Historical `magpi-acp-client-message` entries are harmless and remain readable.

## Protocol and Pi facts

### ACP

Stable ACP v1's `session/fork` request contains `sessionId`, `cwd`, MCP servers, and `_meta`; it has no standard message target. Even in SDK 1.4.0, session fork remains marked unstable, but its wire request still has no target field.

Therefore:

- no target metadata means "fork the current session state";
- message-targeted forking remains an optional MagPi/Mischief enhancement;
- removing all `_meta` must still leave a valid standard fork flow.

### Pi RPC

The required Pi operations are:

| RPC operation   | Native behavior                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clone`         | Creates a new session from the current leaf and rebinds that RPC process to the child session.                                                     |
| `fork(entryId)` | Accepts a user-message entry ID, creates a child session before that message, returns the selected text, and rebinds the RPC process to the child. |
| `get_entries`   | Returns all session entries plus the authoritative current `leafId`; `since` returns entries appended after a known entry.                         |
| `get_tree`      | Returns the complete tree, but is not needed for the fork path.                                                                                    |

Direct RPC `fork` rejects assistant-message IDs. Pi's internal runtime supports `position: "at"`, but the RPC command does not expose that option. Removing assistant fork points is what allows MagPi to delete its custom fork bridge without changing Pi upstream.

A native fork or clone preserves copied entry IDs, writes `parentSession` in the child header, leaves the source file intact, and changes the worker process's state to the new child session.

### Minimum Pi version

Set and document Pi **0.80.4** as the minimum:

- `clone` was added in 0.68.0;
- `get_entries` was added in 0.80.3;
- `agent_settled`, needed to capture persisted entry IDs reliably, was added in 0.80.4.

Do not add a compatibility implementation for older Pi versions. Probe required RPC commands and return a clear upgrade error when they are unavailable.

## Current flow to remove

### Mischief

1. `Threads.prompt()` gives an optimistic user transcript item a Mischief UUID.
2. `AcpConnection.prompt()` sends that UUID in `_meta["magpi-acp/client-message-id"]`.
3. Fork controls are shown for both user and assistant transcript items.
4. `AcpConnection.fork()` sends the selected transcript ID in the same private metadata key.
5. After ACP returns a child session ID, Mischief registers a new Thread, loads the child, and restores selected user text as a draft.

### MagPi

1. A bundled extension command stores the incoming Mischief UUID temporarily.
2. On Pi `turn_start`, the extension appends a `magpi-acp-client-message` custom entry linking that UUID to a Pi user entry.
3. Live assistant chunks use their Pi message timestamp as an ACP `messageId`; replayed messages use Pi entry IDs.
4. Targeted fork starts a temporary Pi process on the source file, invokes another bundled extension command, and lets that extension resolve markers, direct IDs, or timestamps.
5. The extension calls Pi's internal fork with `position: "before"` for users or `position: "at"` for assistants.
6. ACP fork without private metadata fails.

The actual session creation is already performed by Pi, but identity resolution, persisted markers, and fork dispatch are custom. The target design retains only a transient external-ID-to-entry-ID correlation because ACP has no targeted-fork field.

## Target architecture

### Behavior matrix

| Request                                        | MagPi action                                         | Result                              |
| ---------------------------------------------- | ---------------------------------------------------- | ----------------------------------- |
| ACP fork with no MagPi target metadata         | Temporary worker calls Pi `clone`                    | New session at the current leaf     |
| ACP fork with a mapped live Mischief user UUID | Resolve UUID in memory, then call Pi `fork(entryId)` | New session before that user prompt |
| ACP fork with a replayed Pi user entry ID      | Validate the ID, then call Pi `fork(entryId)`        | New session before that user prompt |
| ACP fork targeting an assistant or unknown ID  | Reject as invalid parameters                         | Source remains unchanged            |

### One transient identity map

Keep Mischief's optimistic local transcript IDs. Do not add another durable identifier to its database or Pi's JSONL.

Each live `MagPiAcpSession` owns an in-memory map:

```ts
Map<clientMessageId, piUserEntryId>
```

Populate it for a normal Pi prompt as follows:

1. When the queued turn actually starts, call `get_entries` and remember the last appended entry ID. Do not snapshot when the turn is merely enqueued.
2. Send the prompt to Pi.
3. Wait for Pi `agent_settled`, not merely `agent_end`.
4. Call `get_entries` with the saved `since` cursor. For a previously empty session, read all entries.
5. Select the first newly persisted `message` entry whose role is `user` and map the request's client message ID to its Pi entry ID.
6. Resolve the ACP prompt only after this best-effort mapping step finishes.

Use entries rather than matching prompt text. This keeps duplicate prompts, transformed prompts, embedded context, and image-only prompts unambiguous.

If Pi handled the input as an adapter/extension command and persisted no user message, store no mapping. Such an item is not a valid native fork point. Mapping failure must not turn a completed model response into a failed prompt; a later targeted fork should return a precise "not a Pi user message" error.

The map needs no persistence:

- while the Thread is live, it resolves Mischief UUIDs;
- after reconnect or `session/load`, MagPi emits Pi entry IDs through standard ACP `messageId`, and Mischief already sends those IDs back after removing its `user:` display prefix;
- closing the session discards the map.

This is correlation at the protocol boundary, not a second session tree.

### Fork worker lifecycle

Continue using a short-lived Pi process for fork creation:

1. Restore or locate the source ACP session.
2. Validate that `cwd` is absolute and matches the source session's Workspace. Pi native fork does not relocate a session to another working directory.
3. Read the source `sessionFile` from Pi state.
4. Resolve and validate an optional targeted user entry ID against the source process's `get_entries` result.
5. Spawn a temporary Pi RPC process on the source file.
6. Call `clone()` when no target was supplied, otherwise `fork(entryId)`.
7. Read the child `sessionId` and `sessionFile` from `get_state`.
8. Persist that identity in `SessionStore` and dispose the worker in `finally`.

Do not call `clone` or `fork` on the source session's live process. Both commands rebind that process to the child, which would leave MagPi's source-session registry pointing at the wrong Pi session and would make the original Thread unusable.

Pi cancellation, a missing target, a non-user target, an empty-session clone, or a missing child identity must not write a `SessionStore` record.

### Standard-first contract

`MagPiAcpAgent.unstable_forkSession()` should interpret requests in this order:

1. If `_meta["magpi-acp/client-message-id"]` is absent, perform native `clone`.
2. If it is a string, resolve it to a source-session user entry and perform native `fork`.
3. If it exists with another type, reject the request as invalid.

No behavior depends on `clientInfo.name`. No private metadata is required for the standard clone path.

### Session replay

Use the same native `get_entries` response for history replay:

1. Add `PiRpcProcess.getEntries(since?)` with explicit entry and leaf types.
2. Build the active path by following `parentId` from Pi's returned `leafId`.
3. Replay message entries on that path with their Pi entry IDs as standard ACP `messageId` values.
4. Preserve the existing full-history behavior across compaction; do not replace it with `get_messages`, which represents model context rather than the complete visible branch.

This removes direct JSONL reading from `src/acp/pi-session-tree.ts` while retaining only the small path-walk Pi does not currently expose over RPC.

Session discovery and previews may continue scanning Pi's session directory. Replacing the list implementation is unrelated to fork semantics.

### Remaining bundled extension scope

After this migration, `src/pi-extension/tree.ts` should own only behavior that Pi RPC does not expose:

- interactive `/tree` navigation;
- private same-session rewind/rollback.

Delete from the extension:

- the client-message marker command and pending marker state;
- `magpi-acp-client-message` writes;
- the custom fork command;
- fork-specific marker/timestamp resolution.

For rollback, MagPi should resolve a live user UUID through the same in-memory map before invoking the rewind command. Replayed user IDs already resolve directly. Existing assistant rollback may retain its timestamp-to-entry fallback; changing rollback semantics is outside this fork migration.

## Implementation phases

### Phase 0: Land prerequisites

1. Complete MagPi issue #1 so prompt completion waits for Pi `agent_settled`.
2. Complete the stable ACP SDK 1.4.0 upgrade in both repositories as separate changes; do not combine SDK migration debugging with fork behavior debugging.
3. Document Pi 0.80.4 as the minimum supported runtime.
4. Pin the behavior matrix above in tests before deleting the old path.

### Phase 1: Restrict Mischief to native fork points

This phase is safe to release against the current MagPi because user-message forks already work there.

1. In `src/threads/threads.ts`, accept only a selected `user` transcript item in `Threads.fork()`.
2. In `src/webview/threads/detail/composer/controls/history-control.tsx`, render **Fork from this message** only for user messages. Keep rollback available on both existing message kinds.
3. Preserve the idle-state guard, child Thread registration, load, naming, and selected-user draft restoration.
4. Update tests to prove assistant entries have no fork action and cannot reach `AgentConnection.fork()`.

Do not add a replacement "fork after assistant" action. Current-leaf clone remains available through standard ACP, not as a second Mischief UI workflow in this change.

### Phase 2: Add native Pi RPC primitives

In MagPi:

1. Add `clone` and `get_entries` to `PiRpcCommand`.
2. Add typed `PiRpcProcess.clone()` and `PiRpcProcess.getEntries(since?)` methods.
3. Make both methods validate `success`, cancellation, and response shape consistently with `fork()`.
4. Change `SessionManager.fork()` to accept an optional Pi user entry ID:
   - absent → worker `clone()`;
   - present → worker `fork(entryId)`.
5. Return/store only the identity reported by the child worker's `get_state`.

Keep this wrapper small; do not mirror Pi's complete RPC type package or add a new dependency.

### Phase 3: Replace persistent markers with transient correlation

1. Snapshot the source entry cursor when each real Pi turn starts.
2. After `agent_settled`, obtain the new entries and record the client-user-ID-to-Pi-entry-ID mapping.
3. Add a `MagPiAcpSession` method that resolves a candidate fork target:
   - mapped live UUID → mapped Pi entry ID;
   - direct replay ID → itself;
   - anything else → no target.
4. Validate that the resolved entry exists in this source session and is a user `message` entry.
5. Use the same resolver before user-message rollback so removing markers does not regress live rollback.
6. Keep mapping optional for ordinary ACP prompts with no private message ID.

Tests must use repeated identical text and an image-only prompt so the implementation cannot regress to text matching.

### Phase 4: Route ACP fork directly to Pi

1. Validate fork `cwd` as new/load already do, then reject a Workspace mismatch.
2. Treat missing target metadata as native clone.
3. Treat valid target metadata as a user-message target and resolve it through the source session.
4. Pass only the resolved Pi entry ID to `SessionManager.fork()`.
5. Map Pi's invalid-entry and cancelled results to useful ACP errors.
6. Preserve the source process and source `SessionStore` record.

At this point, a generic ACP client can use the advertised fork capability without private metadata.

### Phase 5: Use native entries for replay

1. Replace file reads in `activeSessionMessages()` with a pure helper over `get_entries` data and `leafId`.
2. Update `loadSession()` to request entries from its already-running Pi process.
3. Keep replayed user and assistant `messageId` values equal to Pi entry IDs.
4. Cover branched and compacted sessions, malformed parent links, and an empty session.
5. Delete `userMessageEntryId()` and file-I/O-only tests once no caller remains.

Do not broaden this phase into a session-list rewrite.

### Phase 6: Delete the old fork integration

Remove:

- `MAGPI_ACP_MARK_CLIENT_MESSAGE_COMMAND`;
- `MAGPI_ACP_FORK_CLIENT_MESSAGE_COMMAND`;
- `MAGPI_ACP_CLIENT_MESSAGE_ENTRY_TYPE`;
- `PiRpcProcess.markClientMessage()`;
- `PiRpcProcess.forkClientMessage()`;
- marker append/listen logic in `src/pi-extension/tree.ts`;
- fork registration in the bundled extension;
- marker and assistant-fork tests;
- README claims that forks can target assistant responses.

Keep:

- `_meta["magpi-acp/client-message-id"]` for live prompt correlation and targeted user forks;
- direct `PiRpcProcess.fork(entryId)`;
- the bundled extension's `/tree` and rewind code;
- historical marker entries in existing JSONL files.

Review the final tree to ensure there is one fork creator: `SessionManager.fork()` dispatching to Pi RPC `clone` or `fork`.

### Phase 7: Roll out and verify

Release order:

1. Release Mischief's user-only fork UI first.
2. Release MagPi's native clone/direct-fork implementation second.
3. Update setup documentation to require the paired versions and Pi 0.80.4 or newer.

This order lets the new Mischief work with the old MagPi during rollout. Do not promise that an old Mischief can fork assistant messages through the new MagPi; the new MagPi should reject those targets rather than silently cloning or choosing another user message.

Existing sessions require no migration. Restarting or loading a Thread naturally replaces live Mischief UUIDs with replayed Pi entry IDs.

## Test plan

### MagPi unit tests

- `PiRpcProcess.clone()` sends exactly `{ type: "clone" }` and rejects unsuccessful or cancelled responses.
- `PiRpcProcess.getEntries(since)` preserves the cursor and validates `entries` plus `leafId`.
- `SessionManager.fork()` calls clone with no target and fork with a target, always disposes the worker, and stores only a valid child identity.
- Live prompt correlation maps the first new user entry after the saved cursor.
- Duplicate prompt text maps to distinct entry IDs.
- An image-only user message receives a mapping.
- A handled slash/extension command with no Pi user entry receives no mapping.
- A replayed Pi user entry ID validates without an in-memory map.
- Unknown, foreign-session, and assistant entry IDs are rejected.
- User rollback resolves a live UUID after markers are removed.
- Active-path replay follows the returned `leafId`, not the last array element.

### MagPi component and wire tests

- A `session/fork` request with no `_meta` clones the current leaf.
- A targeted user request forks immediately before the selected prompt.
- The source session ID, file, active leaf, and transcript remain unchanged.
- The child has a new session ID/file, a `parentSession` header, and copied entry IDs.
- Loading the child replays only its active branch with standard message IDs.
- Stripping every `_meta` field still leaves a usable standard new → prompt → fork → load flow.
- Empty-session clone and cancelled Pi fork fail without adding a store record.
- Fork `cwd` mismatch fails before spawning a worker.
- Newly written JSONL contains no `magpi-acp-client-message` entries.

Add the no-metadata fork flow to the smallest existing smoke script rather than creating another smoke harness.

### Mischief tests

- The history menu shows fork only for user messages and keeps rollback on assistant messages.
- `Threads.fork()` ignores/rejects an assistant item even if called outside the Webview.
- A live user UUID is still sent through the existing MagPi metadata key.
- A replayed `user:<pi-entry-id>` target is reduced to the raw Pi entry ID.
- A successful fork creates one child Thread, loads it, and restores the selected prompt as one draft.
- A failed fork creates no Thread and leaves the source selected.
- Existing Thread history and rollback tests remain green.

### Manual check

1. Start a Thread and send two prompts, including duplicate text once.
2. Fork from the second user prompt.
3. Confirm the source Thread is unchanged.
4. Confirm the child transcript ends before the selected prompt and the composer contains that prompt as a draft.
5. Confirm assistant history rows have rollback but no fork action.
6. Reload both source and child, then fork a replayed user message.
7. Invoke a metadata-free ACP fork and confirm it clones the current leaf.
8. Inspect the new Pi files and confirm no client-message marker entries were written.

## Expected file changes

### MagPi ACP

| File                                           | Purpose                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| `src/pi-rpc/process.ts`                        | Add native `clone`/`get_entries`; remove marker/custom-fork methods     |
| `src/pi-rpc/tree-command.ts`                   | Remove marker and custom-fork constants                                 |
| `src/pi-extension/tree.ts`                     | Retain tree/rewind only                                                 |
| `src/acp/session.ts`                           | Capture transient ID mappings and dispatch clone/direct fork            |
| `src/acp/agent.ts`                             | Standard no-metadata clone, targeted user validation, RPC-backed replay |
| `src/acp/pi-session-tree.ts`                   | Pure active-path selection from native entries and leaf                 |
| `test/helpers/fakes.ts`                        | Model clone, entries, and settled events                                |
| `test/unit/session-fork.test.ts`               | Clone and targeted native worker behavior                               |
| `test/unit/pi-session-tree.test.ts`            | Leaf-based active path                                                  |
| `test/unit/pi-tree-extension.test.ts`          | Tree/rewind scope after fork code removal                               |
| `test/unit/builtin-commands.test.ts`           | ACP fork routing and target validation                                  |
| `test/component/session-list-and-load.test.ts` | Native-entry replay IDs                                                 |
| `scripts/smoke-acp.mjs`                        | Metadata-free standard fork flow                                        |
| `README.md`                                    | Pi floor and user-message-only targeted semantics                       |

### Mischief

| File                                                               | Purpose                                   |
| ------------------------------------------------------------------ | ----------------------------------------- |
| `src/threads/threads.ts`                                           | Enforce user-only fork targets            |
| `src/threads/threads.test.ts`                                      | User fork success and assistant rejection |
| `src/webview/threads/detail/composer/controls/history-control.tsx` | Hide fork on assistant rows               |
| Relevant Webview control test                                      | Verify visible actions by message kind    |
| `CONTEXT.md` / `README.md` if wording exists                       | Record Pi-native user-message semantics   |

Avoid changing persistence schemas, adding dependencies, or introducing new modules unless the existing files cannot hold the behavior cleanly.

## Validation

Run focused tests after each phase. Before finishing, run:

`npm run format`

`npm run check`

`npm run smoke`

Then in `../mischief` run:

`pnpm format`

`pnpm check`

If either worktree contains unrelated changes that make whole-tree formatting unsafe, format only touched files and report that choice.

## Acceptance criteria

- Standard ACP fork works with no private metadata and maps to Pi `clone`.
- Mischief targeted fork is offered only for user messages and maps to Pi `fork(entryId)`.
- Assistant-message fork support and its custom `position: "at"` command are gone.
- MagPi writes no new client-message marker entries.
- The existing private client message ID is correlated only in memory and is never required for a generic ACP client.
- Source and child sessions remain independently loadable.
- Forked user text is restored as a Mischief draft exactly once.
- Replay uses Pi entry IDs from native RPC data.
- `/tree` and rollback continue to work.
- No session schema migration, new runtime dependency, client mode, or Pi upstream change is introduced.
- MagPi and Mischief checks and smoke tests pass.

## Deliberate non-goals

- Forking at an assistant response.
- Reimplementing Pi's internal `position: "at"` behavior in MagPi.
- Adding a custom fork-position enum to ACP metadata.
- Replacing same-session `/tree` navigation or rollback before Pi exposes equivalent RPC commands.
- Persisting Mischief-to-Pi ID maps.
- Rewriting historical session JSONL.
- Replacing session discovery/preview scanning.
- Supporting Pi versions older than 0.80.4.
