const test = require("node:test")
const assert = require("node:assert/strict")
const { mergeText, CaptionTracker, UtteranceTracker } = require("../src/shared/merge.js")

test("D1 CJK row growing over 6 reads in one element yields the final text once", () => {
  let t = 0
  const tr = new CaptionTracker(() => t)
  const row = {}
  const seq = ["今日", "今日は", "今日はいい", "今日はいい天気", "今日はいい天気です", "今日はいい天気ですね。"]
  for (const s of seq) { tr.update([{ key: row, speaker: "Ken", text: s }]); t += 300 }
  assert.equal(tr.snapshot()[0].text, "今日はいい天気ですね。")
})

test("D2 self label 'You' resolved to the real name mid-row does not duplicate the row", () => {
  let t = 0
  const tr = new CaptionTracker(() => t)
  const row = {}
  tr.update([{ key: row, speaker: "You", text: "Let me share my screen" }])
  t = 500
  tr.update([{ key: row, speaker: "An Nguyen", text: "Let me share my screen now" }])
  const s = tr.snapshot()
  assert.equal(s.length, 1, JSON.stringify(s))
})

test("D3 utterance continuing across a stream restart (new epoch, same id) is not duplicated", () => {
  const tr = new UtteranceTracker(() => 0)
  const d = "spaces/s/devices/1"
  tr.add({ id: "7", version: 3, text: "So the plan", device: d, epoch: 1 }, 1000)
  tr.add({ id: "7", version: 4, text: "So the plan is to ship Friday.", final: true, device: d, epoch: 2 }, 2000)
  const s = tr.snapshot().map((e) => e.text)
  assert.deepEqual(s, ["So the plan is to ship Friday."])
})

test("D4 full re-rendering wins even when it drops earlier content that shared the opening words", () => {
  const prev = "Hello team this is a test. We ship Friday. Hello team this is a test"
  const next = "Hello team this is a test of the recorder"
  assert.ok(mergeText(prev, next).includes("We ship Friday"), mergeText(prev, next))
})
