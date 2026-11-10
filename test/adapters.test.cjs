// Slack and Meet adapters against a tiny fake DOM: Slack title (transcript M9), grouped-row
// speaker lookup cost (runtime I4), Meet tile names (transcript M10), cached self name (M4).
const test = require("node:test")
const assert = require("node:assert/strict")

globalThis.CallScribe = globalThis.CallScribe || {}
require("../src/shared/meet-proto.js")
require("../src/content/adapters/slack-huddle.js")
require("../src/content/adapters/google-meet.js")
const slack = globalThis.CallScribe.adapters.find((a) => a.id === "slack-huddle")
const meet = globalThis.CallScribe.adapters.find((a) => a.id === "google-meet")

let queries = 0
const steps = (sel) => sel.trim().match(/(?:[^\s[]|\[[^\]]*\])+/g)
class El {
  constructor(tag, { cls = "", attrs = {}, text = "", kids = [] } = {}) {
    Object.assign(this, { tag, cls, attrs, ownText: text, children: [], parentElement: null })
    for (const k of kids) this.append(k)
  }
  append(k) { k.parentElement = this; this.children.push(k); return k }
  get textContent() { return this.ownText + this.children.map((c) => c.textContent).join("") }
  get previousElementSibling() { const s = this.parentElement && this.parentElement.children; return s ? s[s.indexOf(this) - 1] || null : null }
  get firstElementChild() { return this.children[0] || null }
  get lastElementChild() { return this.children.at(-1) || null }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null }
  *walk() { for (const c of this.children) { yield c; yield* c.walk() } }
  // Selector support: ".class", "tag", "tag.class", '[attr="v"]', "[attr]", "button[aria-label^='x']", lists with ",".
  test(sel) {
    return sel.split(",").some((one) => {
      one = one.trim()
      if (steps(one).length > 1) return false // descendant selectors handled by querySelector below
      const m = one.match(/^([a-z]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i)
      if (!m) return false
      if (m[1] && m[1] !== this.tag) return false
      for (const c of m[2].split(".").filter(Boolean)) if (!this.cls.split(" ").includes(c)) return false
      for (const a of m[3].match(/\[[^\]]+\]/g) || []) {
        const am = a.match(/^\[([\w-]+)(?:(\^?=)["']?([^"']*)["']?)?\]$/)
        const v = this.getAttribute(am[1])
        if (v === null) return false
        if (am[2] === "=" && v !== am[3]) return false
        if (am[2] === "^=" && !v.startsWith(am[3])) return false
      }
      return true
    })
  }
  matches(sel) { return this.test(sel) }
  querySelectorAll(sel) {
    queries++
    const out = []
    for (const one of sel.split(",")) {
      const parts = steps(one)
      let set = [...this.walk()].filter((e) => e.test(parts[0]))
      for (const p of parts.slice(1)) set = set.flatMap((e) => [...e.walk()].filter((d) => d.test(p)))
      for (const e of set) if (!out.includes(e)) out.push(e)
    }
    return out
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null }
}
function useDocument(body) {
  const doc = new El("#document", { kids: [body] })
  doc.title = ""
  globalThis.document = doc
  globalThis.location = { pathname: "/abc-defg-hij" }
  return doc
}

test("M9: a Slack title 'Huddle with Alice' keeps 'Huddle with'", () => {
  const title = new El("div", { attrs: { "data-qa": "huddle_window_titlebar_title" }, text: "Huddle with Alice" })
  useDocument(new El("body", { kids: [title] }))
  assert.equal(slack.title(), "Huddle with Alice")
  title.ownText = "Huddle in #general"
  assert.equal(slack.title(), "#general")
})

function slackGroup(n) {
  const list = new El("div", { cls: "p-huddle_closed_captions" })
  for (let i = 0; i < n; i++) {
    const row = new El("div", { cls: "p-huddle_closed_caption_event__wrapper" })
    if (i === 0) row.append(new El("span", { cls: "p-huddle_closed_caption_event__member_name", text: "Alice" }))
    row.append(new El("div", { cls: "p-huddle_closed_caption_event__event_text", text: `line ${i}` }))
    list.append(row)
  }
  useDocument(new El("body", { kids: [list] }))
}

test("runtime I4: grouped Slack rows find their speaker in linear, not quadratic, work", () => {
  const cost = (n) => {
    slackGroup(n)
    queries = 0
    const rows = slack.captionRows()
    assert.equal(rows.length, n)
    assert.ok(rows.every((r) => r.speaker === "Alice"))
    return queries
  }
  const small = cost(50)
  const big = cost(400)
  // 8x the rows may cost about 8x the queries; quadratic would be ~64x.
  assert.ok(big <= small * 12, `queries: 50 rows ${small}, 400 rows ${big}`)
})

