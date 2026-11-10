# Known gaps

These were found or deferred during the November 2026 audit and fixes (0.3.0). None loses data in normal use. The full audit reports were kept outside git, in `.superpowers/audit/`. The plan is `docs/superpowers/plans/2026-11-07-audit-fixes.md`.

## Not yet verified

- **Real calls.** Every test so far used fake Meet/Slack pages in headless Chromium. Nothing has been tested on a live Meet call or a live Slack huddle. Check on the first real calls:
  - the new mute selectors on Slack and Meet, including a non-English UI;
  - that Meet's caption feed and its on-page captions merge without lines lost or doubled;
  - overlay placement against the real Meet and Slack controls;
  - the cost of the body-wide mute observer (`watchMute`, `src/content/main.js`) on a busy Meet page.
- **Web Store update mid-call.** Only a reload of the unpacked extension has been tested. The tab should show "CallScribe was updated. Reload this tab to keep recording" and give Meet its captions and layout back.
- **Caption language codes.** The menu's codes (`src/shared/languages.js`) follow the `en-US` form Meet's CC request uses, but only `en-US` has been seen on a live call. Check `vi-VN` first (the Web Store review that asked for it), then the `cmn-Hans-CN` / `cmn-Hant-TW` Chinese codes. A code Meet rejects gets no reply; after five tries CallScribe stops holding back captions in Meet's own language. Not covered: Meet replying to a code and then sending nothing (the feed counts as live, so the CC fallback never starts), and a rejected code with "Turn captions on automatically" off (no captions at all). To limit this, the browser language is mapped only onto well-known codes (`vi` → `vi-VN`); any other browser tag is sent as-is, as in 0.3.0.
- **Caption language switch-over.** When Meet's CC asks for another language, captions tagged with that language are dropped until Meet answers CallScribe's request. Not checked on a live call: how long the overlap lasts, and whether Meet's CC menu then shows the wrong language. With Meet's CC on screen, the on-page reader still records those few old-language lines, so they can appear in the transcript. If Meet's client re-asks for its own language after ours takes effect, the two would keep trading requests (one each per round, uncapped).
- **Merge thresholds.** The rules that remove lines both caption sources caught were tuned on synthetic cases and two recorded fixtures. They have not been tuned on real Chinese, Japanese or Thai captions.

## Behaviour gaps

- **Dead page link (seen live 2026-11-10, cause unknown).** On one real 2h15 Meet call, CallScribe's page scripts never answered on the private channel: no audio and no caption feed, so only on-page CC captions were recorded, and that transcript came out with speakers mixed, one line repeated for 25 minutes, and one block duplicated under both names. Reloading the extension fixed it, and it hasn't happened since (12 of 12 calls fine, Chrome 157). Since 0.3.1 the overlay says "Audio isn't recording in this tab. Reload the tab" 5 s into such a call. Still to do: recreate the long-call corruption in the on-page reader. The test rig is two or three Chrome for Testing guests with fake mics playing TTS speech into a solo Meet you host, with CC on.

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
- Overlay support in fullscreen and picture-in-picture (Meet now moves the call into its own picture-in-picture window when the tab is hidden), and hiding the overlay from screen shares.
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
