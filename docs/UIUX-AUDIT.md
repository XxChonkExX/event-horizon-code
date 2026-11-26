# Event Horizon Code — UI/UX sweep & platform comparison

Scope: the workbench as of commit `83c9930`+, compared against the patterns of
VS Code, Cursor, Zed, and OpenCode Desktop. Goal: fix what is broken, keep what
is deliberately different, and record what is deferred.

## What we have today

| Area | State |
|---|---|
| Layout | Activity bar, session strip, editor (Monaco) with file tabs, bottom panels (8), terminal, status bar; resizable splitters; pop-out windows |
| Session strip | current + newest sessions, horizontal scroll, `x` hides (persisted), `+N hidden · show`, bulk ops in Session log panel |
| Files | lazy workspace tree, right-click new/rename/delete, click-to-open, filter box |
| Chat | streaming tokens, thinking/tool ledger, example chips, capability badges, model/think/tokens controls |
| Agent control | global pause toggle, approvals API, capability discovery, TTS/voices |
| Feedback | toasts (top-right), note lines in panels, audit viewer, in-chat tool ledger |

## Problems found in this sweep

### 1. Deleting a session left a ghost tab — FIXED
`SessionsPanel` refreshed its own list after delete but never told `App` to
refresh the session strip, so deleted sessions stayed in the tabs until reload.
`SessionsPanel` now takes an `onChanged` callback; `App` calls
`refreshSessionTabs()`. The strip and the panel now agree immediately.

### 2. "+" confusion — CLARIFIED, behavior verified
The strip `+` creates an empty session and switches **this same window**
(`window.location.assign('/?session=<id>')` — no new BrowserWindow). The
pop-out action is a separate explicit control. A toast now says
*"new session … — switched THIS window"* so the action is unmistakable.
A full reload on switch is still a UX compromise (see deferred).

### 3. Tab strip clutter — PARTIAL
The strip intentionally shows all sessions (your earlier call: splayed tabs
with a scrollbar, not grouped). With deleted sessions now disappearing
immediately, the main source of clutter is gone. `x` hides a tab with restore
via `+N hidden · show`. Deferred: show only the current + N newest with a
collapsed count (introduced earlier, then removed at your request — revisit if
clutter returns with dozens of sessions).

### 4. Compositor splay — machine-level
Stale frames under training load still occur; all in-app triggers found are
removed (native dialogs, fullscreen overlays, new-window-from-+). GPU compositing
is disabled app-wide. Recovery: single click. Documented in `docs/GPU.md`.

## Platform comparison (patterns, not parity)

| Pattern | VS Code | Cursor | Zed | OpenCode Desktop | EHC now | Gap / decision |
|---|---|---|---|---|---|---|
| Session/tab switching | in-place tabs | in-place | in-place | tab list, in-place | **full reload** on session switch | Biggest remaining UX gap — deferred (session state is module-scoped across ~12 components; needs a session-signal pass) |
| Command palette | Ctrl+Shift+P, in-page | in-page | in-page | in-page menu | **removed** (was a compositor trigger) | Deliberate; a non-overlay in-page launcher is roadmap |
| Multi-window | separate windows | separate windows | shared workspace | per-window | one window per session/worktree, Mission Control planned | Differentiator (one task / one window / one worktree) |
| Agent runs | tasks (ephemeral) | agent tabs | agent panel | sessions | sessions + SOP runs; durable Run entity planned | Phase 1 of roadmap |
| Approvals | per-action | per-action | per-tool | permission prompts | gated tools + SOP script approval + approvals API | Comparable; UI approval queue panel pending |
| Files | explorer tree | explorer | project panel | file panel | lazy tree + right-click ops + filter | Comparable |
| Diagnostics | LSP inline | LSP inline | LSP inline | LSP via ACP | Monaco + LSP hover/diagnostics | Comparable (TS pack installed; other languages need binaries) |
| Notifications | status bar + toast | toast | status | toast | toasts + status bar controls | Comparable |
| Terminal | integrated PTY | integrated | integrated | PTY via ACP | real PTY, tabs, pop-out | Comparable |
| Visual identity | neutral | branded | branded | branded | event-horizon theme, shader opt-in, brand mark | Comparable |

## Fixes that belong to "polish, not priority"

- Keyboard shortcuts for: new session, toggle workbench panels, pause agents,
  focus composer (today: mouse + slash commands only).
- Settings surface for editor font size / theme (single theme, fixed size).
- Empty states: panels other than chat still show bare headings when empty.
- Context-menu parity: Monaco has its own rich menu; our in-page menu covers
  inputs and the sidebar — consistent enough for alpha.

## Principles for the next UI pass

1. State changes must be visible in every view that depends on them (the ghost-tab bug).
2. Destructive actions are one-click with immediate visible feedback and no native dialogs.
3. No fullscreen overlays — they wedged this machine's compositor.
4. One source of truth (the runtime); windows are projections.
5. Compare behavior against VS Code/Zed where it helps; do not copy their feature bulk.

## Deferred (see docs/ROADMAP.md)

In-place session tabs; non-overlay command launcher; Mission Control panel;
approval-queue panel; durable Agent Run + timeline; evaluation lab.

## 0.0.4a sweep (2026-11-25) - measured at 1268 x 638 CSS px

The reference display reports 1280 x 720 logical pixels (a 4K panel at 300 %), so the workbench has far less room than the 1440 x 900 default it was drawn against. Every item below was measured in the real window over the DevTools protocol, before and after.

| Finding | Before | After |
|---|---|---|
| Editor and terminal on launch | not mounted (a `Show` keyed on a counter that started at 0) | Monaco and the PTY present on first paint |
| Chat column overflow | Send button 101 px off-screen, picker 408 px wide | overflow 0, picker 190 px |
| Height left for messages | 143 px of 467 | 243 px (175 px with options open) |
| Rows under the input | 3 (model/think, tokens/auto-approve/speak, voice) | 1 (model/think + options toggle); the two others fold away |
| Panel tab strip | visible scrollbar; could be crushed to 22 px | no scrollbar, wheel scrolls, active tab scrolled into view, height pinned |
| Scrollbars | white tracks in the message list and code blocks | one thin dark style |

Rules that came out of it:

- A setting that changes what the agent may do stays visible even when folded: **auto-approve** and **speaking** are worn as flags on the model row.
- The composer's input owns its line. Controls never share a line with the text.
- Nothing in a column may extend past the column: overflow is checked, not eyeballed.
- Verify in the real window (`--remote-debugging-port`), never in a browser tab.