test("runtime I4: grouped rows after a second speaker label take that speaker", () => {
  const list = new El("div", { cls: "p-huddle_closed_captions" })
  const row = (name, t) => {
    const r = new El("div", { cls: "p-huddle_closed_caption_event__wrapper" })
    if (name) r.append(new El("span", { cls: "p-huddle_closed_caption_event__member_name", text: name }))
    r.append(new El("div", { cls: "p-huddle_closed_caption_event__event_text", text: t }))
    return list.append(r)
  }
  row("Alice", "a1"); row("", "a2"); row("Bob", "b1"); row("", "b2"); row("", "b3")
  useDocument(new El("body", { kids: [list] }))
  assert.deepEqual(slack.captionRows().map((r) => `${r.speaker}:${r.text}`), ["Alice:a1", "Alice:a2", "Bob:b1", "Bob:b2", "Bob:b3"])
})

const tile = (id, name) => new El("div", { attrs: { "data-participant-id": id }, kids: [new El("span", { cls: "notranslate", text: name })] })

test("M10: a camera tile and a presentation tile for one person give one stable name", () => {
  const body = new El("body", { kids: [tile("spaces/s/devices/1", "Alice (Presentation)"), tile("spaces/s/devices/1", "Alice"), tile("spaces/s/devices/2", "Bob")] })
  useDocument(body)
  const want = new Map([["spaces/s/devices/1", "Alice"], ["spaces/s/devices/2", "Bob"]])
  assert.deepEqual(new Map(meet.participantNames()), want)
  assert.equal(meet.participantNames().length, 2)
  body.children.reverse()
  assert.deepEqual(new Map(meet.participantNames()), want)
})

test("M10: a presentation tile alone still names its device, without the suffix", () => {
  useDocument(new El("body", { kids: [tile("spaces/s/devices/3", "Carol (Presentation)")] }))
  assert.deepEqual(meet.participantNames(), [["spaces/s/devices/3", "Carol"]])
})

function meetCaptions(withSelfButton) {
  const region = new El("div", { attrs: { role: "region", "aria-label": "Captions" } })
  const r = region.append(new El("div"))
  r.append(new El("div", { kids: [new El("span", { text: "You" })] }))
  r.append(new El("div", { text: "Let me share my screen" }))
  const kids = [region]
  if (withSelfButton) kids.push(new El("button", { attrs: { "aria-label": "More options for An Nguyen" } }))
  useDocument(new El("body", { kids }))
}

test("M4: Meet keeps mapping 'You' to your name after the tile button that told it disappears", () => {
  meetCaptions(true)
  assert.equal(meet.captionRows()[0].speaker, "An Nguyen")
  meetCaptions(false)
  assert.equal(meet.captionRows()[0].speaker, "An Nguyen")
})

test("Task 3 review I3: a tile name with a pronoun or org suffix is kept as written", () => {
  useDocument(new El("body", { kids: [tile("spaces/s/devices/4", "Alice (she/her)"), tile("spaces/s/devices/5", "Bob (Acme)")] }))
  assert.deepEqual(new Map(meet.participantNames()), new Map([["spaces/s/devices/4", "Alice (she/her)"], ["spaces/s/devices/5", "Bob (Acme)"]]))
})

test("Task 3 review I3: camera tile 'Bob (Acme)' and presentation tile 'Bob (Acme) (Presentation)' give 'Bob (Acme)' in either order", () => {
  const body = new El("body", { kids: [tile("spaces/s/devices/6", "Bob (Acme) (Presentation)"), tile("spaces/s/devices/6", "Bob (Acme)")] })
  useDocument(body)
  assert.deepEqual(meet.participantNames(), [["spaces/s/devices/6", "Bob (Acme)"]])
  body.children.reverse()
  assert.deepEqual(meet.participantNames(), [["spaces/s/devices/6", "Bob (Acme)"]])
})

// Meet's 2026-11 call bar: CC lives in a "Captions and translation" tray (seen live 2026-11-10).
test("Meet: enableCaptions opens the Captions and translation tray and presses Turn on captions", async () => {
  const pressed = []
  const body = new El("body")
  const turnOn = new El("button", { attrs: { "aria-label": "Turn on captions" }, text: "closed_caption_offTurn on captions" })
  turnOn.click = () => pressed.push("turn on")
  const tray = new El("button", { attrs: { "aria-label": "Captions and translation" }, text: "translate_cc" })
  // Like live Meet: the tray's buttons show up about 2 s after it opens.
  tray.click = () => { pressed.push("tray"); setTimeout(() => body.append(turnOn), 2000) }
  body.append(tray)
  useDocument(body)
  meet.enableCaptions()
  await new Promise((r) => setTimeout(r, 2800))
  assert.deepEqual(pressed, ["tray", "turn on"])
})

test("Meet: enableCaptions presses a visible Turn on captions button directly (older call bar)", async () => {
  const pressed = []
  const turnOn = new El("button", { attrs: { "aria-label": "Turn on captions (c)" } })
  turnOn.click = () => pressed.push("turn on")
  useDocument(new El("body", { kids: [turnOn] }))
  meet.enableCaptions()
  await new Promise((r) => setTimeout(r, 600))
  assert.deepEqual(pressed, ["turn on"])
})
