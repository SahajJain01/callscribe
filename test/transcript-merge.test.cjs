// Caption merging beyond the audit's probes: scripts without spaces (C2), re-renderings (I1),
// repeated short answers (I2), unnamed speakers (I3), stream restarts (I4/M3), merging the
// feed with the DOM captions (C1).
const test = require("node:test")
const assert = require("node:assert/strict")
const { mergeText, CaptionTracker, UtteranceTracker, mergeSources } = require("../src/shared/merge.js")

const grow = (seq) => seq.reduce((acc, s) => mergeText(acc, s), "")

test("C2: a Japanese row with a kanji correction mid-row is a replacement", () => {
  assert.equal(mergeText("今日はいい天気", "今日は良い天気ですね"), "今日は良い天気ですね")
})

test("C2: Chinese, Thai, Japanese and Korean rows growing one read at a time end with the final text once", () => {
  for (const seq of [
    ["我们", "我们明天", "我们明天开会", "我们明天开会讨论一下预算。"],
    ["สวัสดี", "สวัสดีครับ", "สวัสดีครับทุกคน", "สวัสดีครับทุกคนวันนี้เราจะคุยเรื่องงบประมาณ"],
    ["デザイン", "デザインレビューを", "デザインレビューを始めましょう。"],
    ["오늘", "오늘 회의는", "오늘 회의는 짧게 하겠습니다."],
  ]) assert.equal(grow(seq), seq.at(-1))
})

test("C2: Vietnamese and German rows growing and re-rendered", () => {
  assert.equal(grow(["Chúng ta cần", "Chúng ta cần họp", "Chúng ta cần họp vào thứ Hai."]), "Chúng ta cần họp vào thứ Hai.")
  assert.equal(mergeText("Wir brauchen die Projekt Planung", "Wir brauchen die Projektplanung bis Freitag"), "Wir brauchen die Projektplanung bis Freitag")
  assert.equal(mergeText("Straße und Größe", "Straße und Größe passen."), "Straße und Größe passen.")
})

test("C2: a CJK row that is front-trimmed (long row) keeps both halves without repeating", () => {
  // The row is long: the UI dropped the first sentence and kept growing.
  const prev = "今日はいい天気ですね。午後から会議があります。資料は共有しました。"
  const next = "資料は共有しました。質問はありますか。"
  assert.equal(mergeText(prev, next), "今日はいい天気ですね。午後から会議があります。資料は共有しました。質問はありますか。")
})

test("C1 (row reuse): same element reused by the same speaker for an unrelated sentence keeps both", () => {
  assert.equal(mergeText("First sentence here.", "Second one now."), "First sentence here. Second one now.")
})

test("I2: the same short answer said again after a pause, with nobody in between, is kept", () => {
  let t = 0
  const tr = new CaptionTracker(() => t)
  tr.update([{ key: {}, speaker: "Alice", text: "OK." }])
  t = 8000
  tr.update([{ key: {}, speaker: "Alice", text: "OK." }])
  assert.deepEqual(tr.snapshot().map((e) => e.text), ["OK.", "OK."])
})

test("I2: two rows on screen at once, the earlier one re-rendered in a fresh element, is still one entry", () => {
  let t = 0
  const tr = new CaptionTracker(() => t)
  const a = {}, b = {}, a2 = {}
  tr.update([{ key: a, speaker: "Alice", text: "We should look at" }, { key: b, speaker: "Bob", text: "Right" }])
  t = 500
  tr.update([{ key: a2, speaker: "Alice", text: "We should look at the budget" }, { key: b, speaker: "Bob", text: "Right" }])
  assert.deepEqual(tr.snapshot().map((e) => `${e.speaker}: ${e.text}`), ["Alice: We should look at the budget", "Bob: Right"])
})

test("M4: once 'You' is known to be An Nguyen, later 'You' rows are An Nguyen too", () => {
  let t = 0
  const tr = new CaptionTracker(() => t)
  const row = {}
  tr.update([{ key: row, speaker: "You", text: "Let me share" }])
  t = 500
  tr.update([{ key: row, speaker: "An Nguyen", text: "Let me share my screen" }])
  t = 20000
  tr.update([{ key: {}, speaker: "You", text: "Can everyone see it?" }])
  assert.deepEqual(tr.snapshot().map((e) => e.speaker), ["An Nguyen", "An Nguyen"])
})

test("M4: a reused row for a different person after 'You' still splits", () => {
  let t = 0
  const tr = new CaptionTracker(() => t)
  const row = {}
  tr.update([{ key: row, speaker: "You", text: "Thanks everyone" }])
  t = 3000
  tr.update([{ key: row, speaker: "Bob", text: "Before we go, one more thing" }])
  assert.deepEqual(tr.snapshot().map((e) => `${e.speaker}: ${e.text}`), ["You: Thanks everyone", "Bob: Before we go, one more thing"])
})

