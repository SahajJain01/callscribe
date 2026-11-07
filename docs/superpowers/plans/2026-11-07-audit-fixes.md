# Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the bugs found by the four independent audits of CallScribe (HEAD 9cee0a2, plus the overlay CC button in a859b45).

**Architecture:** There are five tasks, each owning one subsystem. They run sequentially because several touch `src/content/main.js`. Each finding is specified by its audit report and ID. The report holds the evidence, the anchors (`file:line` at 9cee0a2, which may have shifted slightly), the reproduction and a suggested fix. The suggested fix is a starting point, not a mandate. The requirement is that the bug is gone and a test proves it.

**Tech Stack:** Plain MV3 Chrome extension JS (no build, no deps). Tests:
- `npm test` (node --test)
- `npm run e2e` (headless Chromium + fake Slack/Meet fixtures)
- `npm run e2e:crash` (~5 min)

Headless Chromium is at `~/.hermes/tools/chromium-1208/chrome-linux64/chrome`.

**Spec / sources of requirements** (gitignored, on this machine):
- `.superpowers/audit/lifecycle.md`: F1–F10, M1–M5
- `.superpowers/audit/security.md`: I1–I4, M1–M8
- `.superpowers/audit/transcript.md`: C1–C2, I1–I4, M1–M10. Reproducing tests are listed verbatim under "Reproducing tests"; scratch copies are in `~/.hermes/cache/scratch/cs-audit-transcript/test/audit-*`.
- `.superpowers/audit/runtime.md`: C1, I1–I5, plus "Additional runtime and UI findings"

Overlay design: `docs/superpowers/specs/2026-11-07-call-overlay-design.md`.

## Global Constraints

- **User decision: mic when the mute state is unknown.** When CallScribe can't tell whether the user is muted (mute selector not found, unknown UI language, etc.), the user's mic is **not recorded** until the mute state is known to be unmuted. The mic gate starts closed.
- **User decision: retention.** A call is deleted from browser storage (session row + audio chunks) **30 days after a confirmed successful export to Downloads**, meaning both files completed per `chrome.downloads` state `complete`. Calls never exported successfully, and calls with autoDownload off, are kept until the user deletes them. The popup must be able to list and delete every stored call, not just the newest 50.
- No new permissions in `manifest.json` and no dependencies. If a fix truly needs a permission, stop and report NEEDS_CONTEXT instead of adding one.
- Data never leaves the machine (no network calls).
- Every fix gets an automated test that fails before the fix and passes after: a unit test, or an e2e check where only a browser can prove it. The transcript audit's reproducing tests should be added to the suite. Tests must not be weakened to pass.
- All existing tests keep passing: `npm test`, `npm run e2e`, and `npm run e2e:crash` (run it in the task that changes lifecycle/export).
- Overlay failures must never affect capture or saving (existing constraint).
- Style: IIFE content files, ES modules in background/shared where already used, 2-space indent, no semicolons, double quotes. Match neighbouring code.
- Don't touch `store/*.zip` and don't bump the version.

## Out of scope (rulings; reported to the user, not built)

- lifecycle M2 (monotonic/media clock mapping across sleep and clock changes): a redesign. The only part in scope is not letting a backwards clock step produce a negative or reordered duration (T2).
- lifecycle M3 incremental per-utterance storage: a redesign. Retention (above) bounds growth.
- security M7 onboarding/consent screen and "announce in chat": a feature.
- runtime fullscreen/PiP overlay support and screen-share exclusion: a feature.
- security M4 "native-looking" wrapper `toString`: low value. Removing the writable `__csRafFallbacks` global is in scope (T1).

## Review Focus

1. A second call in the same tab after a settings change mid-call: audio, mic and keepalive must belong to the right session (T1).
2. Chrome killed or the service worker stopped mid-export, then restarted: each call is exported exactly once, completely (T2).
3. A page script (malicious or buggy) sending `__callscribe` messages: it can't alter the transcript or audio, fill storage, or open the mic (T1/T2).
4. CJK / Thai / Vietnamese / German captions and titles: no duplication, no dropped title characters (T3).
5. A 2-hour call with the overlay expanded: no long main-thread blocks in Meet (T4).

---

### Task 1: Recorder ownership and the page↔extension channel

