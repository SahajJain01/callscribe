// Caption timing. Regression for the 2026-11-05 Companion-mode call: Meet stopped applying
// caption updates while its tab wasn't drawn, then rendered 61 turns in one go, and every
// turn was stamped with that single arrival time (01:02:25 in a 01:02:52 call).
const test = require("node:test")
const assert = require("node:assert/strict")
const { CaptionTracker } = require("../src/shared/merge.js")

const words = (n, w = "word") => Array.from({ length: n }, (_, i) => w + i).join(" ")

test("captions arriving live keep their real arrival times and are not estimated", () => {
  let t = 1000
  const tr = new CaptionTracker(() => t)
  const a = {}, b = {}
  t = 5000; tr.update([{ key: a, speaker: "A", text: "Hello" }])
  t = 6000; tr.update([{ key: a, speaker: "A", text: "Hello there team" }])
  t = 20000; tr.update([{ key: a, speaker: "A", text: "Hello there team" }, { key: b, speaker: "B", text: "Hi" }])
  const s = tr.snapshot()
  assert.deepEqual(s.map((e) => [e.start, e.end, Boolean(e.estimated)]), [[5000, 6000, false], [20000, 20000, false]])
})

test("a backlog of many turns rendered at once does not collapse onto one timestamp", () => {
  let t = 0
  const tr = new CaptionTracker(() => t) // session starts at 0
  // Nothing renders for an hour, then 61 turns appear in one read.
  t = 3745000
  const rows = Array.from({ length: 61 }, (_, i) => ({ key: {}, speaker: i % 2 ? "Emanuel Piza" : "Sahaj Jain", text: words(10 + (i % 7) * 5) }))
  tr.update(rows)
  const s = tr.snapshot()
  assert.equal(s.length, 61)
  const starts = s.map((e) => e.start)
  assert.equal(new Set(starts).size, 61, "every turn gets its own start time")
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] > starts[i - 1], "starts increase in transcript order")
  assert.ok(starts[0] >= 0, "never before the session started")
  assert.ok(s[60].end <= 3745000, "never after the moment the batch arrived")
  assert.ok(s.every((e) => e.estimated), "batch timings are flagged as estimates")
  // ~150 words per minute: 61 turns of 10-40 words span several minutes, not 0 s.
  assert.ok(3745000 - starts[0] > 5 * 60 * 1000)
})

test("a backlog is squeezed between the last known caption and the arrival time", () => {
  let t = 0
  const tr = new CaptionTracker(() => t)
  const a = {}
  t = 10000; tr.update([{ key: a, speaker: "A", text: "Earlier live line" }])
  t = 40000 // only 30 s later, but the batch holds ~4 minutes of speech
  tr.update([{ key: a, speaker: "A", text: "Earlier live line" }, ...Array.from({ length: 6 }, (_, i) => ({ key: {}, speaker: i % 2 ? "B" : "A", text: words(100) }))])
  const s = tr.snapshot()
  assert.equal(s[0].start, 10000)
  assert.equal(Boolean(s[0].estimated), false)
  const batch = s.slice(1)
  assert.ok(batch[0].start >= 10000, "not before the previous known caption")
  assert.ok(batch[5].end <= 40000)
  for (let i = 1; i < batch.length; i++) assert.ok(batch[i].start > batch[i - 1].start)
})

test("one long turn that first appears already long is backdated by its length", () => {
  let t = 0
  const tr = new CaptionTracker(() => t)
  t = 600000
  tr.update([{ key: {}, speaker: "A", text: words(150) }]) // ~60 s of speech
  const [e] = tr.snapshot()
  assert.ok(e.estimated)
  assert.ok(600000 - e.start >= 50000 && 600000 - e.start <= 70000, `start ${e.start}`)
})

test("two short rows appearing together right after joining stay close to arrival", () => {
  let t = 0
  const tr = new CaptionTracker(() => t)
  t = 3000
  tr.update([{ key: {}, speaker: "A", text: "Hi" }, { key: {}, speaker: "B", text: "Hey there" }])
  const s = tr.snapshot()
  assert.ok(s.every((e) => 3000 - e.start <= 3000))
  assert.ok(s[1].end === 3000)
})

test("captions read during the final flush keep the time they arrived", () => {
  let t = 0
  const tr = new CaptionTracker(() => t)
  const a = {}
  t = 50000; tr.update([{ key: a, speaker: "A", text: "Okay" }])
  t = 51000; tr.update([{ key: a, speaker: "A", text: "Okay, bye everyone" }]) // final read in endSession
  const [e] = tr.snapshot()
  assert.deepEqual([e.start, e.end, Boolean(e.estimated)], [50000, 51000, false])
})
