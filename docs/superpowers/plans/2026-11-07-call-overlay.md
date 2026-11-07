# In-call Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A collapsible in-call overlay on Meet and Slack huddles: a pill with a red dot, the elapsed time and the latest caption. It expands into a status row plus a scrollable transcript of the whole call.

**Architecture:** The overlay is a new content script, `src/content/overlay.js`. It exposes `CallScribe.createOverlay()` (DOM, Shadow DOM) and a pure `CallScribe.overlayModel()` (state → what to show), which is unit-tested in Node. `main.js` already holds every piece of state. It builds a state object and pushes it to the overlay from its 1 s heartbeat and from caption arrivals, throttled. The trackers in `src/shared/merge.js` gain a read-only `view()` so the overlay never touches the `dirty` flag that drives saving.

**Tech Stack:** Plain MV3 Chrome extension JS (no build, no deps), `node --test`, headless Chromium e2e via CDP (`test/e2e/*.mjs`, Chromium at `~/.hermes/tools/chromium-1208/chrome-linux64/chrome`).

**Spec:** `docs/superpowers/specs/2026-11-07-call-overlay-design.md`

## Global Constraints

- No new permissions and no new dependencies. Don't modify `src/background/index.js` except to add `showOverlay: true` to `DEFAULTS`. Don't modify the recorder (`src/page/*`) or the offscreen document.
- Overlay failures must never affect capture or saving. Wrap every call from `main.js` into the overlay in `try/catch` and log with `console.debug("[CallScribe] overlay …", e)`.
- Caption text and speaker names go into the DOM only via `textContent`, never via `innerHTML`.
- The overlay is visible only while a session is active and `settings.showOverlay !== false`. It is removed on session end.
- Use the setting key `showOverlay` (default on) and the popup label "Show recording overlay on the call".
- Store the drag position in `chrome.storage.local` under key `overlayPos` as `{ x, y }` (CSS px of the pill's top-left). Clamp it to the viewport on load and on window resize. The default is top-centre, 8 px from the top.
- Amber warnings apply to:
  - the caption source being the CC fallback
  - the mic being muted (text "muted, not recorded")
  - a session older than 30 s with no caption in the last 30 s
  - an audio error
- The live (in-progress) utterance is rendered in italics.
- The expanded transcript auto-follows new lines unless the user has scrolled up more than 24 px from the bottom. While scrolled up, a "↓ latest" button is shown, and clicking it scrolls to the bottom and resumes following.
- Match the existing code style: IIFE files, 2-space indent, no semicolons, double quotes, `"use strict"`, and the `root.CallScribe = Object.assign(...)` plus `module.exports` dual export used in `merge.js`.
- Visual reference (approved mockup): `.superpowers/brainstorm/overlay-b-v2.html` (expanded) and option B in `.superpowers/brainstorm/overlay-options.html` (collapsed). Use a dark, Meet-like style: background `rgba(32,33,36,.96)`, border `#5f6368`, text `#e8eaed`, speaker `#8ab4f8`, ok `#81c995`, amber `#fdd663`, red dot `#ea4335`.

## Review Focus

1. **Hour-long call (1000+ utterances):** expanded updates must not rebuild the whole list. Patch changed rows and append new ones (Task 2 test: `renderRows` reuses nodes).
2. **A speaker's name arrives after their lines:** existing rows must switch from "Unknown" to the name. `view()` resolves names at call time (Task 1 test), and the overlay rewrites the speaker on changed rows (Task 2).
3. **Caption text containing `<b>`/`<script>`:** shown literally (Task 2 e2e check on Slack fixture text, plus the `textContent` constraint).
4. **Saved position off-screen after the window shrinks:** clamped back into view (Task 2 `clampPos` unit test).
5. **Overlay toggled off/on mid-call from the popup:** it disappears and reappears without restarting the session (Task 3 e2e check).

---

### Task 1: Read-only tracker views

**Files:**
- Modify: `src/shared/merge.js` (`CaptionTracker`, `UtteranceTracker`)
- Test: `test/merge.test.cjs` (append)

**Interfaces:**
- Produces: `tracker.view() -> Array<{ speaker: string, text: string, start: number, end: number, live: boolean }>` on both trackers. Calling it never changes `tracker.dirty`. `UtteranceTracker` entries now also store `final` (from `u.final`, latest version wins). `live = !final`. For `CaptionTracker`, `live` is true while the entry is a value in `this.live`. Entries with empty text are omitted, as in `snapshot()`. The order matches `snapshot()`.

- [ ] **Step 1: Write failing tests** (append to `test/merge.test.cjs`; import `UtteranceTracker` too)

```js
test("UtteranceTracker.view does not clear dirty and marks live utterances", () => {
  const tr = new UtteranceTracker(() => 1000)
  tr.add({ id: 1, version: 1, text: "hello there", final: false, device: "d1" })
  assert.equal(tr.dirty, true)
  let v = tr.view()
  assert.equal(tr.dirty, true)
  assert.deepEqual(v.map((e) => [e.speaker, e.text, e.live]), [["Unknown", "hello there", true]])
  tr.add({ id: 1, version: 2, text: "hello there team", final: true, device: "d1" })
  tr.setName("d1", "Priya")
  v = tr.view()
  assert.deepEqual(v.map((e) => [e.speaker, e.text, e.live]), [["Priya", "hello there team", false]])
})

test("CaptionTracker.view does not clear dirty; row on screen is live, gone row is not", () => {
  let t = 1000
  const tr = new CaptionTracker(() => t)
  const a = {}
  tr.update([{ key: a, speaker: "A", text: "Hello" }])
  assert.deepEqual(tr.view().map((e) => [e.speaker, e.text, e.live]), [["A", "Hello", true]])
  assert.equal(tr.dirty, true)
  t = 2000; tr.update([])
  assert.deepEqual(tr.view().map((e) => e.live), [false])
})
```

- [ ] **Step 2: Run** `node --test test/merge.test.cjs`. Expected: FAIL, because `view` is not a function.
- [ ] **Step 3: Implement** `view()` on both classes, and store `final` in `UtteranceTracker.add`: set it on new entries, and update it when a version is accepted, even if the text is unchanged.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `git commit -am "Trackers: read-only view() with live flag for the overlay"`

### Task 2: Overlay component

**Files:**
- Create: `src/content/overlay.js`
- Test: `test/overlay.test.cjs`

**Interfaces:**
- Consumes: the `view()` entries from Task 1.
- Produces, in `src/content/overlay.js`, exported as `CallScribe.{overlayModel, clampPos, formatElapsed, createOverlay}` and through `module.exports` for the first three:
  - `formatElapsed(ms) -> "m:ss"`, or `"h:mm:ss"` from 1 h on.
  - `clampPos({x,y}, {w,h}, {vw,vh}) -> {x,y}`: keeps the whole pill inside the viewport, with a 4 px margin.
  - `overlayModel(state, now) -> { elapsed, latest: {speaker,text,live}|null, warn: boolean, status: Array<{label, value, level: "ok"|"warn"|"plain"}> }`
  - `state` shape (built by `main.js` in Task 3):
    `{ startedAt, source: "feed"|"cc"|"none", audio: "off"|"starting"|"recording"|"error", micMuted: boolean|undefined, lines: Array<view entry>, lastCaptionAt: number|0 }`
  - `createOverlay({ doc = document, storage = chrome.storage.local }) -> { update(state), remove() }`

- [ ] **Step 1: Write failing tests** in `test/overlay.test.cjs`:
  - `formatElapsed`: `0 -> "0:00"`, `754000 -> "12:34"`, `3725000 -> "1:02:05"`.
  - `clampPos({x:5000,y:-50},{w:300,h:30},{vw:1280,vh:720})` → `{x:976,y:4}`. `clampPos({x:100,y:100}, …)` is unchanged.
  - `overlayModel`:
    - `source "feed"` → a status row `{label:"Captions", value:"Meet feed", level:"ok"}`.
    - `"cc"` → `{value:"CC fallback", level:"warn"}`.
    - `micMuted true` → `{label:"Mic", value:"muted, not recorded", level:"warn"}`.
    - `audio "error"` → an `Audio` row with level `warn`.
    - Lines row `{label:"Lines", value:"<n>", level:"plain"}`.
    - `latest` is the last entry of `lines`, or `null` when empty.
    - `warn` is true when `now - startedAt > 30000 && now - (lastCaptionAt || startedAt) > 30000`. Test both sides of the 30 s boundary.
    - `warn` is false at 10 s into a call with no captions.
  - Caption source label: "Meet feed" is Meet-specific, and on Slack `source` is always `"cc"`. So `overlayModel` takes `state.platform` (`"google-meet"|"slack-huddle"`), and for Slack the CC source reads `{value:"Slack captions", level:"ok"}`. Add a test for it.
- [ ] **Step 2: Run** `node --test test/overlay.test.cjs`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement the pure functions**, then `createOverlay`:
  - Host `<div id="callscribe-overlay">` on `document.documentElement`, with `position:fixed; z-index:2147483647`. Attach a closed Shadow DOM, with all styles inside it.
  - **Collapsed pill:**
    - red dot (amber when `model.warn`), elapsed time, `·`, the speaker in blue, the tail of the latest text with an ellipsis (`direction`/`text-overflow` so the end is visible, max width 420 px)
    - "waiting for captions…" when there is no latest line
  - **Expanded card** (310 px wide):
    - header: dot, "CallScribe · <elapsed>", "▴" collapse
    - status row from `model.status`
    - scroll list, max-height 220 px
    - "↓ latest" button
  - **Click vs drag:** a click on the pill or header toggles. A pointer move over 4 px is a drag, which moves the host and saves `overlayPos` on pointerup. Clamp the position with `clampPos` on load and on `resize`.
  - **Rows:** `renderRows(list, lines)` keeps one element per index. It updates speaker, text and the italic class only when they changed, and appends new rows. Each row shows the time as `formatElapsed(line.start - startedAt)`.
  - **Auto-follow** as per Global Constraints.
  - Don't call `focus()`, and don't take or block keyboard events outside the overlay.
  - `remove()` detaches the host and removes the listeners.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `git add src/content/overlay.js test/overlay.test.cjs && git commit -m "Overlay component: pill + scrollable transcript (not wired yet)"`

### Task 3: Wire it in, setting, e2e

**Files:**
- Modify:
  - `src/content/main.js`
  - `manifest.json` (add `src/content/overlay.js` before `src/content/main.js` in both the Meet and Slack content-script lists)
  - `src/popup/popup.html` (setting checkbox `data-k="showOverlay"`, after the hideCaptions line)
  - `src/background/index.js` (`DEFAULTS.showOverlay = true`)
  - `.gitignore` (add `.superpowers/`)
  - `test/e2e/run.mjs`, `test/e2e/meet-timing.mjs`
  - `README.md` (one row in the components table for `src/content/overlay.js`)

**Interfaces:**
- Consumes: `CallScribe.createOverlay`, the `state` shape from Task 2, and `view()` from Task 1.

- [ ] **Step 1: main.js wiring**
  - **Defaults:** add `showOverlay: true` to the `settings` defaults.
  - **Session fields:** track `session.audio` (`"starting"` when `start` is posted, `"recording"` on page `started`, `"error"` on page `error`, `"off"` when `!settings.recordAudio`) and `session.lastCaptionAt`. Set `lastCaptionAt` in `onUtterance`, and in `readCaptions` when `tracker.dirty` flips true.
  - **`overlayState()` returns:**
    - `platform: adapter.id`
    - `startedAt`
    - `source`: `streamActive() ? "feed" : captionsOn() ? "cc" : "none"`
    - `audio`
    - `micMuted: lastMuted`
    - `lines`: the feed's `view()` if it has entries, otherwise `tracker.view()`
    - `lastCaptionAt`
  - **`syncOverlay()`:**
    - creates the overlay lazily when there is a session and `showOverlay` is on
    - removes it when either is false
    - otherwise calls `update(overlayState())`
    - is wrapped in try/catch per Global Constraints
  - **When to call it:**
    - the heartbeat
    - throttled (≤ 250 ms) after `onUtterance`/`readCaptions`
    - on the settings change listener
    - in `endSession`, after `session = null`, so the overlay is removed
- [ ] **Step 2: Popup and defaults:** add the checkbox, labelled "Show recording overlay on the call", and add `showOverlay: true` to background `DEFAULTS`. Add `.superpowers/` to `.gitignore` and the README row.
- [ ] **Step 3: e2e checks (Slack, `test/e2e/run.mjs`).** During the caption loop, read the overlay via a test hook: the host sets `data-state` (`collapsed|expanded`) and `data-latest` (latest text) attributes on `#callscribe-overlay`. This works because the shadow root is closed and the test reads the host's attributes. Add these checks:
  - `overlay shown during the call` (host exists while the fixture is in the call)
  - `overlay shows the latest caption` (`data-latest` contains a fixture phrase)
  - `overlay removed after the call` (host gone after `left` + 6 s)
  - **Mid-call toggle:** set `settings.showOverlay=false`, check the host is gone within 2 s, then set it back to true and check it returns. Do this through a CDP `Runtime.evaluate` in the extension service worker: `chrome.storage.local.get/set`.
- [ ] **Step 4: e2e check (Meet, `test/e2e/meet-timing.mjs`):** check `overlay present in the Meet fixture tab` while the call runs. Read `#callscribe-overlay` existence in the hidden tab.
- [ ] **Step 5: Run** `npm test && npm run e2e`. Expected: unit tests pass, and every e2e scenario prints `PASS` with the new checks included.
- [ ] **Step 6: Screenshot check:** render the Slack fixture tab with the overlay expanded (click the host via `Input.dispatchMouseEvent`) to `<work>/overlay.png` and print the path in `run.mjs`. Same pattern as the popup screenshot.
- [ ] **Step 7: Commit** `git commit -am "Overlay: wire into calls, popup setting, e2e checks"`
