// Transcript audit C1 / lifecycle F8: what save() exports when the caption feed and the DOM
// captions each cover part of a call. X1/X2 are the audit's tests, moved onto the shared
// content-script harness (test/helpers/content-env.cjs) so the acknowledged-save plumbing runs.
const test = require("node:test")
const assert = require("node:assert/strict")
const { createContent } = require("./helpers/content-env.cjs")

function harness() {
  let rows = []
  let feedActive = false
  let hooks
  const stream = { start() {}, stop() {}, tick() {}, handle() {}, active: () => feedActive }
  const env = createContent({
    adapter: {
      id: "google-meet",
      name: "Google Meet",
      title: () => "Weekly",
      captionsOn: () => rows.length > 0,
      captionRows: () => rows,
      enableCaptions: () => {},
      createCaptionStream: (h) => {
        hooks = h
        return stream
      },
    },
  })
  return {
    env,
    async start() {
      env.state.inCall = true
      env.advance(1000)
      await env.flush()
    },
    async tick(ms = 1000) {
      env.advance(ms)
      await env.flush()
    },
    setRows(r) { rows = r },
    feed(u) { feedActive = true; hooks.onUtterance(u, env.now) },
    name(id, n) { hooks.onName(id, n) },
    stopFeed() { feedActive = false },
    lastUpdate() { return env.ofType(env.sent, "session-update").at(-1) },
    texts() { return this.lastUpdate().utterances.map((u) => u.text) },
  }
}

test("X1 DOM lines captured before the feed starts survive in the export", async () => {
  const h = harness()
  await h.start()
  const row = {}
  h.setRows([{ key: row, speaker: "Alice", text: "Good morning, let's start with the budget." }])
  await h.tick(); await h.tick(); await h.tick(4000)
  h.setRows([])
  // Feed starts later (e.g. our request was answered late, or CC toggled) and carries Bob only.
  h.feed({ id: "1", version: 1, final: true, text: "Sounds good.", device: "spaces/s/devices/2", epoch: 1 })
  await h.tick(4000)
  const texts = h.texts()
  assert.ok(texts.some((t) => /budget/.test(t)), "DOM-only line lost: " + JSON.stringify(texts))
  assert.ok(texts.some((t) => /Sounds good/.test(t)), "feed line lost: " + JSON.stringify(texts))
})

test("X2 DOM lines captured after the feed dies survive in the export", async () => {
  const h = harness()
  await h.start()
  h.feed({ id: "1", version: 1, final: true, text: "Hello everyone.", device: "spaces/s/devices/1", epoch: 1 })
  await h.tick(4000)
  h.stopFeed() // channel replaced / request refused; DOM fallback (CC) takes over
  const row = {}
  for (let i = 0; i < 40; i++) {
    h.setRows([{ key: row, speaker: "Alice", text: "Here is the decision we made about the launch date." }])
    await h.tick(1000)
  }
  const texts = h.texts()
  assert.ok(texts.some((t) => /launch date/.test(t)), "DOM-only line lost: " + JSON.stringify(texts))
  assert.ok(texts.some((t) => /Hello everyone/.test(t)), "feed line lost: " + JSON.stringify(texts))
})

test("a line both sources captured (CC on while the feed flows) is exported once, from the feed", async () => {
  const h = harness()
  await h.start()
  h.name("spaces/s/devices/1", "Alice")
  const row = {}
  const said = ["Let us look at", "Let us look at the numbers", "Let us look at the numbers for March."]
  for (let v = 0; v < said.length; v++) {
    h.feed({ id: "5", version: v + 1, final: v === said.length - 1, text: said[v], device: "spaces/s/devices/1", epoch: 1 })
    h.setRows([{ key: row, speaker: "Alice", text: said[v].replace(".", "") }])
    await h.tick(700)
  }
  h.setRows([])
  await h.tick(4000)
  const u = h.lastUpdate().utterances
  assert.deepEqual(u.map((x) => [x.speaker, x.text]), [["Alice", "Let us look at the numbers for March."]])
})

