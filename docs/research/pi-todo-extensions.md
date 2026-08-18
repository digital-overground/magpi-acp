# Pi todo extension research

Research date: 2026-08-14

## Recommendation

Use [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo):

```sh
pi install npm:@juicesharp/rpiv-todo
```

Restart Pi afterward. The package registers a `todo` tool and `/todos`, maintains explicit `pending`, `in_progress`, `completed`, and `deleted` states, reconstructs state from session history, and supports headless Pi sessions even though its overlay is TUI-only. Its result snapshots use `details.tasks`, with each task containing `subject` and `status`; that maps directly to ACP plan entries.

## Is there an official or community-preferred extension?

There is no official preferred package. Pi deliberately has no built-in todo system; its README says built-in todos confuse models and recommends `TODO.md` or a user-selected extension. Pi does ship an official [`examples/extensions/todo.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/todo.ts), but the file describes itself as an example and is not a separately versioned package.

The clearest available adoption signal favors `@juicesharp/rpiv-todo`. The npm downloads API reported 43,055 downloads in the last month on 2026-08-14. Comparable packages measured at the same time:

| Package                    | Last-month downloads |
| -------------------------- | -------------------: |
| `@juicesharp/rpiv-todo`    |               43,055 |
| `@nguyenquangthai/pi-todo` |                3,303 |
| `@99percentpeople/pi-todo` |                2,364 |
| `@pi9/todo`                |                1,670 |
| `pi-todo-rail`             |                  996 |
| `pi-todo-md`               |                   59 |

Downloads do not prove quality, but `rpiv-todo` also has active releases, focused tests, session isolation, compaction/reload recovery, explicit statuses, and documented headless behavior. Those properties fit Pi through ACP better than the minimal official example.

## Alternatives

- **Official example:** smallest and easiest to audit. It stores branch-aware snapshots in tool results, but supports only `add`, `list`, `toggle`, and `clear`; tasks have only `text` and `done`. Install by copying the example into `~/.pi/agent/extensions/todo.ts`.
- **`@99percentpeople/pi-todo`:** atomic full-list updates, dependencies, stale-revision rejection, branch-aware and compaction-safe state. More sophisticated than needed here.
- **`@pi9/todo`:** phased plans, explicit statuses, widgets, and adaptive reminders. Good when phases are important; heavier for a simple Zed checklist.
- **`pi-todo-rail`:** strong human-facing Pi TUI controls and branch-aware state, but lower adoption and much of its value is terminal UI that ACP/Zed will not display.
- **Repo-local `TODO.md`:** Pi's preferred zero-extension option, but it cannot naturally drive Zed's ACP plan card without parsing file changes.

## ACP implication

The ACP adapter should accept both common result envelopes:

- Official example: `details.todos[]` with `text` and `done`.
- `rpiv-todo`: `details.tasks[]` with `subject` and explicit `status`.

ACP's stable `sessionUpdate: "plan"` requires complete entries with `content`, `priority`, and `pending | in_progress | completed` status. Deleted `rpiv-todo` tasks should be omitted.

## Sources

- [Pi README philosophy and package installation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md)
- [Pi official todo example](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/todo.ts)
- [`@juicesharp/rpiv-todo` source and README](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)
- [`@99percentpeople/pi-todo` source](https://github.com/99percentpeople/pi-extensions)
- [`@pi9/todo` source](https://github.com/Chase-C/pi9/tree/main/packages/todo)
- [`pi-todo-rail` source](https://github.com/j-joker/pi-todo-rail)
- [npm downloads API](https://api.npmjs.org/downloads/)
- [ACP Agent Plan specification](https://agentclientprotocol.com/protocol/v1/agent-plan)
