# MagPi ACP

MagPi ACP is Mischief's Agent Client Protocol adapter for Pi. It is a TypeScript process that bridges ACP JSON-RPC over stdio to a local `pi --mode rpc` subprocess.

## Architecture

- `src/acp` owns the Mischief-facing ACP server, session lifecycle, and event translation.
- `src/pi-rpc` owns the Pi subprocess and newline-delimited RPC protocol.
- `src/pi-extension` owns native Pi session-tree operations used by Mischief.
- One ACP connection keeps at most one live Pi subprocess. Mischief uses a separate Agent process for each active Thread.
- Pi performs filesystem and terminal work locally. MCP servers are retained in session state but are not forwarded.

## Mischief contract

Mischief lives in the sibling `../mischief` repository. Check its `src/threads/acp.ts` call sites when changing protocol behavior.

Use standard ACP where it covers the behavior. The current private contract fills session-tree gaps in ACP:

- `_meta["magpi-acp/client-message-id"]` anchors prompts and forks to stable Mischief message IDs.
- `magpi-acp/tree-rewind` advertises support for `_magpi-acp/session/rewind`.
- Agent message chunks include `messageId` so Mischief can target Pi responses for fork and rollback.
- `_meta.magPiAcp` carries startup information, queue state, session previews, and option descriptions consumed by Mischief.

Preserve Thread history, form elicitation, Terminal Auth, structured diffs, plans, usage, and role/model/thinking controls when changing translations.

## Coding guidelines

- Keep translation functions small and test protocol changes at the nearest existing seam.
- Be strict about stream cleanup, subprocess exit, and stdout/stderr draining.
- Prefer explicit TypeScript types; use `any` only at untyped external boundaries.
- Use comments only for non-obvious protocol decisions.
- Do not modify Mischief unless the task explicitly spans both repositories.

## Validation

Run formatting before finishing. Use `npm run format` when the whole worktree is safe to format, otherwise format only touched files.

```text
npm run check
npm run smoke
```

If formatting or validation is skipped or fails, report it.

## Source control

Do not commit unless explicitly asked.
