// The same utterance delivered twice under two ids (seen live 2026-11-12: for two stretches of a
// call, every feed line was stored twice). Copies start together while the first is still live.
const test = require("node:test")
const assert = require("node:assert/strict")
const { UtteranceTracker } = require("../src/shared/merge.js")

const texts = (tr) => tr.snapshot().map((e) => e.text)

test("a copy under another id, interleaved with the original, is kept once", () => {
  let t = 1000
  const tr = new UtteranceTracker(() => t)
  tr.add({ id: 41, version: 1, text: "So here,", device: "d2" })
  t += 300
  tr.add({ id: 7, version: 1, text: "So here,", device: "d2" })
  t += 400
  tr.add({ id: 41, version: 2, text: "So here, this key.", device: "d2" })
  t += 200
  tr.add({ id: 7, version: 2, text: "So here, this", device: "d2" })
  t += 200
  tr.add({ id: 7, version: 3, text: "So here, this key.", device: "d2", final: true })
  tr.add({ id: 41, version: 3, text: "So here, this key.", device: "d2", final: true })
  assert.deepEqual(texts(tr), ["So here, this key."])
  assert.equal(tr.twins, 1)
})

test("a lagging copy never shortens the line", () => {
  let t = 0
  const tr = new UtteranceTracker(() => t)
  tr.add({ id: 1, version: 1, text: "Okay, that makes sense", device: "d" })
  t += 500
  tr.add({ id: 2, version: 1, text: "Okay,", device: "d" })
  assert.deepEqual(texts(tr), ["Okay, that makes sense"])
  t += 500
  tr.add({ id: 2, version: 2, text: "Okay, that makes sense that they also work upon.", device: "d", final: true })
  assert.deepEqual(texts(tr), ["Okay, that makes sense that they also work upon."])
})

test("the next utterance by the same person is not a copy", () => {
  let t = 0
  const tr = new UtteranceTracker(() => t)
  tr.add({ id: 1, version: 1, text: "Yeah.", device: "d", final: true })
  t += 800
  tr.add({ id: 2, version: 1, text: "Yeah, and also there's one more.", device: "d" })
  assert.deepEqual(texts(tr), ["Yeah.", "Yeah, and also there's one more."])
  assert.equal(tr.twins, 0)
})

test("the same words from another person are not a copy", () => {
  let t = 0
  const tr = new UtteranceTracker(() => t)
  tr.add({ id: 1, version: 1, text: "Ah, okay.", device: "a" })
  t += 300
  tr.add({ id: 2, version: 1, text: "Ah, okay.", device: "b" })
  assert.equal(tr.snapshot().length, 2)
})

test("an utterance starting well after the live one is not a copy", () => {
  let t = 0
  const tr = new UtteranceTracker(() => t)
  tr.add({ id: 1, version: 1, text: "We did.", device: "d" })
  t += 4000
  tr.add({ id: 2, version: 1, text: "We did.", device: "d" })
  assert.equal(tr.snapshot().length, 2)
})
