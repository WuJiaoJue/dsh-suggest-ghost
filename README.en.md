<div align="center">
  <img src="docs/banner.png?v=2" alt="dsh-suggest-ghost — ghost autocomplete for DeepSeek Harness Web"/>
</div>

# dsh-suggest-ghost

**English** | [简体中文](README.md)

[![version](https://img.shields.io/badge/version-0.2.0-0EA5E9)](https://github.com/WuJiaoJue/dsh-suggest-ghost)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.1.0--rc.6-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)

> Input prediction plugin for DeepSeek Harness Web: after each turn completes, one auxiliary LLM call predicts your next prompt and renders it as ghost text in the input box when the draft is empty; while you type, it completes from the current conversation history by prefix match. **Tab** accepts the whole suggestion, **→** accepts word by word.

## What it is

A pure plugin mount (host listens to turn events + client-side DOM overlay) — no changes to any DSH core code. Two modes switch automatically:

- **LLM next-suggestion** (empty draft): after every completed turn, the last round of conversation is sanitized and sent to the suggestion model (inherits the main request route by default, no extra config) to produce "the sentence you are most likely to type next" — the same experience as Claude Code.
- **History prefix completion** (non-empty draft): zsh-autosuggestions style — finds prefix-matching entries in conversation history, scores by recency first, with in-session frequency and cross-session hotness as secondary signals, and renders the remaining part in gray. Full/half-width punctuation, whitespace, and case differences do not affect matching.

Ghost text is rendered as a DOM overlay approximation (follows the input's font and scroll), not depending on the official `setGhost` input capability, so it works on rc.6; keystrokes are not intercepted during IME composition.

## Preview

![Live demo: type character by character, ghost appears, Tab to accept](docs/demo.gif)

**① History prefix completion** (non-empty draft) — type "list do" and the ghost completes the remainder of that historical message:

![History prefix completion screenshot](docs/mode-history-real.png)

**② LLM next-suggestion** (empty draft, auto-predicts your next step after a turn ends):

![LLM next-suggestion screenshot](docs/mode-llm-real.png)

Dark text = what you typed; gray = ghost suggestion. **Tab** accepts the whole suggestion, **→** accepts word by word. Ghost text follows the input's font and scroll rendering — it never overlaps or steals focus; if you don't like it, just ignore it and keep typing and it disappears — zero cost.

## Installation

**From npm (recommended — prebuilt, no approval needed):**

```bash
dsh plugin --profile web add dsh-suggest-ghost
```

One-line install from GitHub (build artifacts are committed to the repo, no local build needed):

```bash
dsh plugin --profile web add "github:WuJiaoJue/dsh-suggest-ghost"
```

Or from source:

```bash
git clone https://github.com/WuJiaoJue/dsh-suggest-ghost.git
cd dsh-suggest-ghost && pnpm install && pnpm run build
dsh plugin --profile web add .
```

After installing, restart dsh web and hard-refresh the page with Ctrl+Shift+R. Works out of the box with no configuration required.

## Configuration

All settings live in the **Suggest ghost** card in Settings → Plugins and take effect immediately after saving:
card copy (field labels/hints, buttons, badges) follows the host DSH UI language (中文 / English) and updates in real time when the language is switched in Settings, without a refresh; hosts without a locale service fall back to Chinese.

| Group | Fields |
|---|---|
| LLM next-suggestion | enable toggle, max output tokens, max suggestion chars, reference turns, transcript char budget, timeout (ms), accept key, provider / model route (leave empty to inherit the main request) |
| History prefix completion | enable toggle, cross-session search, max history entries, min input chars, word-by-word accept |

You can also override by id in cordis.patch.yml (as initial values for the above):

```yaml
- id: suggest-ghost
  config:
    maxInputBytes: 4096        # framed user prompt byte cap
    maxOutputTokens: 512       # suggestion output token cap
    timeoutMs: 60000           # auxiliary request deadline (ms)
    maxRecentTurns: 1          # most recent completed turns sent to the suggestion model
    maxTranscriptChars: 12000  # transcript char budget
    maxSuggestionChars: 240    # visible suggestion char cap
    acceptKey: Tab             # accept shortcut
    llmEnabled: true           # LLM suggestion toggle
```



<div align="center">
  <img src="docs/settings-card.png?v=3" width="640" alt="Suggest ghost settings card (Settings → Plugins)"/>
</div>

## Security

- Only the last round of conversation is sent to the suggestion model, with common credentials auto-masked before sending; output is purified and unqualified replies are silently discarded
- Fully bounded end to end: input bytes / output tokens / timeout capped; re-entry guarded within the same turn, new turns invalidate stale generations, unloading aborts in-flight requests

## Compatibility

> Developed and verified on dsh `0.1.0-rc.6`; the client code is already compatible with rc.7's stricter gated context. After upgrading the host version, it is recommended to regression-test ghost rendering and the settings card.

## Development

```
src/index.ts         host entry: turn/end(completed) → bounded suggestion generation
src/generate.ts      transcript extraction → sanitization → ctx.llm.stream → purification
src/transcript.ts    pure transcript logic: char + UTF-8 byte dual-budget trimming (unit-testable)
src/sanitize.ts      sanitize / purify / semantic filter / truncation (pure functions)
src/settings.ts      settings namespace + real-time host→client push channel (tail-write coalescing)
src/hotness.ts       cross-session hotness table (incremental dedup, min-heap eviction, bounded memory)
src/projection.ts    suggestGhost projection last-wins fold
src/client/          ghost rendering, history matching, word splitting, shortcuts, settings card
scripts/             smoke tests and session log replay
```

```bash
pnpm run build       # tsc compiles host + esbuild bundles client → lib/
pnpm run test:smoke  # pure-function smoke tests
pnpm run replay      # replay the completion pipeline with real session logs
```

## Known limitations

- The cross-session hotness table is in-memory: it accumulates from zero after a DSH restart (in-session history completion is unaffected)
- LLM suggestions cover only the current session; to include text from other sessions as candidates, enable "cross-session search"
- Every completed turn triggers one suggestion model call (regardless of whether the input box has content); disable it in settings to save tokens if not needed

## License

MIT © wujue. The security and generation pipelines are implemented with reference to [dsh-suggest-prompt](https://github.com/studyzy/dsh-suggest-prompt) (MIT).


<div align="center">
  <img src="docs/logo-peek.png?v=1" width="150" alt=""/>
</div>
