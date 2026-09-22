# MagPi ACP codebase review

> **Scope:** the current `dev` worktree at `3969a6f`, including the pre-existing uncommitted changes.
> **Lenses:** Ponytail whole-repository complexity review and Matt Pocock's deep-module design vocabulary.
> **Out of scope:** this is not a dedicated correctness, security, or performance-defect review.

## Executive summary

MagPi's architectural direction is sound. The important seams are in the right places: ACP transport, Pi RPC, filesystem session discovery, and the temporary Pi tree extension are separate. `MagPiAcpSession` is also a genuinely deep module: a small turn-oriented interface hides a large event/state implementation.

The repository does not need a rewrite. Its main costs are historical residue, weak test seams around the Pi subprocess, and two broad orchestration paths in `src/acp/agent.ts`. The lazy sequence is:

1. Delete stale scripts, stale plans, copied tests, and dead members.
2. Formalize the Pi seam that the tests already fake.
3. Put adapter commands and replay translation behind two small interfaces.
4. Type only the Pi payloads MagPi actually consumes.

A conservative immediate cleanup can remove roughly **1,100 lines with no dependency changes** before any architectural refactor.

## Evidence snapshot

| Signal                                           |                                    Current result |
| ------------------------------------------------ | ------------------------------------------------: |
| Production TypeScript                            |                                      ~4,520 lines |
| Tests                                            |                                      ~4,098 lines |
| Standalone scripts                               |                                         710 lines |
| Tests                                            |                                       117 passing |
| Experimental test coverage                       | 89.75% lines / 70.08% branches / 81.92% functions |
| Source `as any` casts                            |                                                80 |
| Test `as any` casts                              |                               269 across 21 files |
| Direct `session.proc` calls in `agent.ts`        |                                                26 |
| Direct `sessionUpdate` calls in `agent.ts`       |                                                38 |
| Repeated `MagPiAcpSession` construction in tests |                      36, including 33 in one file |
| Unreferenced secondary smoke scripts             |                               9 files / 602 lines |
| Runtime dependencies removable                   |                                                 0 |

Complexity probes identified four orchestration hotspots:

| Location                          |      Size | Cyclomatic complexity |
| --------------------------------- | --------: | --------------------: |
| `MagPiAcpAgent.prompt()`          | 457 lines |                    92 |
| `MagPiAcpSession.handlePiEvent()` | 348 lines |                    86 |
| `MagPiAcpAgent.loadSession()`     | 195 lines |                    52 |
| `MagPiAcpAgent.newSession()`      | 132 lines |                    15 |

These numbers are evidence, not a demand to split every function. A protocol-union dispatcher can be large and still be a deep module.

## Current architecture

```text
ACP client
    │ JSON-RPC / NDJSON
    ▼
src/index.ts
    │
    ▼
MagPiAcpAgent                         Pi session files
    │ ACP lifecycle/config/replay          ▲
    ├──────────────► pi-sessions.ts ───────┘
    │
    ├──────────────► SessionManager
    │                    │
    │                    ▼
    └──────────────► MagPiAcpSession
                         │ turn queue + event translation
                         ▼
                    PiRpcProcess
                         │ newline RPC
                         ▼
                    pi --mode rpc
                         │
                         └── bundled tree extension for missing native RPC
```

The sibling Mischief consumer confirms that the current private contract is narrow and actively used: fork/tree picker capabilities, branch-summary metadata, the three tree/fork extension methods, and `magpi-acp/fork-entry-id`.

## Deep-module scorecard

