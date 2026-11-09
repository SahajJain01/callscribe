# Caption Language Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick Meet's caption language from the overlay (and popup), saved across calls, with CallScribe's choice winning over Meet's CC.

**Architecture:** A shared language table resolves the wanted code (saved setting → browser languages → `en-US`). The Meet caption stream asks for that code, re-asks whenever Meet's own CC requests another language, and drops wrong-language utterances while a switch is in flight. The overlay's Captions status row gets a `<select>` that writes `settings.captionLang`.

**Tech Stack:** Plain JS Chrome MV3 extension, `node --test`, Puppeteer-style e2e in `test/e2e`.

**Spec:** `docs/superpowers/specs/2026-11-10-caption-language-design.md`

## Global Constraints

- No new permissions, no new page-world (MAIN) code, no changes to `src/page/meet-channels.js`.
- Setting key: `settings.captionLang` (string code or absent).
- Default with nothing saved: browser language mapped to a list code (`vi` → `vi-VN`), else `en-US`.
- Our language wins over Meet's CC language.
- Slack: no menu; a hint only.
- `npm test` must pass after every task.

## Review Focus

- `navigator.languages` empty or holding only unknown tags (`xx`, `en-150`) → `en-US`, never `undefined` in the request.
- A saved code that's no longer in the list (e.g. removed) → treated as absent, falls back to the browser default.
- The user picks the language Meet already uses → no extra request.
- Meet's CC requests its language repeatedly (user toggles CC on/off/on) → exactly one re-request per Meet request; no request storm, the `tries` limit still applies.
- The select inside the overlay: opening it must not toggle/drag the card, and the shadow-root `mousedown` preventDefault must not stop the native dropdown from opening.

---

### Task 1: Language table

