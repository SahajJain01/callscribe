// Meet caption languages: code -> name in that language, and which one to ask for.
// Classic script (content scripts, popup); also loadable from Node for tests.
// Codes are the form Meet's CC language request uses ("en-US"). Not every code has been
// checked against a live Meet call (docs/known-gaps.md).
;(function (root) {
  "use strict"

  // The main region of each language comes first: a browser tag with an unknown region
  // ("en-150", "vi") resolves to the first entry of its language.
  const CAPTION_LANGUAGES = [
    ["en-US", "English (US)"],
    ["en-GB", "English (UK)"],
    ["en-AU", "English (Australia)"],
    ["en-IN", "English (India)"],
    ["vi-VN", "Tiếng Việt"],
    ["es-MX", "Español (México)"],
    ["es-ES", "Español (España)"],
    ["pt-BR", "Português (Brasil)"],
    ["pt-PT", "Português (Portugal)"],
    ["fr-FR", "Français"],
    ["de-DE", "Deutsch"],
    ["it-IT", "Italiano"],
    ["nl-NL", "Nederlands"],
    ["pl-PL", "Polski"],
    ["ru-RU", "Русский"],
    ["uk-UA", "Українська"],
    ["tr-TR", "Türkçe"],
    ["ar-EG", "العربية"],
    ["he-IL", "עברית"],
    ["hi-IN", "हिन्दी"],
    ["bn-BD", "বাংলা"],
    ["ta-IN", "தமிழ்"],
    ["te-IN", "తెలుగు"],
    ["id-ID", "Bahasa Indonesia"],
    ["ms-MY", "Bahasa Melayu"],
    ["fil-PH", "Filipino"],
    ["th-TH", "ไทย"],
    ["km-KH", "ខ្មែរ"],
    ["ja-JP", "日本語"],
    ["ko-KR", "한국어"],
    ["cmn-Hans-CN", "中文（简体）"],
    ["cmn-Hant-TW", "中文（繁體）"],
    ["sv-SE", "Svenska"],
    ["no-NO", "Norsk"],
    ["da-DK", "Dansk"],
    ["fi-FI", "Suomi"],
    ["cs-CZ", "Čeština"],
    ["ro-RO", "Română"],
    ["hu-HU", "Magyar"],
    ["el-GR", "Ελληνικά"],
  ]

  // Codes a browser language may be mapped onto by its main language alone ("vi" -> "vi-VN"):
  // the plain xx-YY ones Google speech is known to use. The rest are offered in the menu, but
  // reached from the browser only by an exact tag, as 0.3.0 did (review I3).
  const MAPPABLE = new Set(["en-US", "en-GB", "en-AU", "en-IN", "vi-VN", "es-MX", "es-ES", "pt-BR", "pt-PT", "fr-FR",
    "de-DE", "it-IT", "nl-NL", "pl-PL", "ru-RU", "uk-UA", "tr-TR", "hi-IN", "id-ID", "th-TH", "ja-JP", "ko-KR",
    "sv-SE", "da-DK", "fi-FI", "cs-CZ", "ro-RO", "hu-HU", "el-GR"])
  // 0.3.0 sent a browser tag of this form as-is.
  const PLAIN_TAG = /^[a-z]{2,3}-[A-Z]{2}$/

  const lower = (s) => String(s || "").toLowerCase()
  const byCode = new Map(CAPTION_LANGUAGES.map(([c]) => [lower(c), c]))
  const primary = (tag) => lower(tag).split("-")[0]

  const isCaptionLanguage = (code) => typeof code === "string" && byCode.get(lower(code)) === code

  function fromBrowserTag(tag) {
    const t = lower(tag)
    if (!t) return null
    if (byCode.has(t)) return byCode.get(t)
    const p = primary(t)
    const hit = CAPTION_LANGUAGES.find(([c]) => MAPPABLE.has(c) && primary(c) === p)
    if (hit) return hit[0]
    return PLAIN_TAG.test(String(tag)) ? String(tag) : null
  }

  /** The caption language to ask Meet for: the saved choice, else the browser's, else en-US. */
  function resolveCaptionLanguage(saved, navLangs) {
    if (isCaptionLanguage(saved)) return saved
    for (const tag of Array.isArray(navLangs) ? navLangs : []) {
      const code = fromBrowserTag(tag)
      if (code) return code
    }
    return "en-US"
  }

  const api = { CAPTION_LANGUAGES, resolveCaptionLanguage, isCaptionLanguage }
  root.CallScribe = Object.assign(root.CallScribe || {}, api)
  if (typeof module !== "undefined" && module.exports) module.exports = api
})(typeof globalThis !== "undefined" ? globalThis : this)
