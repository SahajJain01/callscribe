// Task 3 review (fix round 1): the feed + page union never loses real speech (I1), compares
// lines in order, by character pairs in scripts without spaces (I2), and treats "Bob (Acme)"
// and "Bob" as one speaker (I3). When unsure, both lines are kept.
const test = require("node:test")
const assert = require("node:assert/strict")
const { mergeSources } = require("../src/shared/merge.js")

const lines = (out) => out.map((e) => `${e.speaker}:${e.text}`)
const W = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(" ")
const row = { speaker: "Alice", text: W.join(" "), start: 0, end: 12000 }
// Every word of the page row is in the export, in order.
function keepsEveryWord(out) {
  const words = out.map((e) => e.text).join(" ").toLowerCase().split(/\W+/).filter(Boolean)
  let i = 0
  for (const w of words) if (w === W[i]) i++
  assert.equal(i, W.length, `lost words from "${W[i]}" on: ${JSON.stringify(lines(out))}`)
}

// I1: the feed starts late inside a CC row (it holds the row's tail) or dies mid-row (it holds the head).
for (const [name, from, to] of [
  ["feed starts late, holds the last 65% (review probe: words 1-7 lost)", 7, 20],
  ["feed starts late, holds the last 85%", 3, 20],
  ["feed dies after word 14, 70% (review probe: words 15-20 lost)", 0, 14],
  ["feed dies after word 13, 65%", 0, 13],
  ["feed dies after word 17, 85%", 0, 17],
]) {
  test(`I1: ${name}: every word of the page row is kept`, () => {
    const feed = [{ speaker: "Alice", text: W.slice(from, to).join(" "), start: from * 600, end: to * 600 }]
    const out = mergeSources(feed, [row])
    keepsEveryWord(out)
  })
}

test("I1: a feed line fully inside the page row is not exported twice", () => {
  const feed = [{ speaker: "Alice", text: W.slice(7).join(" ") + ".", start: 4000, end: 12000 }]
  assert.deepEqual(lines(mergeSources(feed, [row])), [`Alice:${row.text}`])
})

test("I1: feed died and two feed lines cover the head of the row: the row is kept once", () => {
  const feed = [
    { speaker: "Alice", text: W.slice(0, 6).join(" "), start: 0, end: 3600 },
    { speaker: "Alice", text: W.slice(6, 12).join(" "), start: 3600, end: 7200 },
  ]
  assert.deepEqual(lines(mergeSources(feed, [row])), [`Alice:${row.text}`])
})

// I2: different speech by the same speaker within 3 s survives.
test("I2: Chinese '我们明天开会' is not dropped by a feed line '我们今天开会了吗'", () => {
  const out = mergeSources([{ speaker: "Li", text: "我们今天开会了吗", start: 0, end: 2000 }], [{ speaker: "Li", text: "我们明天开会", start: 3500, end: 4500 }])
  assert.deepEqual(lines(out), ["Li:我们今天开会了吗", "Li:我们明天开会"])
})

test("I2: Thai 'พรุ่งนี้เราจะไม่ประชุม' is not dropped by 'วันนี้เราจะประชุมกัน'", () => {
  const out = mergeSources([{ speaker: "A", text: "วันนี้เราจะประชุมกัน", start: 0, end: 2000 }], [{ speaker: "A", text: "พรุ่งนี้เราจะไม่ประชุม", start: 4000, end: 5000 }])
  assert.deepEqual(lines(out), ["A:วันนี้เราจะประชุมกัน", "A:พรุ่งนี้เราจะไม่ประชุม"])
})

test("I2: Japanese 'これは問題ではないですね' is not dropped by 'それは問題ですね。'", () => {
  const out = mergeSources([{ speaker: "Ken", text: "それは問題ですね。", start: 0, end: 2000 }], [{ speaker: "Ken", text: "これは問題ではないですね", start: 4000, end: 5000 }])
  assert.deepEqual(lines(out), ["Ken:それは問題ですね。", "Ken:これは問題ではないですね"])
})

test("I2: English negation 'we can't ship it' is not dropped by 'we can ship it on Friday'", () => {
  const out = mergeSources([{ speaker: "A", text: "we can ship it on Friday", start: 0, end: 2000 }], [{ speaker: "A", text: "we can't ship it", start: 4000, end: 5000 }])
  assert.deepEqual(lines(out), ["A:we can ship it on Friday", "A:we can't ship it"])
})