| Module                                            | Assessment                                         | Why                                                                                                                                                                                                |
| ------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PiRpcProcess`                                    | **Deep, but leaky**                                | It correctly hides process creation, NDJSON correlation, draining, and exit behavior. Returning `unknown` for core responses pushes Pi schema knowledge back into callers.                         |
| `MagPiAcpSession`                                 | **Deep**                                           | `prompt()`, `cancel()`, and event wiring hide queueing, tool state, diff snapshots, elicitation, usage, and ordered emission. The public `proc` escape hatch weakens the interface.                |
| `SessionManager`                                  | **Medium depth**                                   | It earns its existence through process lifecycle and native fork/clone behavior, but its map-oriented interface exposes lifecycle decisions to `MagPiAcpAgent`.                                    |
| `pi-sessions.ts`                                  | **Deep**                                           | A small discovery interface hides Pi's filesystem layout and bounded reads. Internal metadata parsing repeats work and knowledge.                                                                  |
| `translate/prompt.ts` and `translate/pi-tools.ts` | **Deep enough**                                    | Small pure interfaces hide irregular external payloads and are easy to test.                                                                                                                       |
| `translate/bash.ts`                               | **Shallow**                                        | Eight exported helpers make both live and replay callers understand the assembly order and ACP terminal metadata details.                                                                          |
| `pi-extension/tree.ts`                            | **Appropriately deep and minimal**                 | One narrow adapter exists only because Pi RPC lacks native tree navigation. It should remain small and be deleted when Pi exposes the operation.                                                   |
| `MagPiAcpAgent`                                   | **Deep external interface, low internal locality** | ACP callers see a useful interface, but command execution, startup policy, replay, configuration, title generation, version checking, and lifecycle restoration all change in one 1,700-line file. |

## Prioritized architecture findings

### A1. The real Pi seam exists in tests but not in the types

**Evidence**

- `MagPiAcpSession` accepts the concrete `PiRpcProcess`, so every fake is cast with `as any`.
- Seven test files replace the private `agent.sessions` field.
- Four test files monkey-patch `PiRpcProcess.spawn`.
- Tests use `Object.create(PiRpcProcess.prototype)` and `Reflect.construct()` to reach process behavior.
- `PiRpcProcess` has only 70.36% line and 49.06% function coverage, while most translation modules exceed 84% line coverage.

**Design reading**

Pi is a true external dependency. Production `PiRpcProcess` and the in-memory test fake are two real adapters, so this is not a hypothetical seam.

**Minimum move**

- Give `MagPiAcpSession` a small structural port containing only the operations it uses: event subscription, prompt, abort, stats, UI response, and disposal.
- Inject a `spawnPi` function into `SessionManager` instead of patching the static class method.
- Let `MagPiAcpAgent` receive its session manager through a small optional constructor dependency used by tests.

Do not add a DI container, factory hierarchy, or a complete Pi interface.

### A2. Adapter commands need one deep module, not eight inline branches

`MagPiAcpAgent.prompt()` contains command parsing and implementations for compact, session stats, naming, steering, follow-up, changelog, export, and auto-compaction (`src/acp/agent.ts:415-868`). Their advertisement lives separately at `src/acp/agent.ts:88-128`.

That split makes command names, descriptions, parsing, and execution a distributed interface. It also accounts for most of the method's 457 lines and complexity score of 92.

**Minimum move:** put advertisement and execution behind one interface such as `adapterCommands.available` plus `adapterCommands.handle(input, context)`. Keep all commands in one module; one class or file per command would be shallower and worse.

A smaller first step is still worthwhile: add local helpers for text updates, mode updates, and command advertisement. There are 38 direct ACP update envelopes in `agent.ts`, and the command-advertisement block is duplicated after both new and load.

### A3. Live and replay translation do not share enough implementation

Live tool events are assembled in `MagPiAcpSession.handlePiEvent()` while historical tool results are rebuilt in `MagPiAcpAgent.loadSession()`. Bash translation is partly shared, but callers still coordinate eight low-level helpers from `translate/bash.ts`.

This weakens locality: a terminal, raw-output, status, or diff change must be checked in both live and replay paths.

**Minimum move:** deepen the existing translation module so callers request complete ACP update sequences for:

- a live bash start/update/end;
- a replayed bash execution;
- a replayed non-bash tool result.

Keep queue state, partial-output snapshots, and file snapshots inside `MagPiAcpSession`; those are live-session concerns and should not be generalized.

The current branch-summary change also exposes a magic synthetic message role (`branchSummary`) from `activeSessionMessages()`. An explicit replay-item union would keep filesystem representation inside the replay module and make branch summaries impossible to confuse with Pi messages.

### A4. Pi payload knowledge leaks through `unknown`

`getState()`, `getAvailableModels()`, `getSessionStats()`, `getMessages()`, and `getCommands()` all return `unknown`. Callers repeatedly cast and reinterpret their shapes. This is a major source of the 80 source-level `as any` casts.

**Minimum move:** define only the minimal payload types MagPi consumes and return those from `PiRpcProcess`. Validate fields that control identity or protocol behavior at the process seam. Do not mirror Pi's complete RPC schema and do not introduce another schema dependency.

The same locality issue appears in thinking levels: the seven legal values are repeated in `agent.ts`, `pi-settings.ts`, and `pi-rpc/process.ts`. One `THINKING_LEVELS as const` plus its derived type is enough.

### A5. Session lifecycle does not encode the one-process invariant

Project documentation says one ACP connection has at most one live Pi subprocess, but `SessionManager` stores an arbitrary `Map<string, MagPiAcpSession>` and callers remember to invoke `closeAllExcept()`.

The manager's interface also leaves restoration in `MagPiAcpAgent`, exposes `session.proc`, and causes test-only optional calls such as `(this.sessions as any).closeAllExcept?.(...)`.

**Minimum move:** first inject and type the manager as described in A1. Then either:

- encode the invariant as one current session slot; or
- deepen the manager so `require(sessionId)` owns restore/reuse/replacement and callers no longer coordinate its map.

Do not add a repository interface around the map.

### A6. State/configuration is fetched repeatedly instead of derived once

`getSessionConfiguration()` calls `getModelState()` and `getThinkingState()` in parallel; without a preloaded state, both issue `get_state`. `PiRpcProcess.spawn()` performs a best-effort `get_state`, `SessionManager.create()` asks again, and `newSession()` asks again.

**Minimum move:** fetch state and available models once per configuration refresh, then pass them to pure builders. If spawn-time directory creation still needs state, return/cache that initial state rather than silently repeating the request.

This deepens the configuration interface and removes nested async fallback code without adding a new module.

### A7. Session-file metadata is parsed in repeated passes

For every listed session, the same tail is parsed independently by `pickTitleFromTail()`, `pickUpdatedAtFromTail()`, and `pickPreviewFromTail()`. If no title exists in the tail, one full-file pass searches for a name and another fallback may read the full file again for the first user message.

**Minimum move:** parse the bounded tail once into metadata, and combine full-file fallback title/name discovery into one pass. Keep the public synchronous scanner interface; it is already a useful deep module and its temp-directory tests are a good local substitute.

Do not build a generic JSONL repository. Native Pi session listing, when available, should delete this implementation rather than sit under another layer.

### A8. Agent documentation describes a contract that no longer exists

`AGENTS.md:19-21` says MagPi uses `magpi-acp/client-message-id`, tree rewind, rollback, and message IDs. None appears in current source; tests explicitly expect replay message IDs to be absent. The actual Mischief call sites use `magpi-acp/fork-entry-id`, picker capabilities, tree methods, and branch-summary metadata.

This is an AI-navigability problem: the repository's strongest instruction file sends future agents toward deleted architecture.

**Minimum move:** update `AGENTS.md` to the current private contract and convert `docs/universal-acp-simplification-plan.md` from a fully “Proposed” plan into a short status/remaining-work document.

## Ponytail audit: ranked cuts

| Rank | Finding                                                                                                                                                                                                                                                                                                              |
| ---: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | `scripts/smoke-{acp-load,changelog,compact,export,modes,newsession-intro,queue,session,startupinfo}.mjs`: **delete:** 602 lines of unreferenced, mostly duplicated harnesses; `npm run smoke`, CI, and release tooling invoke none of them. Keep one wire smoke and move any unique assertion into an existing test. |
|    2 | `docs/pi-native-forking-plan.md`: **delete:** 413-line superseded proposal describing client-message markers and rewind behavior removed by the newer native picker architecture. Git history is the archive.                                                                                                        |
|    3 | `test/component/session-events.test.ts` and `test/helpers/fakes.ts`: **shrink:** 33 copies of session construction plus 32 event-loop drains. One `createTestSession()` fixture preserves coverage with roughly 150-200 fewer lines.                                                                                 |
|    4 | Seven test-local `FakeSessions` classes: **shrink:** repeated private-field fakes. One typed manager adapter after A1 replaces them.                                                                                                                                                                                 |
|    5 | `src/acp/agent.ts:443-856,1195-1213`: **shrink:** repeated `sessionUpdate` envelopes and duplicated command advertisement. Two local helpers remove roughly 80-100 lines without a framework.                                                                                                                        |
|    6 | `test/unit/merge-commands.test.ts` and `test/unit/stdout-destroyed-does-not-crash.test.ts`: **delete:** both test copied local implementations instead of production code. Delete the 51 lines or test an extracted production function; copied tests provide no regression protection.                              |
|    7 | `src/pi-rpc/process.ts:20-31,113,124-130,263-266`: **delete:** prelude capture and ANSI stripping have no caller. Nothing replaces them; if capture returns later, Node's `stripVTControlCharacters()` replaces the custom regex.                                                                                    |
|    8 | `src/acp/session.ts:325-329,380,562,584,902,921`; `src/pi-rpc/process.ts:389-392`; `src/acp/pi-sessions.ts:389-391`: **delete:** unused `SessionManager.get()`, write-only `inAgentLoop`, `switchSession()`, and `findPiSessionFile()`. Nothing replaces them.                                                       |
|    9 | `src/acp/agent.ts:541-634`: **shrink:** steering and follow-up handlers are the same delivery-mode operation with different state keys/setters. One private handler removes roughly 30-40 lines.                                                                                                                     |
|   10 | `src/acp/pi-sessions.ts:116-269,305-351`: **shrink:** three tail parses and two fallback scans. One metadata pass replaces them.                                                                                                                                                                                     |
|   11 | `src/acp/translate/pi-messages.ts:10-17`: **shrink:** `normalizePiAssistantText()` is a restricted duplicate of `normalizePiMessageText()`. Use the general normalizer and delete the second function.                                                                                                               |
|   12 | `src/acp/session.ts:32,315,342,356,397,404`: **yagni:** `mcpServers` is threaded into a property that is never read. Reject unsupported non-empty input or remove the storage until forwarding exists.                                                                                                               |
|   13 | `.vscode/settings.json`: **delete:** repository-wide editor colors have no product, build, or protocol role. Keep only if this is intentional project branding.                                                                                                                                                      |

### Product-decision cuts

These are whole features, not refactoring targets. Keep them intact if the product values them; otherwise delete the slice rather than abstracting it further.

- `src/acp/agent.ts:873-910,1550-1607` plus tests: automatic title generation adds a second Pi process, model usage, and lifecycle state. First-user-message titles plus manual `/name` are the simpler product.
- `src/acp/agent.ts:1609-1664`: the synchronous npm update check adds custom semver logic and startup network policy. Package managers already own updates.
- Role presets across `pi-settings.ts`, `agent.ts`, README, and tests duplicate standard model/thinking controls. Keep only if the shortcut is materially used.

These conditional cuts are excluded from the conservative net estimate.

## Test architecture

### What is good

- The suite is fast: 117 tests complete in about two seconds.
- Filesystem discovery uses temporary directories rather than mocking `fs`; this is a good local-substitutable seam.
- Most event translation is tested through observable ACP updates.
- Coverage is high where the code has a usable interface: `session.ts` is 95.92% line-covered and the pure translators are mostly 84-100% covered.
- Fork/clone worker disposal, structured diffs, queueing, elicitation, configuration, branch replay, and terminal metadata all have focused checks.

### What to change

1. Replace private/static monkey-patching with the small Pi and manager seams from A1.
2. Delete the exact duplicate `cancel clears queued prompts` test in `session-queue-cancel.test.ts`; the same behavior is covered at `session-events.test.ts:1079`.
3. Delete tests of copied code; either cross a real interface or do not test the trivial helper.
4. Add one shared session fixture before adding more event cases.
5. Test the entrypoint transport through production code. `src/index.ts` is absent from coverage, and the stdout regression test currently copies its writer.
6. Replace old shallow-module tests when deeper interfaces land; do not layer new tests on top of every old helper test.

## Dependency review

No runtime dependency should be removed or added.

- `@agentclientprotocol/sdk` is the core protocol implementation.
- `zod` has no direct import, but it is a required peer dependency of SDK 1.4.0 and therefore is not dead.
- The development dependencies are all used by linting, formatting, TypeScript execution, or bundling.

The repository already follows the right dependency strategy: Node standard library plus the protocol SDK.

## Recommended sequence

### Phase 1 — delete residue

- Remove the nine unreferenced smoke scripts.
- Remove the superseded native-fork plan.
- Remove duplicate/copied tests and dead members.
- Update `AGENTS.md` and the status of the universal simplification plan.

This phase is low risk and should make the later shape easier to see.

### Phase 2 — make the existing seam testable

- Add the narrow `MagPiAcpSession` Pi port.
- Inject `spawnPi` into `SessionManager`.
- Stop mutating private agent fields in tests.
- Add one shared test-session fixture.

This is the highest-leverage architectural change because it improves both production types and test locality.

### Phase 3 — deepen two implementation clusters

- Put adapter command advertisement and execution together.
- Make replay/tool translation return complete ACP updates.
- Keep the event state machine and all commands as cohesive modules; do not fan them into classes.

### Phase 4 — tighten data locality

- Type only consumed Pi response shapes.
- Fetch state once per configuration refresh.
- Consolidate thinking-level knowledge and session metadata parsing.

Re-measure after each phase. Do not plan another layer until a concrete caller still has to know too much.

## What not to build

- No dependency-injection framework.
- No class or factory per slash command.
- No generic repository over Pi session files.
- No complete local mirror of Pi RPC types.
- No new schema/validation dependency.
- No event-handler file per Pi event.
- No replacement for the tree extension until Pi exposes native RPC navigation.
- No architecture rewrite justified only by file length or cyclomatic complexity.

## Validation performed

| Command/probe                                            | Result                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `npm run check`                                          | Passed: lint, typecheck, 117 tests, and build                                             |
| `npm run smoke`                                          | Passed: metadata-free new → prompt → fork → load flow                                     |
| Experimental Node test coverage                          | Passed; 89.75% line coverage overall, excluding the unimported entrypoint                 |
| `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` | Found one issue: write-only `MagPiAcpSession.inAgentLoop`                                 |
| Temporary ESLint complexity probe                        | Identified the four orchestration hotspots listed above; not a configured project failure |

The test runner emits Node's `DEP0205` warning for `module.register()` through the `tsx` loader; this is dependency/tooling noise, not a MagPi architecture finding.

## Bottom line

The codebase's principal modules are mostly at the correct seams. Delete the historical residue first, then deepen the already-real Pi, command, and replay seams. Splitting files for their own sake would make the system shallower.

**net: -1,100 lines possible, -0 deps.**
