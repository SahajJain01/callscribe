import test from "node:test"
import assert from "node:assert/strict"
import { formatTranscript, fileBase, turns, clock } from "../src/shared/format.js"

const start = new Date(2026, 10, 4, 16, 5, 0).getTime()

test("clock", () => {
  assert.equal(clock(3723000), "01:02:03")
})

test("file name is date, platform, title", () => {
  assert.equal(fileBase({ startedAt: start, platformName: "Google Meet", title: "Weekly sync: Q3/Q4" }), "2026-11-04_1605_Google-Meet_Weekly-sync-Q3Q4")
})

test("consecutive lines by one speaker merge into a turn", () => {
  const t = turns([
    { speaker: "A", text: "one", start: 0, end: 1000 },
    { speaker: "A", text: "two", start: 2000, end: 3000 },
    { speaker: "B", text: "three", start: 3500, end: 4000 },
  ])
  assert.deepEqual(t.map((x) => [x.speaker, x.text]), [["A", "one two"], ["B", "three"]])
})

test("estimated times are marked with ~ and explained; live times are not", () => {
  const md = formatTranscript({
    platformName: "Google Meet", title: "x", startedAt: start, endedAt: start + 600000,
    utterances: [
      { speaker: "A", text: "live", start: start + 5000, end: start + 6000 },
      { speaker: "B", text: "batched", start: start + 300000, end: start + 310000, estimated: true },
    ],
  })
  assert.match(md, /\*\*A\*\* `00:00:05`/)
  assert.match(md, /\*\*B\*\* `~00:05:00`/)
  assert.match(md, /Times marked ~ are estimates/)
})

test("transcript markdown", () => {
  const md = formatTranscript({
    platformName: "Slack huddle",
    title: "#design",
    startedAt: start,
    endedAt: start + 65000,
    audio: { chunks: 3 },
    utterances: [{ speaker: "Sahaj", text: "Hello", start: start + 5000, end: start + 6000 }],
  })
  assert.match(md, /^# #design/)
  assert.match(md, /Duration: 00:01:05/)
  assert.match(md, /Audio backup: 2026-11-04_1605_Slack-huddle_design\.webm/)
  assert.match(md, /\*\*Sahaj\*\* `00:00:05`\nHello/)
})

test("the audio line names the file that was actually saved (lifecycle F9)", () => {
  const s = { platformName: "Slack huddle", title: "#design", startedAt: start, endedAt: start + 65000, audio: { chunks: 3 }, utterances: [] }
  assert.match(formatTranscript(s, { audioFile: "2026-11-04_1605_Slack-huddle_design_ab3cd (1).ogg" }),
    /^- Audio backup: 2026-11-04_1605_Slack-huddle_design_ab3cd \(1\)\.ogg \(timestamps below match it\)$/m)
  const none = formatTranscript(s, { audioFile: null })
  assert.match(none, /^- Audio backup: not saved$/m)
  assert.doesNotMatch(none, /\.webm/)
})
