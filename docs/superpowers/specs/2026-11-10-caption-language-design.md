# Caption language picker (Meet)

## Why

A Web Store review (Hoang Thu An, 8 Nov 2026): "It works wonders but I would love if they update Vietnamese version as well."

CallScribe reads Meet's caption feed with CC off. When Meet's CC hasn't picked a language in the page, CallScribe asks for `navigator.language`, but only if it looks like `xx-YY` (`src/content/adapters/google-meet.js` `defaultLanguage`). Vietnamese Chrome usually reports plain `vi`, so captions come back in English. Users don't know CallScribe uses Meet's captions, so they have no reason to open Meet's CC settings and change the language there.

## Goals

- A caption language menu on the overlay during Meet calls. It's visible and easy to find.
- The choice is saved across calls (`settings.captionLang`).
- Default, with nothing saved: the browser language mapped to a Meet language (`vi` → `vi-VN`, `en` → `en-US`, `ja` → `ja-JP`, ...), otherwise `en-US`.
- **Our menu wins.** If Meet's CC asks for a different language, CallScribe asks for its own again right away. Meet's on-screen captions follow ours, because a tab has one caption language.
- Changing the menu mid-call switches the language straight away.

## Non-goals

- Translating CallScribe's own UI.
- A language choice for Slack: Slack doesn't let a page pick the caption language. On Slack the overlay shows a short hint pointing to Slack's caption-language preference instead of a menu.
- Translation of captions (Meet's translated captions).

## Approaches

- **A. Re-request after Meet (chosen).** The content script already sees Meet's outgoing language requests (`dir: "out"`). When Meet asks for a language other than ours, send ours. No new page-world code; Meet's traffic is never altered.
  - Trade-off: about half a second of captions can arrive in Meet's language before ours takes effect. Utterances carry their language (field 4), so they're dropped while ours is pending.
- B. Rewrite Meet's request in the page script. No flicker. But CallScribe would start changing Meet's traffic, and the bridge would need a new message: more attack surface in code the 0.3.0 security audit hardened. Rejected.
- C. A setting in the popup only. Same discoverability problem as today. Rejected.

## How it behaves

- `createCaptionStream` takes the wanted language (a getter, so a change applies at once).
  - It requests `wanted` instead of `lastLang || defaultLanguage()`.
  - Meet's own language request with a different language counts as "stream restarted in the wrong language": send ours (a fresh request, retry rules unchanged).
  - Meet's "captions off" still triggers a re-request, as today.
  - The language changing (menu) sends a new request even while captions flow.
  - Utterances whose language tag differs from the wanted language are dropped while a switch is in flight (from our or Meet's request to our reply). Utterances with no tag are kept.
- Overlay: a `<select>` in the expanded card's Captions status row (next to Hide/Show on page; the header is the drag handle), Meet only. It shows the language names in their own script (e.g. "Tiếng Việt"). Clicks on it don't toggle or drag the card.
- The popup gets the same menu, for choosing before a call.
- The on-page caption source (DOM captions) needs nothing: it reads whatever Meet shows, which is now our language.

## Language list (builder's call, from Meet's CC language menu)

A fixed list in `src/shared/languages.js`: code → native name. Codes follow Meet's `xx-YY` form. A code Meet rejects gets no reply, and the existing retry limit stops asking. The builder checks what the content script does then (on-page captions via auto-CC) and makes sure a bad code can't leave a call with no captions at all.

## Unverified

Nothing here can be checked on a live Meet call from this machine. Tests use the recorded protocol fixtures and fake Meet pages, as before. Added to `docs/known-gaps.md`.
