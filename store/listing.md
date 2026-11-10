# Chrome Web Store listing: CallScribe

## Store listing

**Category:** Productivity → Tools (Workflow & Planning if Tools is unavailable)
**Language:** English

**Description:**

CallScribe saves your Google Meet calls and Slack huddles as a written transcript with speaker names, and records an audio backup of the whole call. Everything stays on your computer.

HOW IT WORKS
• Join a call in Google Meet, or a huddle in the Slack web app (app.slack.com).
• In Meet you don't need to turn captions on: CallScribe receives Meet's live captions in the background, so Meet's caption box stays off. In Slack, CallScribe turns the huddle's captions on for you (you can switch this off in Settings).
• A small overlay on the call shows it's recording, with the latest caption. Click it to see the live transcript.
• When the call ends, two files are saved to Downloads/CallScribe:
  – a Markdown transcript: who said what, with timestamps
  – an audio recording of the call (WebM, or Ogg in browsers that can't record WebM), on the same clock as the transcript

FEATURES
• Starts and stops by itself when you join and leave a call
• Speaker names from Meet and Slack captions, with corrections merged so nothing is repeated
• Pick the caption language for Meet right on the overlay (Tiếng Việt, 日本語, Español and more). It starts as your browser's language
• Audio backup of everyone in the call, including you only while the call shows you're unmuted (never while you're muted, or when CallScribe can't tell)
• Every stored call is listed in the popup with Transcript / Audio / Delete buttons
• Saves as the call goes, so a crash or closed tab doesn't lose the call. After a crash the call is ended and saved on the next check (within a few minutes, or when Chrome starts again)
• A call is removed from the browser 30 days after its files are saved to Downloads. Calls that weren't saved stay until you delete them

PRIVATE BY DESIGN
• No account, no server, no analytics. Nothing is uploaded anywhere.
• Open source (MIT): https://github.com/SahajJain01/callscribe

NOTES
• Transcripts come from the platform's own live captions. In Slack they only cover the time captions were on. The audio backup covers everything.
• Slack huddles must be in the Slack web app, not the desktop app.
• Recording calls may need everyone's consent where you live. Please tell people you're recording.

## Privacy practices tab

**Single purpose:**
Save a transcript (from the platform's own live captions) and an audio backup of the user's Google Meet calls and Slack huddles to the user's computer.

**Permission justifications:**
- storage: Stores the user's settings (record audio, caption language, etc.) and the overlay's position in extension storage.
- unlimitedStorage: Each call (transcript and audio chunks) is kept in the browser's local database as it happens, so a crash doesn't lose it. A call is deleted 30 days after all its files are saved to Downloads; a call that wasn't saved stays until the user deletes it in the popup. An hour of audio is about 20 MB, which can exceed the default quota.
- downloads: Saves the finished transcript (.md) and audio (.webm or .ogg) into the user's Downloads/CallScribe folder when a call ends or when the user clicks Transcript/Audio/Save again in the popup, and checks that each download completed.
- offscreen: The service worker can't create blob URLs. An offscreen document assembles the stored audio chunks into one file so it can be downloaded.
- alarms: A periodic check finalizes and saves calls whose tab crashed or closed without a normal end, retries failed saves, and deletes calls 30 days after their files were saved.
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
- Package: build with store/package.sh from the commit being published. It writes store/callscribe-<version>.zip from manifest.json, icons, src and LICENSE; upload that fresh zip, not an older one in store/.