test("I2: words the feed holds in another order are not the same speech", () => {
  const out = mergeSources([{ speaker: "A", text: "the budget is fine but the plan is late", start: 0, end: 3000 }], [{ speaker: "A", text: "the plan is fine but the budget is late", start: 500, end: 3500 }])
  assert.equal(out.length, 2)
})

test("I2: a page 'No.' is not dropped because a long feed line says 'no' somewhere", () => {
  const out = mergeSources([{ speaker: "A", text: "I said no to the proposal and no to the budget", start: 0, end: 6000 }], [{ speaker: "A", text: "No.", start: 7000, end: 7500 }])
  assert.equal(out.length, 2)
})

// True duplicates still collapse.
test("duplicates: Thai with and without a space, Korean without the full stop, split feed lines", () => {
  assert.deepEqual(lines(mergeSources([{ speaker: "A", text: "สวัสดีครับทุกคน", start: 1000, end: 2000 }], [{ speaker: "A", text: "สวัสดีครับ ทุกคน", start: 1000, end: 2000 }])), ["A:สวัสดีครับทุกคน"])
  assert.deepEqual(lines(mergeSources([{ speaker: "A", text: "오늘 회의는 짧게 하겠습니다.", start: 0, end: 2000 }], [{ speaker: "A", text: "오늘 회의는 짧게 하겠습니다", start: 0, end: 2000 }])), ["A:오늘 회의는 짧게 하겠습니다."])
  const feed = [
    { speaker: "Bob", text: "We should ship on Friday.", start: 0, end: 2000 },
    { speaker: "Bob", text: "QA signed off yesterday.", start: 2000, end: 4000 },
  ]
  assert.deepEqual(lines(mergeSources(feed, [{ speaker: "Bob", text: "We should ship on Friday QA signed off yesterday", start: 0, end: 4000 }])), ["Bob:We should ship on Friday.", "Bob:QA signed off yesterday."])
  assert.deepEqual(lines(mergeSources([{ speaker: "Li", text: "我们明天开会讨论一下预算。", start: 0, end: 3000 }], [{ speaker: "Li", text: "我们明天开会讨论一下预算", start: 200, end: 3100 }])), ["Li:我们明天开会讨论一下预算。"])
})

// I3: a trailing "(…)" on one side only is the same speaker; the fuller name is shown.
test("I3: 'Bob' (feed) and 'Bob (Acme)' (page) saying the same thing export once, as 'Bob (Acme)'", () => {
  const out = mergeSources([{ speaker: "Bob", text: "We ship on Friday.", start: 1000, end: 2000 }], [{ speaker: "Bob (Acme)", text: "We ship on Friday", start: 1000, end: 2000 }])
  assert.deepEqual(lines(out), ["Bob (Acme):We ship on Friday."])
})

test("I3: 'Alice (she/her)' in the feed and 'Alice' on the page export once, as 'Alice (she/her)'", () => {
  const out = mergeSources([{ speaker: "Alice (she/her)", text: "Let me share my screen.", start: 1000, end: 2000 }], [{ speaker: "Alice", text: "Let me share my screen", start: 1200, end: 2100 }])
  assert.deepEqual(lines(out), ["Alice (she/her):Let me share my screen."])
})

test("I3: different people with the same first word are still different speakers", () => {
  const out = mergeSources([{ speaker: "Bob (Acme)", text: "We ship on Friday.", start: 1000, end: 2000 }], [{ speaker: "Bob (Globex)", text: "We ship on Friday", start: 1000, end: 2000 }])
  assert.equal(out.length, 2)
})

test("minor: an unnamed feed line takes the name the page knows", () => {
  const out = mergeSources([{ speaker: "Unknown speaker 1", text: "Thanks everyone", start: 1000, end: 2000 }], [{ speaker: "Bob", text: "Thanks everyone", start: 1500, end: 2500 }])
  assert.deepEqual(lines(out), ["Bob:Thanks everyone"])
})

test("mergeSources does not change its inputs", () => {
  const feed = [{ speaker: "Bob", text: "We ship on Friday.", start: 1000, end: 2000 }]
  const dom = [{ speaker: "Bob (Acme)", text: "We ship on Friday", start: 1000, end: 2000 }]
  const before = JSON.stringify([feed, dom])
  mergeSources(feed, dom)
  assert.equal(JSON.stringify([feed, dom]), before)
})