**Files:**
- Create: `src/shared/languages.js` (same UMD shape as `src/shared/merge.js`: `;(function (root) {...})(globalThis)`, exports on `root.CallScribe` and `module.exports`)
- Modify: `manifest.json` (add `src/shared/languages.js` before `src/content/adapters/google-meet.js` in the Meet `document_idle` script list, and before `slack-huddle.js` in Slack's)
- Test: `test/languages.test.cjs`

**Interfaces:**
- Produces: `CS.CAPTION_LANGUAGES: Array<[code: string, nativeName: string]>`, `CS.resolveCaptionLanguage(saved: string|undefined, navLangs: string[]): string`, `CS.isCaptionLanguage(code): boolean`.

- [ ] **Step 1: Failing tests** in `test/languages.test.cjs`:
  - `resolveCaptionLanguage(undefined, ["vi"]) === "vi-VN"`
  - `resolveCaptionLanguage(undefined, ["vi-VN", "en-US"]) === "vi-VN"`
  - `resolveCaptionLanguage(undefined, ["en-GB"]) === "en-GB"` and `(undefined, ["en-150"]) === "en-US"` (primary-subtag fallback picks that language's first entry)
  - `resolveCaptionLanguage(undefined, ["xx", "fr"]) === "fr-FR"` (walks the list in order)
  - `resolveCaptionLanguage(undefined, []) === "en-US"`
  - `resolveCaptionLanguage("ja-JP", ["vi"]) === "ja-JP"`; `resolveCaptionLanguage("zz-ZZ", ["vi"]) === "vi-VN"`
  - every code in `CAPTION_LANGUAGES` is unique and matches `/^[a-z]{2,3}(-[A-Za-z]{2,4})*$/`; names are non-empty.
- [ ] **Step 2:** `node --test test/languages.test.cjs` → FAIL (module missing).
- [ ] **Step 3:** Implement. List = Meet's caption languages, native names, the main language's default region first (`en-US` before `en-GB`, `es-MX` before `es-ES`, `pt-BR` before `pt-PT`). Include at least: en-US, en-GB, en-AU, en-IN, vi-VN, es-MX, es-ES, pt-BR, pt-PT, fr-FR, de-DE, it-IT, nl-NL, pl-PL, ru-RU, uk-UA, tr-TR, ar-EG, hi-IN, bn-BD, id-ID, ms-MY, th-TH, ja-JP, ko-KR, cmn-Hans-CN, cmn-Hant-TW, sv-SE, no-NO, da-DK, fi-FI, cs-CZ, ro-RO, hu-HU, el-GR, he-IL, fil-PH, km-KH, ta-IN, te-IN. Matching: case-insensitive exact code first, then primary subtag (`cmn` also matches `zh`).
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `Caption languages: shared table and browser-default resolution`.

### Task 2: Stream asks for, and defends, the wanted language

**Files:**
- Modify: `src/content/adapters/google-meet.js:54-167` (`defaultLanguage`, `createCaptionStream`)
- Test: `test/meet-stream.test.cjs`

**Interfaces:**
- Consumes: Task 1 `CS.resolveCaptionLanguage`, `navigator.languages`.
- Produces: `createCaptionStream({ toPage, onUtterance, onName, language?: () => string })`; returned object gains `languageChanged(): void`. With no `language` option, the wanted code is `CS.resolveCaptionLanguage(undefined, navigator.languages || [navigator.language])`.

- [ ] **Step 1: Failing tests** (reuse the file's `ld/vi/s/caption/reply` helpers; add a `caption` variant with field 4 = lang):
  - `language: () => "vi-VN"`: the first `dc-send` decodes to `{ kind: "language", lang: "vi-VN" }`.
  - While flowing in vi-VN, Meet sends `encodeLanguage(4, "en-US")` out → one new `dc-send` with lang `vi-VN`. Meet sends `encodeLanguage(5, "vi-VN")` → no new `dc-send`.
  - Meet's en-US request arrives, then an `en-US`-tagged caption before our reply → not passed to `onUtterance`; after `reply(ourSeq)` a `vi-VN`-tagged caption and an untagged one are both passed.
  - `languageChanged()` with the getter now returning `ja-JP` while flowing → one `dc-send` with `ja-JP`; calling it again with the same code → no send.
  - Meet's "captions off" request still causes a re-request (existing behaviour, now in the wanted language).
  - The existing I4/M3 tests still pass unchanged.
- [ ] **Step 2:** `node --test test/meet-stream.test.cjs` → new tests FAIL.
- [ ] **Step 3:** Implement. `request()` sends `wanted()`. Track `sentLang` (language of the stream we believe is active) and `switching` (true from a mismatching Meet request or our own language change until our reply). A Meet request with a different language: mark the stream as Meet's (epoch++ as today), set `switching`, clear `flowing`/`pending`, reset `tries`, call `request()`. While `switching`, drop utterances whose `lang` is set and differs case-insensitively from `wanted()`. `lastLang`/`defaultLanguage` go away.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `Meet: request the chosen caption language and win over Meet's CC`.

### Task 3: Content script wiring and the setting

**Files:**
- Modify: `src/content/main.js` (settings defaults ~47, stream creation ~212, `onSettings` ~233, `overlayState` ~265, overlay creation ~300)
- Modify: `src/background/index.js` `DEFAULTS` only if it lists every key (leave `captionLang` absent = browser default)
- Test: `test/content-main.test.cjs` (uses `test/helpers/content-env.cjs`; extend the fake adapter with a `createCaptionStream` stub if it lacks one)

**Interfaces:**
- Consumes: Task 1, Task 2 (`language` option, `languageChanged()`).
- Produces: `overlayState()` gains `captionLanguage: { code: string, options: CAPTION_LANGUAGES } | null` (null on Slack) and `captionHint: string | null` (Slack only: `"Caption language: change it in Slack's huddle caption settings"`). Overlay option `onCaptionLanguage(code)` writes `settings.captionLang` with the same read-merge-write as `setCaptionsHidden`.

- [ ] **Step 1: Failing tests:** setting `captionLang: "vi-VN"` via `c.setSettings` calls the stream's `languageChanged` once; a settings change that doesn't touch the resolved language doesn't call it; the overlay state carries `captionLanguage.code === "vi-VN"` on Meet and `captionLanguage === null` with a non-empty `captionHint` on Slack.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement; compare the resolved code before/after in `onSettings`.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `Content: caption language setting drives the Meet stream`.

### Task 4: Overlay menu and Slack hint

**Files:**
- Modify: `src/content/overlay.js` (`overlayModel` ~63, `render` ~352, the shadow `mousedown` handler ~460, `CSS`)
- Test: `test/overlay.test.cjs`, `test/e2e/overlay.mjs`

**Interfaces:**
- Consumes: Task 3 state fields, `opts.onCaptionLanguage`.
- Produces: `overlayModel(...).language: { code, options } | null`, `.languageHint: string | null`.

- [ ] **Step 1: Failing unit tests:** `overlayModel` passes `captionLanguage`/`captionHint` through; with neither, both are null.
- [ ] **Step 2: Failing e2e** in `test/e2e/overlay.mjs`: expanded card on the Meet fixture has a `select` in the Captions row whose value is the state's code; changing it calls `onCaptionLanguage` (observe the stored setting); `data-state` stays `expanded` after clicking the select; on the Slack fixture there's no select and the hint text is shown.
- [ ] **Step 3:** Implement. The select sits after the Captions row's value (and the Hide/Show button), labelled "Language". Options show native names. `pointerdown`/`pointerup`/`click` on it stop propagation; the shadow `mousedown` handler skips `preventDefault` when the target is the select. Rebuild the select only when `[code, options.length]` changes (part of the existing `stKey`), not every render, so an open dropdown isn't destroyed by an overlay refresh.
- [ ] **Step 4:** `npm test` and `node test/e2e/overlay.mjs` → PASS.
- [ ] **Step 5:** Commit `Overlay: caption language menu on Meet, hint on Slack`.

### Task 5: Popup menu and docs

**Files:**
- Modify: `src/popup/popup.html` (a `<label>Caption language (Meet) <select id="lang"></select></label>` in Settings; load `../shared/languages.js` as a classic script before `popup.js`), `src/popup/popup.js` (`settingsUi`)
- Modify: `README.md` (a line on the language menu), `docs/known-gaps.md` (language codes and the switch-over filter not verified on live Meet), `store/listing.md` (one line)

- [ ] **Step 1:** Implement: options from `CAPTION_LANGUAGES`, selected = `resolveCaptionLanguage(settings.captionLang, navigator.languages)`; change writes `captionLang` with read-merge-write.
- [ ] **Step 2:** Verify by loading the popup in the e2e harness (or `node test/e2e/run.mjs` if it opens the popup); at minimum `npm test` → PASS and a headless screenshot of `popup.html` shows the menu.
- [ ] **Step 3:** Commit `Popup: caption language setting; docs`.