test("feed starts late while CC is on: the overlap is not doubled and the earlier DOM line stays", async () => {
  const h = harness()
  await h.start()
  const a = {}, b = {}
  h.setRows([{ key: a, speaker: "Alice", text: "First we review the roadmap." }])
  await h.tick(1000); await h.tick(3000)
  h.setRows([{ key: a, speaker: "Alice", text: "First we review the roadmap." }, { key: b, speaker: "Bob", text: "I have two items" }])
  await h.tick(500)
  h.name("spaces/s/devices/2", "Bob")
  h.feed({ id: "1", version: 1, final: false, text: "I have two items", device: "spaces/s/devices/2", epoch: 1 })
  h.setRows([{ key: b, speaker: "Bob", text: "I have two items for today." }])
  await h.tick(800)
  h.feed({ id: "1", version: 2, final: true, text: "I have two items for today.", device: "spaces/s/devices/2", epoch: 1 })
  await h.tick(800)
  h.setRows([])
  await h.tick(4000)
  const u = h.lastUpdate().utterances
  assert.deepEqual(u.map((x) => [x.speaker, x.text]), [["Alice", "First we review the roadmap."], ["Bob", "I have two items for today."]])
})

test("feed dies mid-sentence: the DOM's fuller line replaces the feed's partial one", async () => {
  const h = harness()
  await h.start()
  h.name("spaces/s/devices/1", "Alice")
  const row = {}
  h.feed({ id: "3", version: 1, final: false, text: "Here is the decision", device: "spaces/s/devices/1", epoch: 1 })
  h.setRows([{ key: row, speaker: "Alice", text: "Here is the decision" }])
  await h.tick(1000)
  h.stopFeed()
  h.setRows([{ key: row, speaker: "Alice", text: "Here is the decision we made about the launch date." }])
  await h.tick(1000)
  h.setRows([])
  await h.tick(4000)
  const u = h.lastUpdate().utterances
  assert.deepEqual(u.map((x) => x.text), ["Here is the decision we made about the launch date."])
})

test("DOM only (no feed at all): every DOM line is exported", async () => {
  const h = harness()
  await h.start()
  h.setRows([{ key: {}, speaker: "Alice", text: "Only captions on screen." }])
  await h.tick(1000)
  h.setRows([])
  await h.tick(4000)
  assert.deepEqual(h.texts(), ["Only captions on screen."])
})

test("the overlay shows the same union as the export", async () => {
  const h = harness()
  await h.start()
  h.setRows([{ key: {}, speaker: "Alice", text: "Before the feed." }])
  await h.tick(1000)
  h.setRows([])
  await h.tick(4000)
  h.feed({ id: "1", version: 1, final: true, text: "From the feed.", device: "spaces/s/devices/2", epoch: 1 })
  await h.tick(1000)
  const last = h.env.overlays.at(-1).updates.at(-1)
  assert.deepEqual(last.lines.map((l) => l.text), ["Before the feed.", "From the feed."])
})

test("speaker names learned in one call are not carried into the next (runtime minor)", async () => {
  const h = harness()
  await h.start()
  h.name("spaces/s/devices/9", "Alice")
  h.feed({ id: "1", version: 1, final: true, text: "Call one.", device: "spaces/s/devices/9", epoch: 1 })
  await h.tick(4000)
  assert.equal(h.lastUpdate().utterances[0].speaker, "Alice")
  h.env.state.inCall = false
  await h.tick(6000)
  h.stopFeed()
  await h.tick(10000)
  h.env.state.inCall = true
  await h.tick(1000)
  h.feed({ id: "1", version: 1, final: true, text: "Call two.", device: "spaces/s/devices/9", epoch: 1 })
  await h.tick(4000)
  const u = h.lastUpdate().utterances
  assert.equal(u.length, 1)
  assert.notEqual(u[0].speaker, "Alice")
})
