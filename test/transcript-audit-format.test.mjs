import test from "node:test"
import assert from "node:assert/strict"
import { clock, turns, formatTranscript, fileBase, slug } from "../src/shared/format.js"

test("F1 clock past 1h and 100h", () => {
  assert.equal(clock(3600_000 + 61_000), "01:01:01")
  assert.equal(clock(100 * 3600_000), "100:00:00")
})
test("F2 turn merge across long same-speaker turn measured from end", () => {
  // two lines 3s apart after a 60s line: merged (expected)
  const t = turns([
    { speaker: "A", text: "x", start: 0, end: 60000 },
    { speaker: "A", text: "y", start: 63000, end: 64000 },
  ])
  assert.equal(t.length, 1)
})
test("F3 out-of-order utterances (start before previous end) negative gap merges", () => {
  const t = turns([
    { speaker: "A", text: "first", start: 10000, end: 20000 },
    { speaker: "B", text: "interject", start: 12000, end: 13000 },
    { speaker: "A", text: "second", start: 21000, end: 22000 },
  ])
  assert.equal(t.length, 3)
})
test("F4 Unknown speakers merged into one turn though they may be different people", () => {
  const t = turns([
    { speaker: "Unknown", text: "hi", start: 0, end: 500 },
    { speaker: "Unknown", text: "hello", start: 1000, end: 1500 },
  ])
  assert.equal(t.length, 2)
})
test("F5 estimated flag: merged turn whose FIRST line is live but later estimated is marked ~", () => {
  const t = turns([
    { speaker: "A", text: "live", start: 0, end: 1000 },
    { speaker: "A", text: "batched", start: 2000, end: 3000, estimated: true },
  ])
  // The displayed time is the first line's (live) start: it should NOT be marked ~
  assert.equal(t[0].estimated, false)
})
test("F6 utterance before session start renders 00:00:00 silently", () => {
  const md = formatTranscript({ platformName: "Google Meet", startedAt: 10000, endedAt: 20000, utterances: [{ speaker: "A", text: "hi", start: 5000, end: 6000 }] })
  assert.match(md, /`00:00:00`/)
})
test("F7 fileBase with title of only non-latin chars (CJK) drops title", () => {
  const b = fileBase({ startedAt: Date.UTC(2026, 0, 1), platformName: "Google Meet", title: "週次定例" })
  assert.match(b, /週次定例|_Google-Meet_/)
  assert.ok(b.includes("週"), "CJK title lost: " + b)
})
test("F8 fileBase with accented title keeps letters", () => {
  const b = fileBase({ startedAt: 0, platformName: "Google Meet", title: "Réunion d'équipe" })
  assert.ok(b.endsWith("Reunion-dequipe"), b)
})
// F9 (Windows-reserved slug) dropped: speculative per the audit; the date prefix keeps file names from being bare "CON".
test("F10 title with markdown special chars in heading", () => {
  const md = formatTranscript({ platformName: "Slack huddle", title: "#general\nmalicious", startedAt: 0, endedAt: 1000, utterances: [] })
  assert.equal(md.split("\n")[0], "# #general malicious")
})
test("F11 speaker name with markdown chars", () => {
  const md = formatTranscript({ platformName: "Meet", startedAt: 0, endedAt: 1, utterances: [{ speaker: "a**b", text: "hi", start: 0, end: 1 }] })
  assert.ok(!md.includes("**a**b**"), md)
})
test("F12 caption text starting with markdown syntax", () => {
  const md = formatTranscript({ platformName: "Meet", startedAt: 0, endedAt: 1, utterances: [{ speaker: "A", text: "# 1 priority is ---", start: 0, end: 1 }] })
  assert.ok(!/^# 1 priority/m.test(md), "text rendered as heading")
})
test("F13 speakers list includes Unknown only if present; empty-name speaker", () => {
  const md = formatTranscript({ platformName: "Meet", startedAt: 0, endedAt: 1, utterances: [{ speaker: "", text: "hi", start: 0, end: 1 }] })
  assert.ok(!md.includes("****"), md)
})
