# Package Pi with MagPi ACP

**Status:** Proposed

## Goal

Installing `magpi-acp` also installs a tested Pi version, as the Claude and Codex ACP packages install their underlying agents. A user should not need a separate global `pi` executable to create a session, restore one, generate a title, or authenticate. Pi continues to own credentials, settings, extensions, and session files in the user's Pi directory; packaging must not move or reset them.

## Current gap

`package.json` does not depend on `@earendil-works/pi-coding-agent`. `src/pi-rpc/command.ts` defaults to `pi`/`pi.cmd` on `PATH` unless `MAGPI_ACP_PI_COMMAND` is set. Pi RPC, title generation, version reporting, and `--terminal-login` use that command; `/changelog` searches PATH or the global npm root, and startup advice suggests updating Pi globally. Merely adding a dependency will not make its local npm binary appear on a subprocess's ordinary `PATH`.

## Work

1. Add a **tested, exact** `@earendil-works/pi-coding-agent` runtime dependency and update `package-lock.json`. Raise MagPi's Node engine floor if the selected Pi release requires it. Keep Pi as an npm dependency, not a second copy in `dist` or a separate MagPi updater. Publish a new MagPi version when moving to a newer tested Pi release.
2. Resolve the installed dependency's declared `pi` executable relative to the running MagPi package. Use one shared launch specification for every Pi invocation; running its JS CLI with Node avoids relying on PATH or Windows `.cmd` shims. Precedence: an explicit `MAGPI_ACP_PI_COMMAND` remains authoritative, otherwise use the packaged Pi. Preserve existing behavior for explicit executable overrides. If the packaged dependency is absent or unusable, fail with a clear installation error rather than silently running an unrelated global Pi.
3. Apply that resolution to `PiRpcProcess.spawn()` (new, restored, and forked sessions), `src/index.ts` (`--terminal-login`), and `src/acp/agent.ts` (title generation, version/startup information, and `/changelog`). Terminal Auth must relaunch the same MagPi installation and reach the same Pi; the packaged Pi's changelog should be found without `which pi` or `npm root -g`. Replace the startup suggestion to update Pi globally with MagPi-managed update guidance when using the packaged dependency; an explicit override remains the caller's responsibility.
4. Update `README.md` and the registry-readiness note: installing MagPi is sufficient to install Pi, while a model provider and authentication are still the user's responsibility. Document how to opt back into a separately installed Pi using `MAGPI_ACP_PI_COMMAND` and how Pi updates arrive through MagPi releases.

## Verification

- Unit-check resolution precedence, missing/corrupt dependency errors, Windows paths with spaces, and the shared command used by Pi RPC, title generation, version lookup, and Terminal Auth. Retain the existing explicit-override and `pi`-not-found tests, adjusting their expected guidance.
- Install a packed MagPi release into a clean temporary prefix with no global `pi` on `PATH`. Verify the published dependency and executable, `initialize`, a real session/prompt/load, and interactive `--terminal-login` with the same installed Pi. Check `/changelog` and startup guidance. Use a configured provider for the live prompt; do not treat an authentication prompt as an installation failure.
- Format only touched files while the worktree has unrelated edits (or run `npm run format` in a clean worktree), then run `npm run check`, `npm run smoke`, and `npm pack --dry-run`. Verify on Windows as well as a Unix host; npm's local binary layout differs.

## Downstream and non-goals

Mischief currently installs Pi and MagPi separately and invokes `pi install` for recommended add-ons. After MagPi publishes the packaged dependency, Mischief can install/update only `magpi-acp`, but must use the managed Pi for add-on setup rather than assume a global `pi`. That is a separate Mischief change; do not make it in this repository.

Do not add a second Pi version checker, change Pi's session or configuration storage, bundle Pi into MagPi's compiled JS, or change ACP methods for this packaging work.
