// Throwaway audit probes. Each test asserts the CORRECT behaviour; failures = findings.
const test = require("node:test")
const assert = require("node:assert/strict")
const { mergeText, CaptionTracker, UtteranceTracker } = require("../src/shared/merge.js")

// --- mergeText ---
test("M1 CJK growing row (no spaces) keeps newest, not concatenation", () => {
  assert.equal(mergeText("今日は", "今日はいい天気ですね"), "今日はいい天気ですね")
})
test("M2 CJK re-punctuated row", () => {
  assert.equal(mergeText("今日はいい天気ですね", "今日は、いい天気ですね。"), "今日は、いい天気ですね。")
})
test("M3 CJK correction early in row", () => {
  assert.equal(mergeText("我们明天开会讨论", "我们明天开会讨论一下预算"), "我们明天开会讨论一下预算")
})
test("M4 CJK correction of first char", () => {
  // first char corrected — whole new rendering
  assert.equal(mergeText("我门明天开会", "我们明天开会讨论"), "我们明天开会讨论")
})
test("M5 short utterance replaced by correction (Yes -> Yeah)", () => {
  assert.equal(mergeText("Yes", "Yeah."), "Yeah.")
})
test("M6 two-word correction", () => {
  assert.equal(mergeText("I think", "I thought so."), "I thought so.")
})
test("M7 number re-rendering: words -> digits", () => {
  assert.equal(
    mergeText("we need twenty five units by", "we need 25 units by Friday"),
    "we need 25 units by Friday",
  )
})
test("M8 number re-rendering at start of row", () => {
  assert.equal(mergeText("Twenty five people joined", "25 people joined the call today"), "25 people joined the call today")
})
test("M9 front-trimmed short tail", () => {
  const prev = "one two three four five six seven eight nine ten"
  const next = "nine ten eleven"
  assert.equal(mergeText(prev, next), prev + " eleven")
})
test("M10 next repeats a phrase that occurs earlier in prev (not front-trimmed)", () => {
  // Speaker says the same phrase twice; DOM shows growing row
  const prev = "OK so OK so"
  const next = "OK so OK so let's start"
  assert.equal(mergeText(prev, next), next)
})
test("M11 stale fragment of a short row is not appended", () => {
  assert.equal(mergeText("Thanks everyone bye", "Thanks"), "Thanks everyone bye")
})
test("M12 apostrophe/curly quote re-rendering", () => {
  assert.equal(mergeText("We don’t know yet", "We don't know yet but soon"), "We don't know yet but soon")
})
test("M13 re-rendered start dropped first word (refinement deletes filler)", () => {
  // "Um so the plan" -> "So the plan is to ship" (filler removed)
  assert.equal(mergeText("Um so the plan", "So the plan is to ship"), "So the plan is to ship")
})
test("M14 hyphenation change", () => {
  assert.equal(mergeText("the follow up meeting is", "the follow-up meeting is on Monday"), "the follow-up meeting is on Monday")
})
test("M15 Thai (no spaces) growth", () => {
  assert.equal(mergeText("สวัสดี", "สวัสดีครับทุกคน"), "สวัสดีครับทุกคน")
})

// Random fuzz: growing prefixes of a sentence must end with the final string.
test("M16 fuzz: growing prefixes with random re-punctuation converge to final", () => {
  const base = "so the thing is we need to look at the numbers again and then the numbers again tomorrow ok".split(" ")
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  const fails = []
  for (let trial = 0; trial < 300; trial++) {
    let acc = ""
    let k = 1
    let last
    while (k <= base.length) {
      const ws = base.slice(0, k).map((w) => (rnd() < 0.15 ? w + "," : w))
      if (rnd() < 0.3) ws[0] = ws[0][0].toUpperCase() + ws[0].slice(1)
      last = ws.join(" ") + (rnd() < 0.3 ? "." : "")
      acc = mergeText(acc, last)
      k += 1 + Math.floor(rnd() * 3)
    }
    const final = base.join(" ") + "."
    acc = mergeText(acc, final)
    if (acc !== final) fails.push(acc)
  }
  assert.deepEqual(fails.slice(0, 3), [])
})