**Files:** `src/page/audio-hook.js`, `src/page/render-keepalive.js`, `src/page/meet-channels.js`, `src/content/main.js` (message plumbing, settings transitions, orphan handling), `src/content/overlay.js` (orphan warning state only), `manifest.json` (content-script order/world only; no permissions), tests (`test/` unit + `test/e2e/run.mjs` checks).

**Findings to fix:**
- **lifecycle F1 / runtime C1:** turning audio or mic settings on or off mid-call reconciles the recorder: it stops or starts it and keeps it owned by the current session. A later call can never record into an ended session.
- **runtime I1 + lifecycle F7:** after extension reload/update mid-call, the orphaned content script must stop the MAIN-world recorder and render keepalive, and must not throw out of cleanup. Instead of removing the overlay (the current behaviour), the orphan shows the pill in a warning state reading exactly "CallScribe was updated. Reload this tab to keep recording". The overlay only needs the DOM for this. Detect the orphan state via `chrome.runtime.id`, and treat a synchronous throw from `chrome.runtime.sendMessage` as orphaned.
- **runtime I2:** closed RTCPeerConnections, ended tracks and their listeners are released across leave/rejoin in the same tab.
- **security I1, M2, M3, M6:** page scripts must not be able to forge or read extension↔MAIN-world messages. That covers captions, audio chunks, stop, mic on, keepalive and dc-send. Build a private channel, e.g. a MessageChannel whose port is handed over before any page script can run. Prove it in headless Chromium with a page script registered as early as possible (an inline `<script>` first in `<head>` of the fixture) that tries to: obtain the port, forge a chunk/caption/stop/mic-on, and read audio chunks. The e2e must show all of those fail.
  - If no handover is provably private, implement the strongest verified alternative and report exactly what remains exposed. At minimum that means strict shape and size validation (`buf instanceof ArrayBuffer`, byteLength cap, known session id only, seq monotonic per session) and rejecting writes for sessions not started by this tab.
  - Also rate-limit session creation per tab (security M6).
- **security I3 + user decision:** the mic gate starts closed and opens only when `selfMuted()` returns `false`. When it returns undefined (unknown), the mic stays closed. The Slack and Meet mute detection should not depend on English labels where a language-independent signal exists (aria-pressed/aria-checked on the mic toggle, data attributes). Check the adapters and fixtures. Close the gate immediately on the mute click, not on the next 1 s heartbeat, so the ~1 s post-mute lag (I3 inferred) goes away.
- **security M4 (part):** remove the writable `window.__csRafFallbacks` global (tests may read the counter via the channel or a non-enumerable property), and stop allocating rAF wrapper entries outside calls (runtime "Render keepalive" minor). `setActive(false)` clears already-armed fallback timers.
- **runtime minor:** remove the suspended-AudioContext resume listeners on stop and on a failed start, and catch the `resume()` rejection.

- [ ] Write failing tests/e2e checks for each finding above, run them and see them fail.
- [ ] Implement.
- [ ] `npm test && npm run e2e` pass. Commit(s), with messages naming the finding IDs.

### Task 2: Durable capture → export state machine, retention, popup

**Files:** `src/background/index.js`, `src/shared/db.js`, `src/shared/lifecycle.js`, `src/offscreen/*`, `src/popup/*`, `src/shared/format.js` (only the audio-filename reference in the header, F9), `src/content/main.js` (only ack/backpressure of saves and chunks, F5/F10), tests, `test/e2e/crash.mjs` if needed.

**Findings to fix:** lifecycle F2, F3, F4, F5, F6, F9, F10, M1, M4, M5 and security I2, I4, M5, plus the user's retention decision.
- **Exactly-once, resumable export:** persist an export claim and the download ids, then reconcile on `chrome.downloads` completion or interruption. Retry incomplete or interrupted exports on startup or sweep without creating duplicate files. Record real errors, including `USER_CANCELED`. The transcript header names the audio file that was actually written (F9). Make basenames unique per session, e.g. append a short session-id suffix only on collision, or always add one, whichever keeps names readable.
- **Finalize waits until audio is stored:** the last chunk must be stored before export (F5). Failed writes are acknowledged back to the content script and retried, and a persistent failure shows in the overlay status, e.g. Audio "save failed" as warn (F10).
- **Recovery is not limited to the newest 20 sessions:** query unfinished sessions and pending exports directly (F6). The popup lists all stored calls with pagination or "show more", and can delete any of them (security I4).
- **End times:** a normal leave or tab close stores the real event time, not the finalize time (M1). Stale end = last update (already done). A backwards clock never yields a negative duration.
- **Alarms and sweeps:** only create the sweep alarm if it is missing, keep sweeps from overlapping, and bound each tab liveness probe (M4).
- **Deleting a live session:** stop accepting chunks for it (tombstone) and garbage-collect orphan chunk rows, including chunks for session ids that were never started (M5, security I2).
- **Retention:** sessions are deleted 30 days after a confirmed successful export, checked on the sweep.
- **Message sender validation (security M5):** library operations (`list`/`get`/`delete`/`export-*`/`chunks-for`) are allowed only from extension pages (no `sender.tab`, extension origin). Session messages are bound to `sender.tab.id`. The offscreen document accepts only messages without `sender.tab`.

