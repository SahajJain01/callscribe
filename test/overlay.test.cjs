const test = require("node:test")
const assert = require("node:assert/strict")
const { formatElapsed, clampPos, overlayModel, renderRows } = require("../src/content/overlay.js")

const T0 = 1_700_000_000_000

function state(over) {
  return Object.assign(
    { platform: "google-meet", startedAt: T0, source: "feed", audio: "recording", micMuted: false, lines: [], lastCaptionAt: 0 },
    over,
  )
}

function row(model, label) {
  return model.status.find((r) => r.label === label)
}

test("formatElapsed: m:ss under an hour, h:mm:ss from an hour", () => {
  assert.equal(formatElapsed(0), "0:00")
  assert.equal(formatElapsed(754000), "12:34")
  assert.equal(formatElapsed(3725000), "1:02:05")
})

test("formatElapsed: negative or missing time reads 0:00", () => {
  assert.equal(formatElapsed(-500), "0:00")
  assert.equal(formatElapsed(NaN), "0:00")
})

test("clampPos pulls an off-screen pill back inside a 4 px margin", () => {
  assert.deepEqual(clampPos({ x: 5000, y: -50 }, { w: 300, h: 30 }, { vw: 1280, vh: 720 }), { x: 976, y: 4 })
})

test("clampPos leaves an in-view position alone", () => {
  assert.deepEqual(clampPos({ x: 100, y: 100 }, { w: 300, h: 30 }, { vw: 1280, vh: 720 }), { x: 100, y: 100 })
})

test("overlayModel: Meet feed source is ok", () => {
  assert.deepEqual(row(overlayModel(state({ source: "feed" }), T0 + 1000), "Captions"), { label: "Captions", value: "Meet feed", level: "ok" })
})

test("overlayModel: CC fallback on Meet is a warning", () => {
  const r = row(overlayModel(state({ source: "cc" }), T0 + 1000), "Captions")
  assert.equal(r.value, "CC fallback")
  assert.equal(r.level, "warn")
})

test("overlayModel: CC on a Slack huddle reads Slack captions, ok", () => {
  const r = row(overlayModel(state({ platform: "slack-huddle", source: "cc" }), T0 + 1000), "Captions")
  assert.deepEqual(r, { label: "Captions", value: "Slack captions", level: "ok" })
})

test("overlayModel: muted mic is a warning", () => {
  assert.deepEqual(row(overlayModel(state({ micMuted: true }), T0 + 1000), "Mic"), { label: "Mic", value: "muted, not recorded", level: "warn" })
})

test("overlayModel: unknown mic state omits the Mic row", () => {
  assert.equal(row(overlayModel(state({ micMuted: undefined }), T0 + 1000), "Mic"), undefined)
})

test("overlayModel: audio error is a warning", () => {
  const r = row(overlayModel(state({ audio: "error" }), T0 + 1000), "Audio")
  assert.equal(r.level, "warn")
})

test("overlayModel: Lines row counts lines; rows are in order", () => {
  const lines = [
    { speaker: "Sam", text: "hi", start: T0 + 1000, end: T0 + 2000, live: false },
    { speaker: "Priya", text: "hello", start: T0 + 3000, end: T0 + 4000, live: true },
  ]
  const m = overlayModel(state({ lines, lastCaptionAt: T0 + 4000 }), T0 + 5000)
  assert.deepEqual(row(m, "Lines"), { label: "Lines", value: "2", level: "plain" })
  assert.deepEqual(m.status.map((r) => r.label), ["Captions", "Audio", "Mic", "Lines"])
})

test("overlayModel: latest is the last line, or null", () => {
  const lines = [
    { speaker: "Sam", text: "hi", start: T0 + 1000, end: T0 + 2000, live: false },
    { speaker: "Priya", text: "hello", start: T0 + 3000, end: T0 + 4000, live: true },
  ]
  assert.deepEqual(overlayModel(state({ lines }), T0 + 5000).latest, { speaker: "Priya", text: "hello", live: true })
  assert.equal(overlayModel(state(), T0 + 5000).latest, null)
})

test("overlayModel: elapsed is formatted from startedAt", () => {
  assert.equal(overlayModel(state(), T0 + 754000).elapsed, "12:34")
})

test("overlayModel: no warning 10 s into a call with no captions", () => {
  assert.equal(overlayModel(state({ source: "none" }), T0 + 10000).warn, false)
})