// --- CaptionTracker ---
test("C1 same speaker, two rows on screen at once, second short row not reattached into first", () => {
  let t = 0
  const tr = new CaptionTracker(() => t)
  const a = {}, b = {}
  tr.update([{ key: a, speaker: "Alice", text: "Let's ship it" }])
  t = 1000
  tr.update([{ key: a, speaker: "Alice", text: "Let's ship it on Friday." }])
  // row a scrolls off, new row b by Alice starts with "Let's"
  t = 3000
  tr.update([{ key: b, speaker: "Alice", text: "Let's also" }])
  t = 4000
  tr.update([{ key: b, speaker: "Alice", text: "Let's also check the budget." }])
  const s = tr.snapshot().map((e) => e.text)
  assert.deepEqual(s, ["Let's ship it on Friday.", "Let's also check the budget."])
})
test("C2 speaker says same short phrase twice in two rows (Yes. ... Yes.) both kept", () => {
  let t = 0
  const tr = new CaptionTracker(() => t)
  const a = {}, b = {}, c = {}
  tr.update([{ key: a, speaker: "Alice", text: "Yes." }])
  t = 2000
  tr.update([{ key: b, speaker: "Bob", text: "Can you hear me?" }])
  t = 4000
  tr.update([{ key: b, speaker: "Bob", text: "Can you hear me?" }, { key: c, speaker: "Alice", text: "Yes." }])
  const s = tr.snapshot().map((e) => `${e.speaker}: ${e.text}`)
  assert.deepEqual(s, ["Alice: Yes.", "Bob: Can you hear me?", "Alice: Yes."])
})
test("C3 Unknown speaker row later named: different named speaker reuses row", () => {
  let t = 0
  const tr = new CaptionTracker(() => t)
  const a = {}
  tr.update([{ key: a, speaker: "", text: "hello" }])
  t = 500
  tr.update([{ key: a, speaker: "Alice", text: "hello there" }])
  t = 1000
  tr.update([{ key: a, speaker: "Bob", text: "hi Alice" }])
  const s = tr.snapshot().map((e) => `${e.speaker}: ${e.text}`)
  assert.deepEqual(s, ["Alice: hello there", "Bob: hi Alice"])
})
test("C4 a row that clears and is reused by same speaker with new speech", () => {
  // Slack/Meet may replace text within the same element for a new sentence by same speaker
  let t = 0
  const tr = new CaptionTracker(() => t)
  const a = {}
  tr.update([{ key: a, speaker: "Alice", text: "First sentence here." }])
  t = 2000
  tr.update([{ key: a, speaker: "Alice", text: "Second one now." }])
  const s = tr.snapshot().map((e) => e.text)
  assert.equal(s.join(" "), "First sentence here. Second one now.")
})

// --- UtteranceTracker ---
test("U1 out-of-order: older version arriving after final does not revert text", () => {
  const tr = new UtteranceTracker(() => 0)
  tr.add({ id: "1", version: 3, text: "hello world.", final: true, device: "d" }, 100)
  tr.add({ id: "1", version: 2, text: "hello", final: false, device: "d" }, 200)
  assert.equal(tr.snapshot()[0].text, "hello world.")
})
test("U2 first arrival is a later version; start not pushed late by text", () => {
  const tr = new UtteranceTracker(() => 0)
  tr.add({ id: "1", version: 5, text: "a b c", device: "d" }, 1000)
  tr.add({ id: "1", version: 6, text: "a b c d", device: "d" }, 1200)
  const [e] = tr.snapshot()
  assert.equal(e.start, 1000)
  assert.equal(e.end, 1200)
})
test("U3 equal version re-delivery with emptier text doesn't flip final", () => {
  const tr = new UtteranceTracker(() => 0)
  tr.add({ id: "1", version: 4, text: "done.", final: true, device: "d" }, 100)
  tr.add({ id: "1", version: 4, text: "done.", final: false, device: "d" }, 200)
  assert.equal(tr.view()[0].live, false)
})
test("U4 device never named -> Unknown; two unnamed devices are indistinguishable", () => {
  const tr = new UtteranceTracker(() => 0)
  tr.add({ id: "1", version: 1, text: "hi", device: "spaces/x/devices/1" }, 0)
  tr.add({ id: "2", version: 1, text: "hello", device: "spaces/x/devices/2" }, 100)
  const s = tr.snapshot()
  assert.notEqual(s[0].speaker, s[1].speaker)
})
test("U5 snapshot order follows start time even when updates arrive interleaved", () => {
  const tr = new UtteranceTracker(() => 0)
  tr.add({ id: "2", version: 1, text: "b", device: "d2" }, 500)
  tr.add({ id: "1", version: 1, text: "a", device: "d1" }, 600)
  const s = tr.snapshot()
  assert.ok(s[0].start <= s[1].start)
})
test("U6 cleared text (version with empty text) — text stays", () => {
  const tr = new UtteranceTracker(() => 0)
  tr.add({ id: "1", version: 1, text: "hi", device: "d" }, 0)
  tr.add({ id: "1", version: 2, text: "", device: "d" }, 10)
  assert.equal(tr.snapshot()[0].text, "hi")
})
