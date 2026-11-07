# Chrome Web Store listing: CallScribe

## Store listing

**Category:** Productivity → Tools (Workflow & Planning if Tools is unavailable)
**Language:** English

**Description:**

CallScribe saves your Google Meet calls and Slack huddles as a written transcript with speaker names, and records an audio backup of the whole call. Everything stays on your computer.

HOW IT WORKS
• Join a call in Google Meet, or a huddle in the Slack web app (app.slack.com).
• In Meet you don't need to turn captions on: CallScribe receives Meet's live captions in the background, so nothing covers your call. In Slack, turn on captions in the huddle once (or set Slack to show captions by default).
• When the call ends, two files are saved to Downloads/CallScribe:
  – a Markdown transcript: who said what, with timestamps
  – a WebM audio recording of the call, on the same clock as the transcript

FEATURES
• Starts and stops by itself when you join and leave a call
• Speaker names from Meet and Slack captions, with corrections merged so nothing is repeated
• Audio backup of everyone in the call, including you while you're unmuted (never while you're muted)
• Captions can stay hidden on screen and are still saved
• Recent calls list in the popup with Transcript / Audio / Delete buttons
• Saves as the call goes, so a crash or closed tab doesn't lose the call

PRIVATE BY DESIGN
• No account, no server, no analytics. Nothing is uploaded anywhere.
• Open source (MIT): https://github.com/SahajJain01/callscribe

NOTES
• Transcripts come from the platform's own captions, so they only cover the time captions were on. The audio backup covers everything.
• Slack huddles must be in the Slack web app, not the desktop app.
• Recording calls may need everyone's consent where you live. Please tell people you're recording.

## Privacy practices tab

**Single purpose:**
Save a transcript (from the platform's own live captions) and an audio backup of the user's Google Meet calls and Slack huddles to the user's computer.

**Permission justifications:**
- storage: Stores the user's settings (record audio, hide captions, etc.) and the in-progress call list in extension storage.
- unlimitedStorage: Calls are saved locally as they happen (transcript and audio chunks) so a crash doesn't lose them. An hour of audio is about 20 MB, which can exceed the default quota.
- downloads: Saves the finished transcript (.md) and audio (.webm) into the user's Downloads/CallScribe folder when a call ends or when the user clicks Transcript/Audio in the popup.
- offscreen: The service worker can't create blob URLs. An offscreen document assembles the stored audio chunks into one file so it can be downloaded.
- alarms: A periodic check finalizes and saves calls whose tab crashed or closed without a normal end.
- Host permission meet.google.com and app.slack.com: The content scripts run only on these two call sites. They read the call's live captions (in Meet, the caption feed Meet's servers send to the browser, requested the same way Meet's CC button does; in Slack, the captions shown on the page) and record the call audio the browser already receives. No other sites are accessed.

**Remote code:** No, I am not using remote code. All JavaScript ships in the package.

**Data usage (check):**
- Personal communications: yes (call captions and audio, stored only on the user's device)
- Website content: yes (meeting title and caption text from the call page)
- Everything else: no

**Certifications (all three checked):**
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://github.com/SahajJain01/callscribe/blob/main/PRIVACY.md

## Distribution
- Visibility: Public
- Regions: All regions
- Pricing: Free

## Assets
- Store icon: icons/128.png
- Screenshots (1280×800): store/out/shot1.png, store/out/shot2.png
- Small promo tile (440×280): store/out/promo-small.png
- Marquee promo tile (1400×560): store/out/promo-marquee.png
- Package: store/callscribe-0.1.0.zip (build with store/package.sh)
