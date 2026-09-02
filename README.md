# pi-usage-chips

A [pi](https://pi.dev/) extension that surfaces provider quota usage as
chips in the [`@wierdbytes/pi-statusline`](https://pi.dev/packages/@wierdbytes/pi-statusline)
status row. Self-contained — no runtime dependencies.

## Supported providers

| Provider     | Trigger models                               | Source                                                      | Chip id  |
| ------------ | -------------------------------------------- | ----------------------------------------------------------- | -------- |
| Opencode Go  | `opencode-go/*`                              | Dashboard scrape of `opencode.ai/workspace/<id>/go`          | `go`     |
| OpenAI Codex | `openai-codex/*`, or `openai/*` codex models | `chatgpt.com/backend-api/wham/usage` via pi's provider auth  | `codex`  |

Exactly one chip is visible at a time — the chip for whichever of the two
providers the active model belongs to. Switching models swaps the chips;
switching to any other provider clears both. Other providers (Z.ai,
DeepSeek, plain `openai`, ollama, …) are intentionally not shown.

## What it looks like

```
│4.7%(3h43m) 12%(4d18h) 6.2%(18d22h) ─────
```

- One window per token: `pct%(reset-in)`, single-space separated, no
  icons, no separators.
- Go windows are rolling / weekly / monthly. Codex windows are 5-hour /
  weekly (+ an `S`-prefixed spark window when the model has one).
- The percentage is **burn-colored** (Tokyo Night Storm palette, matching
  the statusline's own colors): green < 60% ≤ yellow < 85% ≤ red. The
  `(reset-in)` time stays uncolored.
- The chip's `detail` field carries the full per-window description for
  `/statusline events log`.

Errors become a sticky red chip on the same slot — `Go usage failed`,
`Codex auth error`, or `Codex error` — with the underlying message in the
`detail` field.

## Install

### From a checkout

```sh
pi install /path/to/pi-usage-chips
```

or copy `usage-chips.ts` into pi's auto-discovery path:

```sh
cp usage-chips.ts ~/.pi/agent/extensions/
```

Restart pi or run `/reload` after installing or editing. The chips appear
in the statusline's `chips` block (enable it via `/statusline` → Layout
if hidden). Requires `@wierdbytes/pi-statusline` for rendering; without
it the events are simply published to the bus and ignored.

## Configuration

### Opencode Go

`~/.pi/agent/opencode-go.json`:

```json
{
  "workspaceId": "wrk_...",
  "authCookie": "Fe26.2**..."
}
```

Copy the `auth` cookie from a logged-in browser session on the workspace
dashboard. These cookies expire server-side after a while; when that
happens the Go chip turns into a red `Go usage failed` and the detail
says `Session expired or auth invalid — refresh your cookie`. Re-copy the
cookie to fix.

For tests, the config path can be overridden with the
`PI_USAGE_CHIPS_GO_CONFIG` environment variable.

### OpenAI Codex

No configuration — the extension asks pi's model registry for Codex
credentials (the same auth used by `openai-codex` models, refreshed
automatically). Log in with `/login` for OpenAI ChatGPT Plus/Pro (Codex).
Without it, the chip shows `Codex auth error`.

## How it works

Each provider gets **one** `notify:status` chip on pi's shared event bus
(the `@wierdbytes/pi-events` contract), refreshed on `session_start`,
`model_select`, and `turn_end`, with a 30-second cache per provider so
turns don't hammer the endpoints.

The statusline renders a chip as `<icon> <levelColor><label><reset>`,
where the label alone is truncated to 16 visible chars — too small for a
multi-window row — and multiple chips are joined with ` · `. To get a
compact single-space row, the extension puts the entire rendered row in
the chip's `icon` field (which the statusline emits verbatim, without
truncation or styling) and uses an invisible ANSI reset as the label.
Window colors are therefore embedded in the payload itself, using the
same truecolor values as the statusline's theme.

The statusline must keep two invariants for this to keep working (both
are covered by the test suite):

1. `icon` is emitted verbatim and never truncated.
2. `label` is truncated to 16 visible chars; an empty/absent `icon`
   falls back to a visible level glyph.

## Development

The test suite is fully portable — it stubs fetch, pi's model registry,
and the event bus, and points the Go config path at a temp file, so no
machine state or network access is required.

```sh
npm install   # dev-only: tsx
npm test      # or: npx tsx usage-chips.test.mts
```

The fixtures (`go-dashboard-fixture.html`, `codex-usage-fixture.json`)
are captured real responses with all personal identifiers redacted; the
tests cross-check the parsers against values regex-extracted from the
fixtures themselves.

## Deploying changes

If you run the extension from the auto-discovery path rather than
`pi install`, remember to copy the file across after editing:

```sh
cp usage-chips.ts ~/.pi/agent/extensions/
```
