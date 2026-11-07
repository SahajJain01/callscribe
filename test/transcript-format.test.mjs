// Markdown export: escaping (security M1, transcript M8), file names in any script (M7), the
// audio line's extension (security M8), unnamed speakers (I3) and the ~ marker (M6).
import test from "node:test"
import assert from "node:assert/strict"
import { formatTranscript, fileBase, slug, turns } from "../src/shared/format.js"

const start = new Date(2026, 10, 4, 16, 5, 0).getTime()
const base = (o = {}) => ({ platformName: "Google Meet", startedAt: start, endedAt: start + 60000, utterances: [], ...o })
const evil = "Bob ![pixel](https://attacker.invalid/track.png?who=you) <img src=x onerror=alert(document.domain)> [click](javascript:alert(1))"

test("security M1: a participant's display name can't inject images, HTML or links", () => {
  const md = formatTranscript(base({ utterances: [{ speaker: evil, text: "hi", start, end: start + 1000 }] }))
  assert.doesNotMatch(md, /!\[pixel\]\(/, "image syntax survived")
  assert.doesNotMatch(md, /(^|[^\\])<img/i, "raw HTML survived")
  assert.doesNotMatch(md, /(^|[^\\])\[click\]\(javascript:/, "link syntax survived")
  assert.match(md, /^- Speakers: Bob /m)
  assert.match(md, /^\*\*Bob .*\*\* `00:00:00`$/m)
})

test("security M1: caption text and title are escaped the same way", () => {
  const md = formatTranscript(base({ title: "Sync <script>x</script> ![t](https://a.invalid/p.png)", utterances: [{ speaker: "A", text: evil, start, end: start + 1000 }] }))
  assert.doesNotMatch(md, /(^|[^\\])<(img|script)/i)
  assert.doesNotMatch(md, /(^|[^\\])!\[(pixel|t)\]\(/)
})

test("security M1: the link line is an autolink only for https URLs", () => {
  assert.match(formatTranscript(base({ url: "https://meet.google.com/abc-defg-hij" })), /^- Link: <https:\/\/meet\.google\.com\/abc-defg-hij>$/m)
  const js = formatTranscript(base({ url: "javascript:alert(1)//[x](y)" }))
  assert.doesNotMatch(js, /<javascript:/)
  assert.doesNotMatch(js, /(^|[^\\])\[x\]\(y\)/)
})

test("M8: caption lines that start like Markdown blocks stay plain text", () => {
  const line = (text) => formatTranscript(base({ utterances: [{ speaker: "A", text, start, end: start + 1 }] })).split("\n").at(-2)
  assert.equal(line("# 1 priority"), "\\# 1 priority")
  assert.equal(line("- not a list"), "\\- not a list")
  assert.equal(line("> not a quote"), "\\> not a quote")
  assert.equal(line("---"), "\\---")
  assert.equal(line("1. first"), "1\\. first")
  assert.equal(line("+ plus"), "\\+ plus")
  assert.equal(line("= equals"), "\\= equals")
})

test("M8: escaping leaves ordinary text and intra-word underscores readable", () => {
  const md = formatTranscript(base({ utterances: [{ speaker: "john_doe", text: "Ship it, 5 is (roughly) fine & done", start, end: start + 1 }] }))
  assert.match(md, /^\*\*john_doe\*\* `00:00:00`\nShip it, 5 is \(roughly\) fine & done$/m)
})

test("F13: an empty speaker name renders as Unknown, not ****", () => {
  const md = formatTranscript(base({ utterances: [{ speaker: "", text: "hi", start, end: start + 1 }] }))
  assert.match(md, /^\*\*Unknown\*\* `00:00:00`$/m)
})

test("security M8: without a saved file name the audio line uses the recorded type (.ogg)", () => {
  const md = formatTranscript(base({ title: "x", audio: { chunks: 2, mime: "audio/ogg;codecs=opus" } }))
  assert.match(md, /^- Audio backup: 2026-11-04_1605_Google-Meet_x\.ogg /m)
  const webm = formatTranscript(base({ title: "x", audio: { chunks: 2, mime: "audio/webm;codecs=opus" } }))
  assert.match(webm, /^- Audio backup: 2026-11-04_1605_Google-Meet_x\.webm /m)
})

test("M7: titles in Japanese, Chinese, Thai, Korean, Vietnamese and German keep their letters", () => {
  const fb = (title) => fileBase({ startedAt: start, platformName: "Google Meet", title })
  assert.equal(fb("週次定例"), "2026-11-04_1605_Google-Meet_週次定例")
  assert.equal(fb("デザインレビュー"), "2026-11-04_1605_Google-Meet_デザインレビュー")
  assert.equal(fb("项目会议：预算"), "2026-11-04_1605_Google-Meet_项目会议预算")
  assert.equal(fb("ประชุมทีม"), "2026-11-04_1605_Google-Meet_ประชุมทีม")
  assert.equal(fb("주간 회의"), "2026-11-04_1605_Google-Meet_주간-회의")
  assert.equal(fb("Họp Đội Dự Án"), "2026-11-04_1605_Google-Meet_Hop-Doi-Du-An")
  assert.equal(fb("Straße / Größe"), "2026-11-04_1605_Google-Meet_Strasse-Grosse")
})

test("M7: file names never keep characters that are illegal in file names", () => {
  assert.equal(slug('a\\b/c:d*e?f"g<h>i|j\u0007k'), "abcdefghijk")
})

test("M7: a long title is cut on a character boundary, not inside a surrogate pair", () => {
  const s = slug("𠀀".repeat(70))
  assert.equal(Array.from(s).length, 60)
  assert.ok(!/[\uD800-\uDBFF]$/.test(s))
})

test("I3: two unnamed devices are never merged into one paragraph", () => {
  const t = turns([
    { speaker: "Unknown speaker 1", device: "d1", text: "hi", start: 0, end: 500 },
    { speaker: "Unknown speaker 1", device: "d1", text: "again", start: 600, end: 900 },
    { speaker: "Unknown speaker 2", device: "d2", text: "hello", start: 1000, end: 1500 },
  ])
  assert.deepEqual(t.map((x) => [x.speaker, x.text]), [["Unknown speaker 1", "hi again"], ["Unknown speaker 2", "hello"]])
})

test("M6: a turn whose first line is an estimate is marked ~", () => {
  const t = turns([
    { speaker: "A", text: "batched", start: 0, end: 1000, estimated: true },
    { speaker: "A", text: "live", start: 2000, end: 3000 },
  ])
  assert.equal(t[0].estimated, true)
})

test("Task 3 review minor: a leading ~~~ can't open a code fence, and ~~ can't strike text through", () => {
  const md = formatTranscript(base({ utterances: [
    { speaker: "A", text: "~~~ everything after this would be code", start, end: start + 1000 },
    { speaker: "B", text: "that is ~~not~~ fine", start: start + 9000, end: start + 9500 },
  ] }))
  assert.doesNotMatch(md, /^~~~/m)
  assert.doesNotMatch(md, /(^|[^\\])~~not/)
  assert.match(md, /^\\~\\~\\~ everything after this would be code$/m)
})

test("Task 3 review minor: HTML entities in captions stay literal text ('&lt;' is not shown as '<')", () => {
  const md = formatTranscript(base({ utterances: [{ speaker: "A", text: "type &lt;div&gt; or &#60; and AT&T stays", start, end: start + 1000 }] }))
  assert.match(md, /^type \\&lt;div\\&gt; or \\&#60; and AT&T stays$/m)
})
