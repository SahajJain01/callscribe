# CallScribe

A Chrome extension that saves your **Google Meet** and **Slack huddle** calls as a
speaker-labelled transcript (from the platform's own live captions) plus an **audio
backup** of the whole call. Everything stays on your computer: no servers, no accounts,
no API keys.

When a call ends, two files land in `Downloads/CallScribe/`:

```
2026-11-04_1823_Google-Meet_weekly-sync_k3x9q.md     transcript, speaker turns with time offsets
2026-11-04_1823_Google-Meet_weekly-sync_k3x9q.webm   audio backup (Opus), same clock as the transcript
```

The audio is WebM, or Ogg (`.ogg`) in a browser that can't record WebM. The last part of the
name is a short call id, so two calls never share a file name.

## Install

Chrome Web Store: https://chromewebstore.google.com/detail/okggaiddahaifnjapedjahhgegbhabba (live once Google's review finishes).

### Unpacked (development)

1. `chrome://extensions` → turn on **Developer mode** (top right).
2. **Load unpacked** → pick this folder (the one with `manifest.json`).
3. Refresh any Meet / Slack tabs that were already open.

Works in Chrome, Edge, Brave and other Chromium browsers. Slack huddles must be in the
**Slack web client** (app.slack.com), not the desktop app.

## Use

- **Google Meet**: join the call. CallScribe starts recording when the call starts and gets
  captions from Meet's caption feed directly, so you don't need to turn on CC and Meet's
  caption box stays off. If the feed doesn't start within a few seconds, it falls back to
  turning Meet's captions on (setting) and reading them from the page.
  Captions are in the **caption language** you pick in the overlay (click it to expand, then
  the menu next to Captions) or in popup → Settings. It starts as your browser's language
  (e.g. a Vietnamese browser gets Vietnamese captions) and is kept for later calls. It wins
  over the language set in Meet's own CC menu, and Meet's on-screen captions follow it.
- **Slack huddle**: join the huddle in app.slack.com. With "Turn captions on automatically"
  on (the default), CallScribe clicks the huddle's CC button for you. Otherwise turn on
  captions yourself (CC in the huddle window), or set Slack Preferences → Audio & video →
  turn on captions by default when joining huddles. Slack chooses the caption language
  itself; change it in Slack's huddle caption settings.
- The toolbar icon shows **REC** during a call. A small overlay on the call shows that it's
  recording (see Overlay below).
- The popup shows the live line count and audio size, and lists every call stored in the
  browser, 50 at a time (**Show more** for older ones). Each call has Transcript / Audio /
  Delete buttons and shows whether its files were saved. A call that wasn't saved (a failed or
  canceled download, or auto-save off) says **Not saved** and has a **Save again** (or **Save
  to Downloads**) button. Deleting a call that is still going stops recording it in its tab
  until you leave that call.

Settings (popup → Settings): auto-enable captions, hide captions on screen (on by default; the
box is moved off-screen but still read, so the transcript is unaffected; in Meet the video tiles
expand into the space captions would take), show recording overlay, record audio, include my
microphone, auto-save files when a call ends, caption language (Meet). With auto-save off, use the popup buttons.

Your microphone is recorded only while the call page shows you are unmuted. If CallScribe
can't tell (for example, it can't find the mute button), your mic is not recorded.

### Keeping and deleting calls

- A call is deleted from the browser 30 days after all its files (transcript, and audio if
  any) are saved to Downloads. Files in Downloads are yours and are never touched.
- A call whose files were never saved (auto-save off, a failed download, or a download you
  canceled) stays until you delete it. A canceled download isn't retried; use **Save again**.
- A failed download is retried a few times (after 15 s, 1, 5 and 15 minutes; Chrome may hold
  the first one back to about 30 s), then the call shows **Not saved**.

### If Chrome or the tab crashes

The call is saved as it goes. If a call's tab stops answering for 2 minutes, or is gone
after Chrome restarts, the call is ended at its last saved update. With auto-save on, its
files are saved on the next check (when Chrome starts, or every 2 minutes). If saving was
cut off halfway, it resumes where it stopped, and each file is saved once. If the tab was
only asleep (the laptop slept or Chrome froze the tab) and you're still in the call when it
wakes, the rest of the call is still recorded. If the first part's files were already being
saved, the rest becomes a new entry with its own files, and the first part's files are left
as they were.

If the extension is updated or reloaded during a call, the open tab stops recording and the
overlay says "CallScribe was updated. Reload this tab to keep recording". Its captions and
video tiles go back to how the call app shows them.

## How it works

