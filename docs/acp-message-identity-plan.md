# ACP message identity and native transcript actions

**Status:** Implemented in the `message-ids` worktree; not committed. MagPi owns Pi message identity. Mischief owns transcript display and sends only the standard ACP `messageId` for an action originating from a transcript row. See `magpi-acp-private/docs/acp-transcript-actions.md` (task MAG-1) and `mischief-private/docs/acp-transcript-actions.md` (task MIS-1) for the cross-repo handoff.

## Identity

- Pi's RPC `message_start` has no persisted entry ID, and `message_end` fires before Pi appends that entry. MagPi creates one opaque Agent-owned ACP `messageId` per real user/assistant message, stable across its live chunks. It streams immediately; it does not buffer for Pi's native ID. Thinking/status/tool chunks do not borrow the navigable ID.
- On `agent_settled`, MagPi pairs completed user/assistant events with appended Pi entries by exact count and role in Pi's append order, using a cursor taken **before** each queued prompt actually starts. It retains the live association inside the owning session only. If cursor lookup or correlation fails, the prompt can still succeed but native transcript actions fail closed. Never infer targets from message text, timestamps or client transcript position.
- `session/load` replays active-path Pi entries with their entry IDs as ACP IDs after a restart, or reuses mapped live ACP IDs within the same process. Persisted thinking blocks replay as `agent_thought_chunk` in order without a navigable response ID. Image-only user messages replay as image chunks with the user ACP ID. No Pi JSONL markers, persisted surrogate keys or extra dependencies.

## Action contexts (do not guess from ID format)

| Origin | Wire input | MagPi behavior |
| --- | --- | --- |
| Transcript user row, Fork | `session/fork` with `_meta["magpi-acp/fork-message-id"]: messageId` | Resolve ACP ID to the exact **active** Pi user entry; Pi-native fork validation still applies. |
| Transcript user/assistant row, Tree | `_magpi-acp/session/navigate-tree` with `messageId` and existing summary options | Resolve ACP ID to the exact active-branch Pi message; navigate using its native entry ID. |
| Native tree picker | `_magpi-acp/session/tree` returns Pi `tree[].entry.id` and `leafId`; navigate with `entryId` | Preserve Pi tree shape, leaf, and native navigation. No structural-ID map. |
| Native footer Fork picker | `_magpi-acp/session/fork-messages` returns `{ entryId, text }`; legacy `_meta["magpi-acp/fork-entry-id"]` | Preserve the existing picker flow until its consumer is retired. No ACP-ID matching on this response. |
| Standard untargeted `session/fork` | No target metadata | Pi-native clone of the current leaf. |

`messageId` and `entryId` navigation inputs are mutually exclusive. The two targeted fork metadata keys are mutually exclusive. Transcript actions require an idle session and an Agent-provided ID in that session; unknown, ambiguous, unmapped, wrong-role, stale or inactive-branch IDs are invalid, never silently redirected. Only tree/footer picker actions send native IDs; **Mischief never fetches target lists to match a transcript row to a Pi ID**. A streamed ID has no native action while the turn is running; after settlement a failed correlation remains unavailable rather than becoming a guessed target. All interactions except Cancel are locked in Mischief during streaming.

Example (IDs illustrative):

```text
ACP user_message_chunk  messageId=acp-u-1 text="Run tests"
ACP agent_message_chunk messageId=acp-a-1 text="Passed"
Pi entries             pi-u-31 (user), pi-a-32 (assistant)
Transcript Fork request _meta={"magpi-acp/fork-message-id":"acp-u-1"}
Transcript Tree request {messageId:"acp-a-1", summarize:false}
Tree picker response    {leafId:"pi-a-32", tree:[{entry:{id:"pi-u-31",...},children:[...]}]}
```

MagPi privately resolves `acp-u-1 → pi-u-31` or `acp-a-1 → pi-a-32`. A client must treat ACP IDs as opaque, not as Pi entry IDs. ACP v1 supports optional Agent-generated message IDs; they need not be stable across separate loads, but chunks of one message share an ID. See the [ACP message ID RFD](https://agentclientprotocol.com/rfds/message-id).

## Evidence and checks

- Pi 0.87.1 emits `message_end` before persistence. `node scripts/check-message-entry-correlation.mjs` verified event↔entry role/order on a real Pi RPC process for two identical prompts, multi-assistant tool reply, forked branch, image-only input, and cancellation. Repeat when Pi changes; do not use event order without verifying the supported version.
- Component tests cover stable live IDs, exact entry correlation, two identically worded turns, replay including thoughts/images, invalid/missing mappings, and ACP-ID→native action routing. Native picker tests verify their Pi IDs and tree shape remain unchanged. Fork and navigation both reject invalid targets and conflicting inputs.
- Validation: format touched files, run `npm run check`, `npm run smoke`, `node scripts/check-message-entry-correlation.mjs`, and `node scripts/smoke-acp-load.mjs`. Exercise a real `MagPiAcpSession` with two prompts and a tool-using reply; after load verify the active transcript still identifies the same messages. Mischief must run its separate live integration against this build. Do not commit unless asked.
