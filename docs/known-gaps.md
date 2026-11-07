# Known gaps

These were found or deferred during the November 2026 audit and fixes (0.3.0). None loses data in normal use. The full audit reports were kept outside git, in `.superpowers/audit/`. The plan is `docs/superpowers/plans/2026-11-07-audit-fixes.md`.

## Not yet verified

- **Real calls.** Every test so far used fake Meet/Slack pages in headless Chromium. Nothing has been tested on a live Meet call or a live Slack huddle. Check on the first real calls:
  - the new mute selectors on Slack and Meet, including a non-English UI;
  - that Meet's caption feed and its on-page captions merge without lines lost or doubled;
  - overlay placement against the real Meet and Slack controls;
  - the cost of the body-wide mute observer (`watchMute`, `src/content/main.js`) on a busy Meet page.
- **Web Store update mid-call.** Only a reload of the unpacked extension has been tested. The tab should show "CallScribe was updated. Reload this tab to keep recording" and give Meet its captions and layout back.
- **Merge thresholds.** The rules that remove lines both caption sources caught were tuned on synthetic cases and two recorded fixtures. They have not been tuned on real Chinese, Japanese or Thai captions.

## Behaviour gaps

- **Sleep or a frozen tab mid-call.**
  - When the tab wakes, the rest of the call is recorded as a second session.
  - A few seconds of audio are lost: everything from waking until the first write is refused.
  - With auto-save off, or while an export is waiting to retry, the rest of the call goes into the first entry instead, which keeps its early end time.
- **Clock changes.** Sleep and clock changes aren't mapped onto a monotonic clock, so timestamps can be off across a sleep or a system clock change (lifecycle audit M2, a redesign). A backwards clock step can no longer give a negative duration.
- **Storage is not incremental.** Each save rewrites the whole transcript (lifecycle audit M3, a redesign). The 30-day retention bounds how much is kept.
- **Long calls, scrolled back.** If the user scrolls the expanded overlay all the way back on a call of about 2,000 lines, a line inserted or dropped near the top re-renders every row below it, a 70–100 ms hitch. The fix is to trim rows far below the view while not following the latest line, or to detect a single splice (`src/content/overlay.js`).
- **Very long calls.** A cold `mergeSources` run takes about 33–43 ms at 2,000–3,000 lines per source. It only recurs when its alignment cache (4,096 entries) clears. Watch it on calls longer than about 3 hours.
- **Same short word from two people right as the feed dies.** Suppose Meet's caption feed has just stopped and an unidentified speaker says the same short word as a named person a moment later, e.g. "Yes". The word is exported once.
- **"Save again" after a cancelled audio download** also saves the transcript a second time, as `… (1).md`.
- **Transcript header after a late audio save.** If the audio save fails and a later retry succeeds, the transcript header still says "Audio backup: not saved".
- **Session limit.** At most 6 new sessions per tab per 10 minutes. A 7th rejoin within 10 minutes isn't recorded, and nothing tells the user.
- **Captions picked up up to 1 s late.**
  - Until the page's caption box exists, on-page captions are picked up by a 1 s poll.
  - A replaced caption box is read at its next change.
  - Slack caption rows outside the container are also read every 1 s.
- **Page can still detect CallScribe.** Page scripts can see the overlay's `data-latest` attribute (the latest caption, which the page already has), the guard globals, and the wrapper functions' `toString`. They cannot read or change the recording.
- **Render keepalive while hidden.** During a call in a hidden tab, the keepalive also runs the page's own animation callbacks. This is by design, so captions keep arriving, and it costs some CPU.
- **Version mismatch.** The guarantee that a page can't interfere relies on Chrome running CallScribe's page scripts before any page script. This was verified only in Chromium 145. If that order changes, recording stops; nothing leaks.

## Not built (features)

- An onboarding/consent screen and an "announce in chat" option (security audit M7).
- Overlay support in fullscreen and picture-in-picture, and hiding the overlay from screen shares.
- Native-looking `toString` on CallScribe's page-script wrappers (security audit M4, low value).

## Test debt

- No e2e test checks that the view stays put when older lines load, or that rows already on screen update when a line goes final, is renamed or is dropped. The reviewers' probes showed all of these work.
- The e2e check that a new line keeps the view runs at the top of the transcript, so it can't fail.
- `npm test` prints `MODULE_TYPELESS_PACKAGE_JSON` warnings. Removing them needs a file-layout change.
- Not browser-tested:
  - the offscreen document's sender check;
  - a frozen tab's liveness probe timing out;
  - adopting a download that Chrome renamed with "(1)";
  - pause/resume mid-call;
  - an audio context suspended by autoplay rules.
- Minor diagnostics: Meet's data-channel `send` wrapper logs outgoing frames before they are actually sent, and a FileReader error drops a chunk without logging.
