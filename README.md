# CallScribe

A Chrome extension that saves your **Google Meet** and **Slack huddle** calls as a
speaker-labelled transcript (from the platform's own live captions) plus an **audio
backup** of the whole call. Everything stays on your computer: no servers, no accounts,
no API keys.

When a call ends, two files land in `Downloads/CallScribe/`:

```
2026-11-04_1823_Google-Meet_weekly-sync.md     transcript, speaker turns with time offsets
2026-11-04_1823_Google-Meet_weekly-sync.webm   audio backup (Opus), same clock as the transcript
```

## Install

Chrome Web Store: https://chromewebstore.google.com/detail/okggaiddahaifnjapedjahhgegbhabba (live once Google's review finishes).

### Unpacked (development)

1. `chrome://extensions` → turn on **Developer mode** (top right).
2. **Load unpacked** → pick this folder (the one with `manifest.json`).
3. Refresh any Meet / Slack tabs that were already open.

Works in Chrome, Edge, Brave and other Chromium browsers. Slack huddles must be in the
**Slack web client** (app.slack.com), not the desktop app.

## Use

- **Google Meet**: join the call. CallScribe turns captions on for you (setting) and starts
  recording when the call starts.
- **Slack huddle**: join the huddle in app.slack.com and turn on captions (CC in the huddle
  window). To have them on every time: Slack Preferences → Audio & video → turn on captions
  by default when joining huddles.
- The toolbar icon shows **REC** during a call. The popup shows the live line count and audio
  size, lists recent calls with Transcript / Audio download buttons, and has the settings.

Settings (popup → Settings): auto-enable captions, hide captions on screen (on by default; the
box is moved off-screen but still read, so the transcript is unaffected), record audio, include my microphone,
auto-save files when a call ends. With auto-save off, use the popup buttons.

## How it works

| Part | File | What it does |
|---|---|---|
| Audio hook | `src/page/audio-hook.js` | Runs in the page before the call app loads. Notes every incoming WebRTC audio track and the microphone the app opens, mixes them with Web Audio and records Opus chunks (5 s). It changes nothing the app sends or plays. Your mic goes through a gate that follows the app's mute button, so nothing is recorded while you're muted. |
| Render keepalive | `src/page/render-keepalive.js` | Meet applies caption updates in `requestAnimationFrame`, which Chrome stops running when the tab isn't drawn (background tab, minimized window, Companion-mode tab). During a call, each animation frame gets a fallback timer so captions keep reaching the page, and get timestamped, while the tab is hidden. |
| Watcher | `src/content/main.js` | Picks the adapter for the site, detects call start/end, reads caption rows, auto-enables captions, forwards mute state and audio chunks. |
| Caption merging | `src/shared/merge.js` | Caption UIs rewrite rows as recognition improves and trim long rows. Rows are merged with word-level fuzzy alignment so corrections replace text instead of duplicating it. |
| Storage/export | `src/background/index.js`, `src/shared/db.js` | IndexedDB keeps the transcript and audio chunks as they stream in, so a crash or closed tab loses at most a few seconds. On call end (or tab close / stale session) it writes the `.md` and `.webm`. |

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
  selfMuted: () => true | false | undefined,   // gates your mic in the audio backup
  captionRows: () => [{ key: rowElement, speaker: "Name", text: "what they said" }],
  hints: { captionsOff: "How to turn captions on" },
}
```

Then add the host to `host_permissions` and a `content_scripts` entry in `manifest.json`
(`merge.js`, your adapter, `main.js`), and the host to the audio-hook entry. Audio capture
is generic: any call app that uses WebRTC in the page works without platform code.

## Tests

```bash
npm test        # unit tests: caption merging (incl. a real Meet caption sequence), tracker, formatting
npm run e2e     # loads the extension in headless Chromium against a fake Slack huddle served as
                # https://app.slack.com: checks transcript, speakers, trimmed rows, remote audio
                # recorded while muted, and silence when muted and alone
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