test("I3: unnamed devices are numbered in first-seen order, and snapshots carry the device", () => {
  const tr = new UtteranceTracker(() => 0)
  tr.add({ id: "1", version: 1, text: "hi", device: "d/2" }, 0)
  tr.add({ id: "2", version: 1, text: "hello", device: "d/1" }, 100)
  tr.add({ id: "3", version: 1, text: "again", device: "d/2" }, 200)
  tr.setName("d/1", "Priya")
  assert.deepEqual(tr.snapshot().map((e) => [e.speaker, e.device]), [["Unknown speaker 1", "d/2"], ["Priya", "d/1"], ["Unknown speaker 1", "d/2"]])
  assert.deepEqual(tr.view().map((e) => e.speaker), ["Unknown speaker 1", "Priya", "Unknown speaker 1"])
})

test("I4 safety net: after a final, a lower version with unrelated text is a new utterance", () => {
  const tr = new UtteranceTracker(() => 0)
  tr.add({ id: "1", version: 8, text: "first utterance words", final: true, device: "d" }, 100)
  tr.add({ id: "1", version: 1, text: "second", device: "d" }, 200)
  tr.add({ id: "1", version: 2, text: "second utterance", final: true, device: "d" }, 300)
  assert.deepEqual(tr.snapshot().map((e) => e.text), ["first utterance words", "second utterance"])
})

test("M3: a continuing utterance across a restart whose id changed is not duplicated either", () => {
  const tr = new UtteranceTracker(() => 0)
  tr.add({ id: "7", version: 3, text: "So the plan", device: "d", epoch: 1 }, 1000)
  tr.add({ id: "1", version: 1, text: "So the plan is to ship", device: "d", epoch: 2 }, 2000)
  tr.add({ id: "1", version: 2, text: "So the plan is to ship Friday.", final: true, device: "d", epoch: 2 }, 2500)
  assert.deepEqual(tr.snapshot().map((e) => [e.text, e.start]), [["So the plan is to ship Friday.", 1000]])
})

test("M3: a final utterance from the old epoch is never swallowed by a new one", () => {
  const tr = new UtteranceTracker(() => 0)
  tr.add({ id: "7", version: 3, text: "Yes", final: true, device: "d", epoch: 1 }, 1000)
  tr.add({ id: "1", version: 1, text: "Yes we can", device: "d", epoch: 2 }, 5000)
  assert.deepEqual(tr.snapshot().map((e) => e.text), ["Yes", "Yes we can"])
})

test("mergeSources: DOM lines in gaps are added; DOM lines the feed already has are not", () => {
  const feed = [
    { speaker: "Bob", text: "Sounds good, let us do that.", start: 10000, end: 12000 },
    { speaker: "Bob", text: "Next item.", start: 30000, end: 31000 },
  ]
  const dom = [
    { speaker: "Alice", text: "Shall we start with the budget?", start: 2000, end: 5000 },
    { speaker: "Bob", text: "Sounds good let us do that", start: 10200, end: 12100 },
    { speaker: "Alice", text: "The launch moves to May.", start: 40000, end: 42000 },
  ]
  assert.deepEqual(mergeSources(feed, dom).map((e) => e.text), [
    "Shall we start with the budget?", "Sounds good, let us do that.", "Next item.", "The launch moves to May.",
  ])
})

test("mergeSources: overlapping CJK lines are recognised as the same speech", () => {
  const feed = [{ speaker: "Ken", text: "今日はいい天気ですね。", start: 1000, end: 3000 }]
  const dom = [{ speaker: "Ken", text: "今日はいい天気ですね", start: 1200, end: 3100 }]
  assert.deepEqual(mergeSources(feed, dom).map((e) => e.text), ["今日はいい天気ですね。"])
})

test("mergeSources: a different speaker talking over a feed line is kept", () => {
  const feed = [{ speaker: "Bob", text: "I think we can ship on Friday if QA agrees.", start: 1000, end: 6000 }]
  const dom = [{ speaker: "Alice", text: "Agreed.", start: 3000, end: 3500 }]
  assert.deepEqual(mergeSources(feed, dom).map((e) => e.text), ["I think we can ship on Friday if QA agrees.", "Agreed."])
})

test("mergeSources keeps extra fields (live, estimated) for the overlay and the export", () => {
  const out = mergeSources([{ speaker: "B", text: "feed", start: 9000, end: 9500, live: true }], [{ speaker: "A", text: "dom", start: 0, end: 500, estimated: true, live: false }])
  assert.deepEqual(out, [{ speaker: "A", text: "dom", start: 0, end: 500, estimated: true, live: false }, { speaker: "B", text: "feed", start: 9000, end: 9500, live: true }])
})
