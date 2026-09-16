# Pi terminal agent profiles

Checked against Pi 0.84.3 and Herdr 0.8.2 on 2026-08-24.

## Finding

Pi does not have a built-in named `profiles` or `roles` setting. The upstream preset request was closed because maintainers consider this extension functionality: [earendil-works/pi#347](https://github.com/earendil-works/pi/issues/347).

Two existing mechanisms cover the requested workflow:

1. **Built-in scoped model cycling** exactly reproduces MagPi's current Zed roles, which change only model and thinking level. `enabledModels` accepts fixed thinking suffixes, and Ctrl+P / Ctrl+Shift+P cycle them in order. [Settings](https://pi.dev/docs/latest/settings#model-cycling) · [keybindings](https://pi.dev/docs/latest/keybindings#models-and-thinking)
2. **Pi's official `preset.ts` example extension** adds named presets with model, thinking level, active tools, and per-turn system instructions. It supports `~/.pi/agent/presets.json`, project overrides, `/preset`, `--preset`, a footer status, restoring the active preset name/instructions, and Ctrl+Shift+U cycling. [Source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/preset.ts) · [extension docs](https://pi.dev/docs/latest/extensions#examples-reference)

Current MagPi/Zed configuration:

| Role  | Model                        | Thinking |
| ----- | ---------------------------- | -------- |
| Plan  | `openai-codex/gpt-5.6-sol`   | `max`    |
| Build | `openai-codex/gpt-5.6-terra` | `high`   |
| Fast  | `openai-codex/gpt-5.6-luna`  | `medium` |

MagPi's role handler only calls Pi's model and thinking setters; it does not change tools or instructions (`src/acp/agent.ts`, `src/acp/pi-settings.ts`). These values resolve without diagnostics as native Pi model-scope entries:

```json
{
  "enabledModels": [
    "openai-codex/gpt-5.6-sol:max",
    "openai-codex/gpt-5.6-terra:high",
    "openai-codex/gpt-5.6-luna:medium"
  ]
}
```

This native option lacks the friendly Plan/Build/Fast labels. Use the official preset extension when labels, tool restrictions, or role instructions matter.

## Shift+Tab and terminal compatibility

Shift+Tab is already Pi's reserved `app.thinking.cycle` shortcut. An extension cannot override it while that binding is active. To use Shift+Tab for preset cycling, unbind the built-in action in `~/.pi/agent/keybindings.json` and register the preset shortcut as `Key.shift("tab")`; otherwise retain the example's Ctrl+Shift+U shortcut. [Keybindings](https://pi.dev/docs/latest/keybindings) · [shortcut conflict implementation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/runner.ts)

The feature lives inside Pi, so it is terminal-client independent:

- Pi documents Ghostty as a supported modern terminal and uses the Kitty keyboard protocol. The local Ghostty config has no conflicting keybind. [Terminal setup](https://pi.dev/docs/latest/terminal-setup#ghostty)
- Herdr forwards application keys unless they match a Herdr binding. Its default pane-cycle chord is **prefix then Shift+Tab**, not bare Shift+Tab; the local config has no key overrides. [Herdr keyboard guide](https://herdr.dev/docs/keyboard) · [config reference](https://herdr.dev/docs/config-reference)

## Recommendation

Use the shipped `preset.ts` example rather than building another profile system. Reuse the existing `~/.pi/agent/roles.json` values in `presets.json`, splitting each combined `provider/model` value into separate `provider` and `model` fields. Keep Ctrl+Shift+U initially, and only take over Shift+Tab if losing direct thinking-level cycling is acceptable.
