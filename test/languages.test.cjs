// Caption language table and the browser-default resolution (src/shared/languages.js).
const test = require("node:test")
const assert = require("node:assert/strict")
const { CAPTION_LANGUAGES, resolveCaptionLanguage, isCaptionLanguage } = require("../src/shared/languages.js")

test("plain 'vi' from a Vietnamese browser maps to vi-VN", () => {
  assert.equal(resolveCaptionLanguage(undefined, ["vi"]), "vi-VN")
  assert.equal(resolveCaptionLanguage(undefined, ["vi-VN", "en-US"]), "vi-VN")
})

test("an exact code wins; an unknown region falls back to the language's first entry", () => {
  assert.equal(resolveCaptionLanguage(undefined, ["en-GB"]), "en-GB")
  assert.equal(resolveCaptionLanguage(undefined, ["en-150"]), "en-US")
  assert.equal(resolveCaptionLanguage(undefined, ["EN-gb"]), "en-GB")
})

test("browser languages are walked in order; nothing usable means en-US", () => {
  assert.equal(resolveCaptionLanguage(undefined, ["xx", "fr"]), "fr-FR")
  assert.equal(resolveCaptionLanguage(undefined, []), "en-US")
  assert.equal(resolveCaptionLanguage(undefined, undefined), "en-US")
  assert.equal(resolveCaptionLanguage(undefined, ["", null, "xx"]), "en-US")
})

test("I3: less certain codes are never picked on the browser's say-so; 0.3.0's behaviour is kept for them", () => {
  // A browser tag that is exactly a listed code was already sent as-is by 0.3.0.
  assert.equal(resolveCaptionLanguage(undefined, ["he-IL"]), "he-IL")
  // Primary-subtag mapping only into well-known codes: these went to en-US before and still do.
  assert.equal(resolveCaptionLanguage(undefined, ["he"]), "en-US")
  assert.equal(resolveCaptionLanguage(undefined, ["nb"]), "en-US")
  assert.equal(resolveCaptionLanguage(undefined, ["km"]), "en-US")
  assert.equal(resolveCaptionLanguage(undefined, ["zh"]), "en-US")
  // An xx-YY tag not in the list is sent as-is, as 0.3.0 did.
  assert.equal(resolveCaptionLanguage(undefined, ["zh-TW"]), "zh-TW")
  assert.equal(resolveCaptionLanguage(undefined, ["sw-KE"]), "sw-KE")
  // Still walks past tags it can't use.
  assert.equal(resolveCaptionLanguage(undefined, ["km", "vi"]), "vi-VN")
})

test("a saved choice wins; a saved code not in the list is ignored", () => {
  assert.equal(resolveCaptionLanguage("ja-JP", ["vi"]), "ja-JP")
  assert.equal(resolveCaptionLanguage("zz-ZZ", ["vi"]), "vi-VN")
  assert.equal(resolveCaptionLanguage("", ["vi"]), "vi-VN")
  assert.equal(isCaptionLanguage("vi-VN"), true)
  assert.equal(isCaptionLanguage("vi"), false)
})

test("the table: unique well-formed codes with names", () => {
  const codes = CAPTION_LANGUAGES.map(([c]) => c)
  assert.equal(new Set(codes).size, codes.length)
  for (const [code, name] of CAPTION_LANGUAGES) {
    assert.match(code, /^[a-z]{2,3}(-[A-Za-z]{2,4})*$/)
    assert.ok(name && typeof name === "string", code)
  }
  assert.ok(codes.includes("vi-VN"))
})
