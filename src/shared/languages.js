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

  const lower = (s) => String(s || "").toLowerCase()
  const byCode = new Map(CAPTION_LANGUAGES.map(([c]) => [lower(c), c]))
  // Browser tags for Chinese say zh-*; Meet says cmn-Hans/cmn-Hant.
  const ZH = { "zh-tw": "cmn-Hant-TW", "zh-hk": "cmn-Hant-TW", "zh-hant": "cmn-Hant-TW", "zh-hant-tw": "cmn-Hant-TW" }
  const primary = (tag) => {
    const p = lower(tag).split("-")[0]
    return p === "zh" ? "cmn" : p === "nb" || p === "nn" ? "no" : p
  }

  const isCaptionLanguage = (code) => typeof code === "string" && byCode.get(lower(code)) === code

  function fromBrowserTag(tag) {
    const t = lower(tag)
    if (!t) return null
    if (byCode.has(t)) return byCode.get(t)
    if (ZH[t]) return ZH[t]
    const p = primary(t)
    const hit = CAPTION_LANGUAGES.find(([c]) => primary(c) === p)
    return hit ? hit[0] : null
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