test("overlayModel: warn flips just past 30 s without captions", () => {
  assert.equal(overlayModel(state(), T0 + 30000).warn, false)
  assert.equal(overlayModel(state(), T0 + 30001).warn, true)
})

test("overlayModel: warn tracks the last caption, both sides of 30 s", () => {
  const s = state({ lastCaptionAt: T0 + 60000 })
  assert.equal(overlayModel(s, T0 + 90000).warn, false)
  assert.equal(overlayModel(s, T0 + 90001).warn, true)
})

test("overlayModel: no captions yet is plain, then warn once overdue", () => {
  assert.equal(row(overlayModel(state({ source: "none" }), T0 + 10000), "Captions").level, "plain")
  const r = row(overlayModel(state({ source: "none" }), T0 + 40000), "Captions")
  assert.deepEqual(r, { label: "Captions", value: "none yet", level: "warn" })
})

test("overlayModel: audio states", () => {
  const at = (audio) => row(overlayModel(state({ audio }), T0 + 1000), "Audio")
  assert.deepEqual(at("recording"), { label: "Audio", value: "recording", level: "ok" })
  assert.deepEqual(at("starting"), { label: "Audio", value: "starting", level: "plain" })
  assert.deepEqual(at("off"), { label: "Audio", value: "off", level: "plain" })
  assert.deepEqual(at("error"), { label: "Audio", value: "error", level: "warn" })
})

// Minimal DOM stand-in: enough for renderRows (createElement, appendChild, children, textContent, className).
function fakeDoc() {
  let created = 0
  const make = (tag) => {
    created++
    const el = {
      tag,
      children: [],
      className: "",
      _text: "",
      writes: 0,
      appendChild(c) { this.children.push(c); return c },
      get textContent() { return this._text },
      set textContent(v) { this._text = String(v); this.writes++ },
      get childElementCount() { return this.children.length },
    }
    return el
  }
  return { createElement: make, get created() { return created } }
}

test("renderRows reuses row nodes and only patches what changed", () => {
  const doc = fakeDoc()
  const list = doc.createElement("div")
  const lines = [
    { speaker: "Unknown", text: "first", start: T0 + 1000, live: false },
    { speaker: "Sam", text: "second", start: T0 + 61000, live: true },
  ]
  renderRows(doc, list, lines, T0)
  assert.equal(list.children.length, 2)
  const [r0, r1] = list.children
  assert.equal(r0.speaker.textContent, "Unknown:")
  assert.equal(r0.time.textContent, "0:01")
  assert.equal(r1.time.textContent, "1:01")
  assert.match(r1.className, /live/)
  const created = doc.created
  const r0writes = r0.text.writes

  // Name arrives late, live line finalises with unchanged text, a new line appears.
  renderRows(doc, list, [
    { speaker: "Priya", text: "first", start: T0 + 1000, live: false },
    { speaker: "Sam", text: "second", start: T0 + 61000, live: false },
    { speaker: "Sam", text: "third", start: T0 + 70000, live: true },
  ], T0)
  assert.equal(list.children.length, 3)
  assert.equal(list.children[0], r0)
  assert.equal(list.children[1], r1)
  assert.equal(r0.speaker.textContent, "Priya:")
  assert.equal(r0.text.writes, r0writes, "unchanged text is not rewritten")
  assert.doesNotMatch(r1.className, /live/)
  assert.ok(doc.created > created)

  // Same lines again: nothing created, nothing written.
  const c2 = doc.created
  const w = r1.text.writes + r1.speaker.writes
  renderRows(doc, list, [
    { speaker: "Priya", text: "first", start: T0 + 1000, live: false },
    { speaker: "Sam", text: "second", start: T0 + 61000, live: false },
    { speaker: "Sam", text: "third", start: T0 + 70000, live: true },
  ], T0)
  assert.equal(doc.created, c2)
  assert.equal(r1.text.writes + r1.speaker.writes, w)
})

test("renderRows puts markup in text literally", () => {
  const doc = fakeDoc()
  const list = doc.createElement("div")
  renderRows(doc, list, [{ speaker: "<b>x</b>", text: "<script>alert(1)</script>", start: T0, live: false }], T0)
  assert.equal(list.children[0].text.textContent, "<script>alert(1)</script>")
  assert.equal(list.children[0].speaker.textContent, "<b>x</b>:")
})
