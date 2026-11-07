# In-call overlay: design

## Intent

Since 0.2.0, Meet captions come from Meet's caption feed with CC off and the caption box
hidden, so nothing on the call page shows that CallScribe is working. The overlay is a
quick glance that says it is recording and capturing, much like Tactiq's in-call pill.
Scrolling back through the call is also supported.

## Goals

- A collapsed pill: red dot, elapsed time, latest caption (speaker + tail of text).
- Click to expand into a card with:
  - a compact status row: caption source, audio, mic, line count
  - a scrollable transcript of the whole call, with times and speakers
- Click again to collapse.
- Expanded transcript follows new lines unless the user has scrolled up; then a
  "↓ latest" button jumps back. The utterance still being spoken is shown in italics.
- Warnings in amber:
  - captions come from the CC fallback instead of Meet's feed
  - your mic is muted (not recorded)
  - no caption has arrived in 30 s
- Draggable; position remembered (`chrome.storage.local`). Default top-centre.
- Popup setting "Show overlay", default on.
- Shown only while a session is active; removed when the session ends.
- Same overlay on Meet and Slack huddles (agent's call; Slack draws its own captions too,
  but the status is still useful and it is one component).

## Non-goals / anti-goals

- No search, copy, editing, notes, or export from the overlay.
- The overlay must never affect capture, saving or audio. If it throws, recording carries on.
- It must not cover Meet's call controls by default, or steal keyboard focus.
- No new permissions and no changes to the background worker or recorder.

## Approaches considered

1. **Content-script overlay in a Shadow DOM** (chosen). New `src/content/overlay.js`,
   loaded in the Meet and Slack content-script lists before `main.js`; `main.js` feeds it
   state. Instant updates, no messaging, no permissions. Risk: lives in the page's DOM;
   Shadow DOM isolates styles.
2. Extension page in an iframe: full isolation from the page, but needs a messaging
   bridge for every caption and is clumsy to drag and resize as a pill. Rejected: more
   code for no user-visible gain.
3. Chrome side panel: robust and visible from other tabs, but it isn't an overlay, it
   takes width from Meet, and there's no pill. Rejected: doesn't fit the quick-glance
   design.

## How it fits the existing code

- `main.js` already has everything the overlay needs:
  - `session.startedAt`
  - `session.utterances` (feed) and `session.tracker` (CC fallback)
  - `streamActive()` and `captionsOn()`
  - `settings.recordAudio`
  - the mic state from `syncMute`
- It pushes `overlay.update(state)` from the 1 s heartbeat, plus a throttled update
  (≤4/s) when an utterance arrives.
- **Don't call `snapshot()` for the overlay.** `snapshot()` clears `dirty`, and the save
  logic depends on that flag. Add a read-only `view()` to both trackers in
  `src/shared/merge.js` that returns entries without touching `dirty`. Track whether each
  entry is still in progress:
  - `UtteranceTracker`: keep `u.final` on the entry.
  - `CaptionTracker`: an entry is in progress while it is in `this.live`.
- Transcript source matches `save()`: the feed if it has entries, otherwise the DOM tracker.
- Audio status: the overlay shows "recording" after the page posts `started`, and
  "error" after an audio `error` message. `main.js` already sees both messages.

## Left to the builder

- Exact styling (dark, Meet-like, readable over video), sizes, the drag threshold that
  separates a click from a drag, and clamping the remembered position to the viewport.
- Rendering efficiency: append or patch rows rather than rebuilding a long transcript on
  every update.
- Tests:
  - unit tests for `view()` (no `dirty` side effects, in-progress flag)
  - e2e: overlay appears in the Meet and Slack fixtures, shows the latest line,
    expands/collapses, and is gone after the call ends