- [ ] Failing tests first. Unit-test the pure logic (claim/retry/retention decisions in `src/shared/lifecycle.js` or a new pure module), plus e2e for the download-state, crash and duplicate paths. The audit's reproductions in lifecycle.md show how each was triggered.
- [ ] Implement.
- [ ] `npm test && npm run e2e && npm run e2e:crash` pass. Commit(s).

### Task 3: Transcript correctness and adapters

**Files:** `src/shared/merge.js`, `src/shared/format.js`, `src/content/adapters/google-meet.js`, `src/content/adapters/slack-huddle.js`, `src/content/main.js` (only `save()` source merging, the names map and polling), tests (add the audit's reproducing tests from transcript.md).

**Findings to fix:**
- transcript C1 + lifecycle F8: export the union of feed and DOM coverage, so neither source's lines are lost when the feed starts late or dies.
- transcript C2: CJK and Thai, i.e. languages without spaces.
- transcript I1–I4.
- transcript M1–M10.
- security M1: Markdown/HTML escaping in the exported `.md`, together with transcript M8.
- security M8: the `.ogg` vs `.webm` header line.
- runtime I4: Slack quadratic speaker lookup.
- runtime I5: Meet caption-space reclaim must not overwrite tile transforms the host app owns.
- runtime minor: the global speaker `names` map is reset per call.

Keep the real-fixture tests (`test/fixtures/*`, `meet-row-sequence.json`) passing.

- [ ] Add the audit's reproducing tests (verbatim where they assert the right behaviour) plus tests for the remaining items. See them fail.
- [ ] Implement.
- [ ] `npm test && npm run e2e` pass. Commit(s).

### Task 4: In-page runtime cost and overlay robustness

**Files:** `src/content/overlay.js`, `src/content/main.js` (observer, heartbeat, refresh coalescing), tests.

**Findings to fix:**
- **runtime I3:** expanding the card with 2,000+ lines must not block the main thread for more than ~16 ms per task. Rendering stays incremental: render a recent window and extend it when the user scrolls up, or chunk the work. Scrolling back through the whole call must still work, since the user asked for it.
- **runtime "Body observer and heartbeat duplication":**
  - observe the caption container once found, instead of all of `document.body`
  - skip DOM caption polling while the feed is healthy, keeping the fallback
  - coalesce the two overlay refresh paths
- **runtime fullscreen/zoom minor (clipping part only):** clamp the default top-centre position. Give the card a viewport-relative max-width and max-height so it fits at 240×200 CSS px and at 300% zoom.
- **runtime RTL minor:** set the overlay chrome's direction explicitly (ltr), and give caption and name text `dir=auto` with bidi isolation.

Add a measured check: unit-test or browser-measure that expanding 2,000 lines produces no long task over 50 ms. Use PerformanceObserver `longtask` in headless Chromium, or time it.

- [ ] Failing checks first, then implement, then `npm test && npm run e2e`. Commit(s).

### Task 5: Documentation matches behaviour

**Files:** `PRIVACY.md`, `README.md`, `store/listing.md` (text only).

Fix security M8 and every claim that the earlier tasks changed:
- mic recorded only while known to be unmuted
- 30-day retention after export
- the popup lists and deletes all calls
- Slack CC is auto-enabled when the setting is on
- WebM or Ogg audio
- the in-call overlay and its CC button
- crash recovery behaviour
- the storage justification

Correct the package name/version mention so it doesn't claim a specific zip that doesn't match HEAD. No code changes.

- [ ] Edit, re-read each claim against the code, commit.
