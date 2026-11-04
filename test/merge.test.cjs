const test = require("node:test")
const assert = require("node:assert/strict")
const { mergeText, CaptionTracker } = require("../src/shared/merge.js")

test("growing row keeps the newest rendering", () => {
  assert.equal(mergeText("Hello team this", "Hello team this is a test"), "Hello team this is a test")
})

test("refined recent words replace the old ones", () => {
  assert.equal(
    mergeText("Hello team, this is a tess of the", "Hello team, this is a test of the caption"),
    "Hello team, this is a test of the caption",
  )
})

test("stale shorter rendering is ignored", () => {
  assert.equal(mergeText("we should ship on Friday afternoon", "ship on Friday"), "we should ship on Friday afternoon")
})

test("front-trimmed row is appended through the overlap", () => {
  const prev = "The quarterly numbers look good and we should ship the release"
  const next = "we should ship the release on Friday afternoon"
  assert.equal(mergeText(prev, next), "The quarterly numbers look good and we should ship the release on Friday afternoon")
})

test("front-trimmed and refined row is anchored on its first words", () => {
  const prev = "The quarterly numbers look good and we should chip the release"
  const next = "and we should ship the release on Friday"
  assert.equal(mergeText(prev, next), "The quarterly numbers look good and we should ship the release on Friday")
})

test("real Meet row sequence (re-punctuated start, repeated speech) yields the final text once", () => {
  const seq = require("./fixtures/meet-row-sequence.json")
  let acc = ""
  for (const s of seq) acc = mergeText(acc, s)
  assert.equal(acc, seq[seq.length - 1])
})

test("early-word correction is a replacement, not an append", () => {
  const prev = "Hello team! This is a test of the caption recorder we are checking whether"
  const next = "Hello, team! This is a test of the caption recorder. We are checking whether every sentence."
  assert.equal(mergeText(prev, next), next)
})

test("front-trimmed long row with repeated phrases keeps both halves", () => {
  const prev = "Hello team this is a test. We ship Friday. Hello team this is a test"
  const next = "We ship Friday. Hello team this is a test of the recorder"
  assert.equal(mergeText(prev, next), "Hello team this is a test. We ship Friday. Hello team this is a test of the recorder")
})

test("tracker builds utterances per row and speaker", () => {
  let t = 0
  const tr = new CaptionTracker(() => t)
  const a = {}, b = {}
  tr.update([{ key: a, speaker: "Alice", text: "Hi" }])
  t = 1000
  tr.update([{ key: a, speaker: "Alice", text: "Hi there everyone" }])
  t = 2000
  tr.update([{ key: a, speaker: "Alice", text: "Hi there everyone" }, { key: b, speaker: "Bob", text: "Morning" }])
  t = 3000
  tr.update([{ key: b, speaker: "Bob", text: "Morning Alice" }])
  const s = tr.snapshot()
  assert.deepEqual(s.map((e) => [e.speaker, e.text, e.start, e.end]), [
    ["Alice", "Hi there everyone", 0, 1000],
    ["Bob", "Morning Alice", 2000, 3000],
  ])
})

test("row re-rendered in a new element is not duplicated", () => {
  let t = 0
  const tr = new CaptionTracker(() => t)
  tr.update([{ key: {}, speaker: "Alice", text: "Let us start with the budget" }])
  t = 500
  tr.update([{ key: {}, speaker: "Alice", text: "Let us start with the budget for Q3" }])
  const s = tr.snapshot()
  assert.equal(s.length, 1)
  assert.equal(s[0].text, "Let us start with the budget for Q3")
})

test("same speaker saying something new later is a new utterance", () => {
  let t = 0
  const tr = new CaptionTracker(() => t)
  tr.update([{ key: {}, speaker: "Alice", text: "First point" }])
  t = 30000
  tr.update([{ key: {}, speaker: "Alice", text: "First point again" }])
  assert.equal(tr.snapshot().length, 2)
})

test("a reused row element for a different speaker starts a new utterance", () => {
  const tr = new CaptionTracker(() => 0)
  const k = {}
  tr.update([{ key: k, speaker: "Alice", text: "Hello" }])
  tr.update([{ key: k, speaker: "Bob", text: "Hey" }])
  assert.deepEqual(tr.snapshot().map((e) => e.speaker), ["Alice", "Bob"])
})