| Part | File | What it does |
|---|---|---|
| Audio hook | `src/page/audio-hook.js` | Runs in the page before the call app loads. Notes every incoming WebRTC audio track and the microphone the app opens, mixes them with Web Audio and records Opus chunks (5 s), as WebM or, if the browser can't, Ogg. It changes nothing the app sends or plays. Your mic goes through a gate that starts closed and opens only while the app's mute button says you're unmuted, so nothing is recorded while you're muted or when the mute state is unknown. |
| Page bridge | `src/content/bridge.js` | Gives the page scripts a private channel to the content script before any page script runs, so the call page can't send fake caption-feed messages or audio chunks. |
| Meet caption feed | `src/page/meet-channels.js`, `src/shared/meet-proto.js` | Meet's server transcribes every call and streams captions on a WebRTC data channel (`captions_v2`) to any client that asks. The page tap forwards that channel's messages to the content script and sends the same "captions on" request the CC button sends, so captions arrive with CC off, live even in a hidden tab. Each update carries an utterance's full current text, a version and the speaker's device id (named from the participant tiles or Meet's `collections` channel). If you turn CC off in Meet (which stops the feed), CallScribe asks again. |
| Render keepalive | `src/page/render-keepalive.js` | Meet applies caption updates in `requestAnimationFrame`, which Chrome stops running when the tab isn't drawn (background tab, minimized window, Companion-mode tab). During a call, each animation frame gets a fallback timer so captions keep reaching the page, and get timestamped, while the tab is hidden. |
| Watcher | `src/content/main.js` | Picks the adapter for the site, detects call start/end, takes captions from the platform's feed (Meet) or reads caption rows from the page, auto-enables captions (in Meet only as a fallback), forwards mute state and audio chunks. |
| Overlay | `src/content/overlay.js` | A small draggable pill at the top of the call (elapsed time and the latest caption) that expands into a status row (caption source, audio, mic, lines) and a live transcript you can scroll back through to the start of the call. When captions are read from the page (CC), the status row has a **Hide on page** / **Show on page** button for the same setting as the popup's. In Meet the Captions row has a caption-language menu; in Slack, a line says where to change Slack's caption language. Audio shows **save failed** if the browser couldn't store the audio, and a **Transcript: save failed** row appears while it can't store the transcript. Drawn in a closed shadow root, takes keyboard focus only while you use the language menu (a choice or Escape hands it back to the call), and only shown while a call is being recorded (or to say the tab must be reloaded after an update). Turn it off with "Show recording overlay on the call". |
| Caption merging | `src/shared/merge.js` | Caption UIs rewrite rows as recognition improves and trim long rows. Rows are merged with word-level fuzzy alignment so corrections replace text instead of duplicating it. |
| Storage/export | `src/background/index.js`, `src/shared/db.js`, `src/shared/lifecycle.js` | IndexedDB keeps the transcript and audio chunks as they stream in, so a crash or closed tab loses at most a few seconds. On call end (or tab close / stale session) it saves the audio (`.webm` or `.ogg`), then the `.md`. Only a download Chrome reports as complete counts as saved. The save is a job stored with the call, so it resumes after a restart. A sweep (Chrome start, install, every 2 minutes, and when a failed save is due for its retry) ends stale calls, resumes saves and deletes calls 30 days after all their files were saved. |

## Adding a platform

Each platform is one small adapter file in `src/content/adapters/`, registered on
`CallScribe.adapters`:

```js
{
  id: "zoom-web", name: "Zoom",
  matches: (location) => location.hostname.endsWith("zoom.us"),
  inCall: () => Boolean(/* leave button present */),
  title: () => "meeting name",
  captionsOn: () => Boolean(/* caption container present */),
  enableCaptions() { /* optional: click the CC button */ },
  selfMuted: () => true | false | undefined,   // gates your mic: recorded only on false
  captionRows: () => [{ key: rowElement, speaker: "Name", text: "what they said" }],
  hints: { captionsOff: "How to turn captions on" },
}
```

Then add the host to `host_permissions` and a `content_scripts` entry in `manifest.json`
(`merge.js`, your adapter, `overlay.js`, `main.js`), and the host to the audio-hook and
`bridge.js` entries. Audio capture is generic: any call app that uses WebRTC in the page
works without platform code.

## Tests

```bash
npm test        # unit tests: caption merging (incl. a real Meet caption sequence), tracker, formatting
npm run e2e     # loads the extension in headless Chromium against a fake Slack huddle served as
                # https://app.slack.com: checks transcript, speakers, trimmed rows, remote audio
                # recorded while muted, and silence when muted and alone; also recorder, export,
                # upgrade, overlay and Meet timing/layout checks
npm run e2e:crash  # kills Chromium mid-call, restarts it: the call is saved once, completely
node test/live/meet-live.mjs <tabTargetId> <outDir> [secs]
                # live check against real Google Meet in a Chrome with --remote-debugging-port=9222
                # (injects the extension scripts with a chrome.* stand-in; no install needed)
```

`npm run e2e` needs a Chromium that still honours `--load-extension` (Chrome for Testing /
Chromium; branded Chrome 137+ ignores it). Set `CHROME=/path/to/chrome`.

## Limits

- Timestamps are when a caption reached the page. If captions still arrive in a batch
  (e.g. the extension attached mid-call), their times are estimated from their length,
  marked `~` in the transcript.
- In an undrawn tab Chrome runs timers at most about once a second, so captions spoken in
  the last second before you hang up may be cut short.
- Companion mode doesn't play or send call audio, so its audio backup is silent; the
  transcript still works.

- Transcripts are only as good as the platform's captions, and only cover the time captions
  were on. The audio backup is there for everything else.
- Slack caption selectors come from OpenClaw's slack-huddles plugin (verified Sep 2026) and
  were tested here against a fixture, not a live huddle. If Slack changes its markup the
  transcript stops, but the audio backup keeps working.
- Remote-audio capture in a live Meet call wasn't verified against a second real participant
  (Meet doesn't send audio between two tabs signed into the same account). The same capture
  path is verified end to end with a real WebRTC connection in the e2e test.

## Credits

Meet caption approach informed by [TranscripTonic](https://github.com/vivek-nexus/transcriptonic) (MIT).
Slack huddle selectors from [OpenClaw](https://github.com/openclaw/openclaw) (MIT).

MIT licensed.
