// src/content/main.js with a fake adapter, chrome.* and page channel: recorder ownership across
// settings changes and calls, the mic gate, the orphaned-after-update path and input checks
// on what the MAIN world sends.
const test = require("node:test")
const assert = require("node:assert/strict")
const { createContent } = require("./helpers/content-env.cjs")

const ORPHAN_TEXT = "CallScribe was updated. Reload this tab to keep recording"

async function joined(opts) {
  const c = createContent(opts)
  await c.flush()
  c.state.inCall = true
  c.advance(1000)
  await c.flush()
  const start = c.ofType(c.sent, "session-start")[0]
  return { c, id: start && start.session.id }
}
async function leave(c) {
  c.state.inCall = false
  c.advance(6000)
  await c.flush()
}

test("recordAudio off mid-call pauses this session's recorder; leaving still stops it by id (lifecycle F1 / runtime C1)", async () => {
  const { c, id } = await joined()
  assert.deepEqual(c.ofType(c.toPage, "start").map((m) => m.id), [id])
  await c.setSettings({ recordAudio: false })
  assert.deepEqual(c.ofType(c.toPage, "pause").map((m) => m.id), [id], "recorder not paused when audio was turned off")
  await leave(c)
  assert.deepEqual(c.ofType(c.toPage, "stop").map((m) => m.id), [id], "recorder not stopped at hang-up")
})

test("audio back on mid-call resumes the same recorder; never a second one for the session", async () => {
  const { c, id } = await joined()
  await c.setSettings({ recordAudio: false })
  await c.setSettings({ recordAudio: true })
  assert.deepEqual(c.ofType(c.toPage, "resume").map((m) => m.id), [id])
  assert.equal(c.ofType(c.toPage, "start").length, 1)
})

test("audio off at join, turned on mid-call: the recorder starts for the current session", async () => {
  const { c, id } = await joined({ settings: { recordAudio: false } })
  assert.equal(c.ofType(c.toPage, "start").length, 0)
  await c.setSettings({ recordAudio: true })
  assert.deepEqual(c.ofType(c.toPage, "start").map((m) => m.id), [id])
  await leave(c)
  assert.deepEqual(c.ofType(c.toPage, "stop").map((m) => m.id), [id])
})

test("on -> off -> hang up -> on -> next call: the next call gets its own recorder start", async () => {
  const { c, id } = await joined()
  await c.setSettings({ recordAudio: false })
  await leave(c)
  await c.setSettings({ recordAudio: true })
  c.state.inCall = true
  c.advance(1000)
  await c.flush()
  const starts = c.ofType(c.toPage, "start").map((m) => m.id)
  assert.equal(starts.length, 2)
  assert.notEqual(starts[1], id)
  assert.equal(c.ofType(c.sent, "session-start").at(-1).session.id, starts[1])
})

test("audio still off at the next call: no recorder, and the old one was stopped", async () => {
  const { c, id } = await joined()
  await c.setSettings({ recordAudio: false })
  await leave(c)
  c.state.inCall = true
  c.advance(1000)
  await c.flush()
  assert.equal(c.ofType(c.toPage, "start").length, 1)
  assert.deepEqual(c.ofType(c.toPage, "stop").map((m) => m.id), [id])
})

test("includeMic changes mid-call reconfigure the recorder and the overlay follows the recorder", async () => {
  const { c, id } = await joined()
  await c.setSettings({ includeMic: false })
  assert.deepEqual(c.ofType(c.toPage, "config").map((m) => [m.id, m.includeMic]), [[id, false]])
  c.advance(1000)
  assert.equal(c.overlays[0].updates.at(-1).micRecorded, false)
  await c.setSettings({ includeMic: true })
  assert.deepEqual(c.ofType(c.toPage, "config").map((m) => [m.id, m.includeMic]), [[id, false], [id, true]])
})

test("late chunks of an ended session are still saved; chunks for other ids are dropped", async () => {
  const { c, id } = await joined()
  c.fromPage({ type: "started", id })
  await leave(c)
  const buf = new Uint8Array([1, 2]).buffer
  c.fromPage({ type: "chunk", id, seq: 0, mime: "audio/webm", buf })
  c.fromPage({ type: "chunk", id: "slack-huddle-made-up", seq: 0, mime: "audio/webm", buf })
  const chunks = c.ofType(c.sent, "audio-chunk")
  assert.deepEqual(chunks.map((m) => m.id), [id])
})

test("chunk checks: ArrayBuffer only, size cap, strictly increasing seq (security I1/M6)", async () => {
  const { c, id } = await joined()
  c.fromPage({ type: "chunk", id, seq: 0, mime: "audio/webm", buf: 2e9 })
  c.fromPage({ type: "chunk", id, seq: 0, mime: "audio/webm", buf: { byteLength: 4 } })
  c.fromPage({ type: "chunk", id, seq: 0, mime: "audio/webm", buf: new ArrayBuffer(64 * 1024 * 1024) })
  c.fromPage({ type: "chunk", id, seq: 0, mime: "audio/webm", buf: new Uint8Array([1]).buffer })
  c.fromPage({ type: "chunk", id, seq: 0, mime: "audio/webm", buf: new Uint8Array([2]).buffer })
  c.fromPage({ type: "chunk", id, seq: 1, mime: "text/html", buf: new Uint8Array([3]).buffer })
  c.fromPage({ type: "chunk", id, seq: 2, mime: "audio/webm", buf: new Uint8Array([4]).buffer })
  assert.deepEqual(c.ofType(c.sent, "audio-chunk").map((m) => m.seq), [0, 2])
})

test("window messages are not listened to at all (security I1)", async () => {
  const { c, id } = await joined()
  const ev = new Event("message")
  Object.defineProperty(ev, "data", { value: { __callscribe: "page", type: "chunk", id, seq: 0, mime: "audio/webm", buf: new ArrayBuffer(4) } })
  Object.defineProperty(ev, "source", { value: c.win })
  c.win.dispatchEvent(ev)
  await c.flush()
  assert.equal(c.ofType(c.sent, "audio-chunk").length, 0)
})

test("mic gate: unknown mute state never opens the mic (security I3)", async () => {
  const { c } = await joined({ muted: undefined })
  c.advance(5000)
  assert.equal(c.ofType(c.toPage, "mic").filter((m) => m.on).length, 0)
})

test("mic gate: opens only on an explicit unmuted reading, closes when muted", async () => {
  const { c } = await joined({ muted: false })
  assert.deepEqual(c.ofType(c.toPage, "mic").map((m) => m.on), [true])
  c.state.muted = true
  c.advance(1000)
  assert.deepEqual(c.ofType(c.toPage, "mic").map((m) => m.on), [true, false])
  c.state.muted = undefined
  c.state.mutedThrows = true
  c.advance(1000)
  assert.deepEqual(c.ofType(c.toPage, "mic").map((m) => m.on), [true, false])
})

test("mic gate: going from unmuted to unknown closes the mic", async () => {
  const { c } = await joined({ muted: false })
  c.state.muted = undefined
  c.advance(1000)
  assert.deepEqual(c.ofType(c.toPage, "mic").map((m) => m.on), [true, false])
})

test("mic gate closes at once on a click on the mic toggle, not on the next heartbeat", async () => {
  const { c } = await joined({ muted: false })
  for (const type of ["pointerdown", "keydown"]) {
    c.toPage.length = 0
    c.state.muted = false
    c.advance(1000) // heartbeat sees unmuted again
    c.toPage.length = 0
    const ev = new Event(type, { bubbles: true })
    Object.defineProperty(ev, "target", { value: c.micEl })
    c.doc.dispatchEvent(ev)
    assert.deepEqual(c.ofType(c.toPage, "mic").map((m) => m.on), [false], type + " on the mic toggle did not close the gate synchronously")
  }
})

test("mic gate re-reads the mute state as soon as the toggle's attributes change", async () => {
  const { c } = await joined({ muted: false })
  c.toPage.length = 0
  c.state.muted = true
  const mo = c.observers.find((o) => o.connected && o.targets.some((t) => t.o && t.o.attributes))
  assert.ok(mo, "no attribute observer for the mute state")
  mo.fire([{ type: "attributes" }])
  assert.deepEqual(c.ofType(c.toPage, "mic").map((m) => m.on), [false])
})

test("orphaned after an extension update: recorder and keepalive stop, warning pill, nothing throws (runtime I1 / lifecycle F7)", async () => {
  const { c, id } = await joined()
  c.fromPage({ type: "started", id })
  c.runtime.id = undefined
  c.runtime.throwSync = true
  c.advance(1000)
  await c.flush()
  assert.deepEqual(c.ofType(c.toPage, "stop").map((m) => m.id), [id])
  const ka = c.ofType(c.toPage, "render-keepalive")
  assert.equal(ka.at(-1).on, false)
  const ov = c.overlays.at(-1)
  assert.ok(ov && !ov.removed, "overlay removed instead of showing the warning")
  assert.equal(ov.updates.at(-1).orphan, ORPHAN_TEXT)
  // later ticks: no more work, no throws
  const before = c.toPage.length
  c.advance(5000)
  assert.ok(c.ofType(c.toPage.slice(before), "start").length === 0)
  // leaving the call removes the warning
  c.state.inCall = false
  c.advance(2000)
  assert.ok(c.overlays.at(-1).removed)
})

test("a synchronous throw from runtime.sendMessage is treated as orphaned (runtime I1)", async () => {
  const { c, id } = await joined()
  c.runtime.throwSync = true // chrome.runtime.id still set
  assert.doesNotThrow(() => c.advance(16000)) // the next periodic save calls sendMessage
  await c.flush()
  assert.deepEqual(c.ofType(c.toPage, "stop").map((m) => m.id), [id])
  assert.equal(c.overlays.at(-1).updates.at(-1).orphan, ORPHAN_TEXT)
})

test("orphaned with no call running: joining a call later shows the warning instead of recording", async () => {
  const c = createContent()
  await c.flush()
  c.runtime.id = undefined
  c.advance(1000)
  c.state.inCall = true
  c.advance(2000)
  assert.equal(c.ofType(c.toPage, "start").length, 0)
  assert.equal(c.overlays.at(-1).updates.at(-1).orphan, ORPHAN_TEXT)
})

test("session creation is rate-limited per tab (security M6)", async () => {
  const c = createContent()
  await c.flush()
  for (let i = 0; i < 20; i++) {
    c.state.inCall = true
    c.advance(1000)
    c.state.inCall = false
    c.advance(6000)
  }
  await c.flush()
  const n = c.ofType(c.sent, "session-start").length
  assert.ok(n >= 1 && n <= 6, `${n} sessions created by a flapping call UI in ${20 * 7} s`)
})

// ---- durable saves: every write is acknowledged, failures are retried (lifecycle F5, F10)
const chunkMsg = (id, seq) => ({ type: "chunk", id, seq, mime: "audio/webm;codecs=opus", buf: new Uint8Array([1, 2, 3]).buffer })

test("a failed chunk write is retried until the service worker acknowledges it (F10)", async () => {
  let fails = 2
  const { c, id } = await joined({ reply: (m) => (m.type === "audio-chunk" && fails-- > 0 ? { error: "QuotaExceededError" } : { ok: true }) })
  c.fromPage({ type: "started", id })
  c.fromPage(chunkMsg(id, 0))
  for (let i = 0; i < 10; i++) { await c.flush(); c.advance(1000) }
  await c.flush()
  assert.deepEqual(c.ofType(c.sent, "audio-chunk").map((m) => m.seq), [0, 0, 0])
  assert.notEqual(c.overlays.at(-1).updates.at(-1).audio, "save-failed")
})

test("a rejected send (worker restarting) is retried too", async () => {
  let fails = 1
  const { c, id } = await joined({ reply: (m) => { if (m.type === "audio-chunk" && fails-- > 0) throw new Error("Could not establish connection"); return { ok: true } } })
  c.fromPage(chunkMsg(id, 0))
  for (let i = 0; i < 5; i++) { await c.flush(); c.advance(1000) }
  assert.equal(c.ofType(c.sent, "audio-chunk").length, 2)
})

test("a chunk that keeps failing shows Audio 'save failed' in the overlay (F10)", async () => {
  const { c, id } = await joined({ reply: (m) => (m.type === "audio-chunk" ? { error: "QuotaExceededError" } : { ok: true }) })
  c.fromPage({ type: "started", id })
  c.fromPage(chunkMsg(id, 0))
  for (let i = 0; i < 40; i++) { await c.flush(); c.advance(1000) }
  await c.flush()
  c.advance(1000)
  assert.equal(c.overlays.at(-1).updates.at(-1).audio, "save-failed")
  const n = c.ofType(c.sent, "audio-chunk").length
  assert.ok(n > 2 && n < 12, `bounded retries (${n})`)
})

test("a refusal the worker marks fatal (deleted or unknown session) is not retried", async () => {
  const { c, id } = await joined({ reply: (m) => (m.type === "audio-chunk" ? { error: "no such session", fatal: true } : { ok: true }) })
  c.fromPage({ type: "started", id })
  c.fromPage(chunkMsg(id, 0))
  for (let i = 0; i < 20; i++) { await c.flush(); c.advance(1000) }
  assert.equal(c.ofType(c.sent, "audio-chunk").length, 1)
  assert.equal(c.overlays.at(-1).updates.at(-1).audio, "save-failed")
})

test("session-end waits until the last chunk is stored (F5)", async () => {
  let release
  const held = new Promise((r) => (release = r))
  const { c, id } = await joined({ reply: (m) => (m.type === "audio-chunk" ? held : { ok: true }) })
  c.fromPage({ type: "started", id })
  c.state.inCall = false
  c.advance(6000)
  await c.flush()
  c.fromPage(chunkMsg(id, 0)) // the final chunk, then 'stopped'
  c.fromPage({ type: "stopped", id })
  await c.flush()
  c.advance(2000)
  await c.flush()
  assert.equal(c.ofType(c.sent, "session-end").length, 0, "session-end sent while the last chunk was still being stored")
  release({ ok: true })
  await c.flush()
  assert.equal(c.ofType(c.sent, "session-end").length, 1)
})

test("a failed caption save is retried, not left until the next 15 s resend (F10)", async () => {
  let fails = 1
  const { c } = await joined({ reply: (m) => (m.type === "session-update" && fails-- > 0 ? { error: "boom" } : { ok: true }) })
  assert.equal(c.ofType(c.sent, "session-update").length, 1, "the first save (at join) fails")
  for (let i = 0; i < 4; i++) { c.advance(1000); await c.flush() }
  assert.ok(c.ofType(c.sent, "session-update").length >= 2, "no retry within 4 s")
})

test("caption saves carry an increasing revision, so a late retry can't overwrite newer text", async () => {
  const { c } = await joined()
  for (let i = 0; i < 40; i++) { c.advance(1000); await c.flush() }
  const revs = c.ofType(c.sent, "session-update").map((m) => m.rev)
  assert.ok(revs.length >= 2 && revs.every((r, i) => Number.isInteger(r) && (i === 0 || r > revs[i - 1])), JSON.stringify(revs))
})

test("a failed session-start is retried before anything else for that session is sent", async () => {
  let fails = 1
  const c = createContent({ reply: (m) => (m.type === "session-start" && fails-- > 0 ? { error: "boom" } : { ok: true }) })
  await c.flush()
  c.state.inCall = true
  c.advance(1000)
  await c.flush()
  const id = c.ofType(c.sent, "session-start")[0].session.id
  c.fromPage(chunkMsg(id, 0))
  assert.equal(c.ofType(c.sent, "audio-chunk").length, 0, "chunk sent before the session was stored")
  for (let i = 0; i < 4; i++) { c.advance(1000); await c.flush() }
  assert.equal(c.ofType(c.sent, "session-start").length, 2)
  assert.equal(c.ofType(c.sent, "audio-chunk").length, 1)
})

test("session-end carries when the call was last seen, not when the end was noticed (M1)", async () => {
  const { c } = await joined({ settings: { recordAudio: false } })
  c.advance(10000)
  const lastSeen = c.now
  c.state.inCall = false
  c.advance(6000)
  await c.flush()
  const end = c.ofType(c.sent, "session-end")[0]
  assert.ok(end, "no session-end")
  assert.equal(end.at, lastSeen)
})

// --- runtime "Body observer and heartbeat duplication" and I3 (overlay refresh cost)

// A Meet-like caption feed the test drives: state.feed says whether it is healthy.
function feedAdapter(extra = {}) {
  const hooks = {}
  const reads = { n: 0 }
  return {
    hooks,
    reads,
    adapter: {
      captionContainer: ".captions",
      captionRows: () => { reads.n++; return hooks.rows ? hooks.rows() : [] },
      createCaptionStream(cb) {
        Object.assign(hooks, cb)
        return { active: () => Boolean(hooks.state && hooks.state.feed), start() {}, stop() {}, tick() {}, handle() {} }
      },
      ...extra,
    },
  }
}
const childObservers = (c) => c.observers.filter((o) => o.connected && o.targets.some((t) => t.o && (t.o.childList || t.o.characterData)))

test("the caption observer watches the caption container once it is on the page, never all of document.body", async () => {
  const f = feedAdapter()
  const { c } = await joined({ adapter: f.adapter })
  f.hooks.state = c.state
  assert.deepEqual(childObservers(c).filter((o) => o.targets.some((t) => t.target === c.doc.body)), [], "observing document.body")
  const container = { nodeName: "DIV", isConnected: true }
  c.state.container = container
  c.advance(1000)
  const obs = childObservers(c)
  assert.equal(obs.length, 1)
  assert.equal(obs[0].targets.at(-1).target, container)
  // A mutation in it schedules a read.
  c.state.feed = true // feed healthy: only the observer reads
  c.advance(1000)
  const before = f.reads.n
  obs[0].fire()
  c.advance(300)
  assert.equal(f.reads.n, before + 1)
  // The container is replaced: the observer moves to the new one.
  const next = { nodeName: "DIV", isConnected: true }
  container.isConnected = false
  c.state.container = next
  c.advance(1000)
  assert.deepEqual(childObservers(c).map((o) => o.targets.at(-1).target), [next])
})

test("while the caption feed is healthy the heartbeat doesn't poll page captions; it does when the feed is down", async () => {
  const f = feedAdapter()
  const { c } = await joined({ adapter: f.adapter })
  f.hooks.state = c.state
  c.state.feed = true
  c.advance(1000)
  let n = f.reads.n
  c.advance(5000)
  assert.equal(f.reads.n, n, "page captions polled while the feed is healthy")
  c.state.feed = false
  n = f.reads.n
  c.advance(5000)
  assert.ok(f.reads.n - n >= 4, `fallback polling stopped (${f.reads.n - n} reads in 5 s)`)
})

test("a quiet heartbeat refreshes the overlay once, reusing the merged lines", async () => {
  const f = feedAdapter()
  const { c } = await joined({ adapter: f.adapter })
  f.hooks.state = c.state
  c.state.feed = true
  f.hooks.onUtterance({ id: 1, version: 1, text: "hello there", device: "d1", final: true })
  c.advance(2000)
  const ov = c.overlays.at(-1)
  const n = ov.updates.length
  c.advance(3000)
  assert.equal(ov.updates.length - n, 3, `${ov.updates.length - n} overlay refreshes in 3 quiet seconds`)
  const ls = ov.updates.slice(n).map((u) => u.lines)
  assert.ok(ls.every((l) => l === ls[0]), "lines re-merged although nothing changed")
  assert.equal(ls[0].length, 1)
})

test("merged overlay lines follow every change: new text, finality, names, page rows", async () => {
  const f = feedAdapter()
  const { c } = await joined({ adapter: f.adapter })
  f.hooks.state = c.state
  c.state.feed = true
  const last = () => c.overlays.at(-1).updates.at(-1).lines
  f.hooks.onUtterance({ id: 1, version: 1, text: "hello", device: "d1", final: false })
  c.advance(1000)
  assert.deepEqual(last().map((l) => [l.text, l.live]), [["hello", true]])
  f.hooks.onUtterance({ id: 1, version: 2, text: "hello", device: "d1", final: true })
  c.advance(1000)
  assert.deepEqual(last().map((l) => [l.text, l.live]), [["hello", false]], "finality change not shown")
  f.hooks.onName("d1", "Priya")
  c.advance(1000)
  assert.equal(last()[0].speaker, "Priya", "late name not shown")
  // CC on: a page row the feed doesn't hold joins the transcript, then turns final when it goes.
  const container = { nodeName: "DIV", isConnected: true }
  c.state.container = container
  c.advance(1000)
  const row = { key: {}, speaker: "Sam", text: "a completely different page caption here" }
  f.hooks.rows = () => [row]
  childObservers(c)[0].fire()
  c.advance(1000)
  assert.deepEqual(last().map((l) => [l.text, l.live]), [["hello", false], [row.text, true]])
  f.hooks.rows = () => []
  childObservers(c)[0].fire()
  c.advance(1000)
  assert.deepEqual(last().map((l) => [l.text, l.live]), [["hello", false], [row.text, false]], "page row stayed live")
})

// ---- final review M-A: a final refusal for the whole session ends it quietly in the tab
const GONE = { error: "session deleted", fatal: true, closed: "deleted" }

test("the worker says the live call is gone (deleted in the popup): no more saves or audio, no 'save failed' (final review M-A)", async () => {
  let deleted = false
  let refused = 0
  const { c, id } = await joined({ reply: (m) => (deleted && m.id === id ? (m.type === "session-update" && refused++, GONE) : { ok: true }) })
  c.fromPage({ type: "started", id })
  c.advance(1000)
  await c.flush()
  deleted = true
  for (let i = 0; i < 20 && !refused; i++) { c.advance(1000); await c.flush() } // the next periodic save gets the refusal
  assert.equal(refused, 1, "control: a transcript save was refused")
  const updates = c.ofType(c.sent, "session-update").length
  for (let i = 0; i < 30; i++) { c.advance(1000); await c.flush() }
  assert.equal(c.ofType(c.sent, "session-update").length - updates, 0, "the transcript is still being resent")
  assert.deepEqual(c.ofType(c.toPage, "stop").map((m) => m.id), [id], "the recorder was not stopped")
  const chunks = c.ofType(c.sent, "audio-chunk").length
  c.fromPage(chunkMsg(id, 0))
  await c.flush()
  assert.equal(c.ofType(c.sent, "audio-chunk").length, chunks, "audio is still sent for the deleted call")
  assert.equal(c.ofType(c.sent, "session-end").length, 0)
  const ov = c.overlays.at(-1)
  assert.ok(ov.removed, "the overlay still shows the deleted call")
  assert.ok(!ov.updates.some((u) => u.audio === "save-failed" || u.transcript === "save-failed"), "'save failed' shown for a call the user deleted")
  // Still on the same call: it isn't recorded again behind the user's back.
  assert.equal(c.ofType(c.sent, "session-start").length, 1, "the deleted call was started again")
  // The next call is recorded as usual.
  await leave(c)
  c.state.inCall = true
  c.advance(1000)
  await c.flush()
  assert.equal(c.ofType(c.sent, "session-start").length, 2, "the next call wasn't recorded")
})

test("a final refusal of one audio chunk for a deleted call ends the session too (M-A)", async () => {
  const { c, id } = await joined({ reply: (m) => (m.type === "audio-chunk" ? GONE : { ok: true }) })
  c.fromPage({ type: "started", id })
  c.fromPage(chunkMsg(id, 0))
  await c.flush()
  const updates = c.ofType(c.sent, "session-update").length
  for (let i = 0; i < 20; i++) { c.advance(1000); await c.flush() }
  assert.equal(c.ofType(c.sent, "session-update").length, updates)
  assert.deepEqual(c.ofType(c.toPage, "stop").map((m) => m.id), [id])
  assert.equal(c.ofType(c.sent, "session-start").length, 1)
})

// ---- a call the worker already finalised as stale (the tab was frozen or the laptop slept) keeps
// recording into a new session; only what the first session didn't store goes into the new one.
const FINALIZED = { error: "session closed", fatal: true, closed: "finalized" }
const final = (id, text, device = "d1") => ({ id, version: 1, text, device, final: true })
async function finalisedMidCall(opts = {}) {
  const f = feedAdapter()
  let finalized = false
  const { c, id } = await joined({ adapter: f.adapter, reply: (m) => (finalized && m.id === id && m.type === (opts.on || "session-update") ? FINALIZED : { ok: true }), ...opts.join })
  f.hooks.state = c.state
  c.state.feed = true
  c.fromPage({ type: "started", id })
  f.hooks.onUtterance(final(1, "stored before the sleep"))
  for (let i = 0; i < 4; i++) { c.advance(1000); await c.flush() }
  assert.ok(c.ofType(c.sent, "session-update").some((m) => m.id === id && m.utterances.some((u) => u.text === "stored before the sleep")), "control: saved in the first session")
  finalized = true
  f.hooks.onUtterance(final(2, "said while the worker finalised it"))
  if (opts.on === "audio-chunk") c.fromPage(chunkMsg(id, 0))
  for (let i = 0; i < 6; i++) { c.advance(1000); await c.flush() }
  return { c, f, id }
}

test("a call finalised as stale while the tab still records it carries on in a new session: new id, new recorder, overlay stays", async () => {
  const { c, f, id } = await finalisedMidCall()
  const starts = c.ofType(c.sent, "session-start")
  assert.equal(starts.length, 2, "no new session for the rest of the call")
  const id2 = starts[1].session.id
  assert.notEqual(id2, id)
  assert.deepEqual(c.ofType(c.toPage, "stop").map((m) => m.id), [id], "the first recorder was not stopped")
  assert.deepEqual(c.ofType(c.toPage, "start").map((m) => m.id), [id, id2], "no recorder for the new session")
  assert.equal(c.ofType(c.sent, "session-end").length, 0, "session-end sent for the finalised session")
  const ov = c.overlays.at(-1)
  assert.equal(c.overlays.length, 1)
  assert.ok(!ov.removed, "the overlay was removed although the call is still recorded")
  assert.equal(ov.updates.at(-1).startedAt, ov.updates[0].startedAt, "the overlay's call clock restarted")
  assert.ok(!ov.updates.some((u) => u.transcript === "save-failed"), "'save failed' shown although nothing was lost")
  // The rest of the call: lines the first session never stored, and new ones; not the stored ones.
  f.hooks.onUtterance(final(3, "after the wake"))
  c.fromPage({ type: "started", id: id2 })
  c.fromPage(chunkMsg(id2, 0))
  for (let i = 0; i < 4; i++) { c.advance(1000); await c.flush() }
  const texts = c.ofType(c.sent, "session-update").filter((m) => m.id === id2).at(-1).utterances.map((u) => u.text)
  assert.deepEqual(texts, ["said while the worker finalised it", "after the wake"], "the new session's transcript isn't the remainder")
  assert.deepEqual(c.ofType(c.sent, "audio-chunk").filter((m) => m.id === id2).map((m) => m.seq), [0], "the new recorder's audio isn't sent")
  await leave(c)
  c.advance(7000) // no 'stopped' from this fake page: session-end goes after the stop timeout
  await c.flush()
  assert.deepEqual(c.ofType(c.sent, "session-end").map((m) => m.id), [id2])
})

test("a refused audio chunk of a call finalised as stale also carries on in a new session", async () => {
  const { c, id } = await finalisedMidCall({ on: "audio-chunk" })
  const starts = c.ofType(c.sent, "session-start")
  assert.equal(starts.length, 2)
  assert.deepEqual(c.ofType(c.toPage, "stop").map((m) => m.id), [id])
})

test("the per-tab session limit doesn't block carrying on a finalised call", async () => {
  const f = feedAdapter()
  let finalized = false
  let live = null
  const c = createContent({ adapter: f.adapter, reply: (m) => (finalized && m.id === live ? FINALIZED : { ok: true }) })
  await c.flush()
  for (let i = 0; i < 6; i++) { // six calls in a few minutes: the most a tab may start in 10 minutes
    c.state.inCall = true
    c.advance(1000)
    await c.flush()
    if (i < 5) await leave(c)
  }
  assert.equal(c.ofType(c.sent, "session-start").length, 6, "control: six sessions")
  live = c.ofType(c.sent, "session-start").at(-1).session.id
  finalized = true
  for (let i = 0; i < 20; i++) { c.advance(1000); await c.flush() }
  assert.equal(c.ofType(c.sent, "session-start").length, 7, "the rest of the call was blocked by the session limit")
})

test("a fatal refusal of one transcript save that doesn't close the call isn't resent every heartbeat (M-A)", async () => {
  const { c } = await joined({ reply: (m) => (m.type === "session-update" ? { error: "bad thing", fatal: true } : { ok: true }) })
  for (let i = 0; i < 30; i++) { c.advance(1000); await c.flush() }
  const n = c.ofType(c.sent, "session-update").length
  assert.ok(n <= 4, `${n} transcript saves in 30 s after a fatal refusal`)
  assert.equal(c.overlays.at(-1).updates.at(-1).transcript, "save-failed")
})

test("a transcript save that keeps failing shows 'save failed' in the overlay, and clears once one is stored (M-A)", async () => {
  let failing = true
  const { c } = await joined({ reply: (m) => (m.type === "session-update" && failing ? { error: "QuotaExceededError" } : { ok: true }) })
  for (let i = 0; i < 20; i++) { c.advance(1000); await c.flush() }
  assert.equal(c.overlays.at(-1).updates.at(-1).transcript, "save-failed")
  failing = false
  for (let i = 0; i < 20; i++) { c.advance(1000); await c.flush() }
  assert.notEqual(c.overlays.at(-1).updates.at(-1).transcript, "save-failed")
})

// ---- final review M-B: 'stopped' answered at once (no live recorder) ends the session at once
test("the page answers 'stop' synchronously (recorder never started): session-end isn't held for the 6 s timeout (M-B)", async () => {
  const { c, id } = await joined()
  c.fromPage({ type: "error", id, message: "no audio" })
  const push = c.toPage.push.bind(c.toPage)
  c.toPage.push = (m) => { const r = push(m); if (m.type === "stop") c.fromPage({ type: "stopped", id: m.id }); return r }
  c.state.inCall = false
  c.advance(5000) // the end is noticed after the 4 s grace
  await c.flush()
  assert.equal(c.ofType(c.sent, "session-end").length, 1, "session-end waited for the stop timeout")
  c.advance(6000)
  await c.flush()
  assert.equal(c.ofType(c.sent, "session-end").length, 1)
})

// ---- final review M-C: orphaning gives Meet its own captions and layout back
test("orphaned: the hidden-captions style is removed and the tile space is given back (M-C)", async () => {
  const reclaim = []
  const { c } = await joined({ settings: { hideCaptions: true }, adapter: { captionContainer: ".captions", reclaimCaptionSpace: (h) => reclaim.push(h) } })
  assert.ok(c.doc.getElementById("callscribe-hide-captions"), "control: captions hidden while recording")
  assert.equal(reclaim.at(-1), true)
  c.runtime.id = undefined
  c.advance(1000)
  await c.flush()
  assert.equal(c.doc.getElementById("callscribe-hide-captions"), null, "captions still hidden after the extension was updated")
  assert.equal(reclaim.at(-1), false, "tile translate/scale rules left in place")
  const n = reclaim.length
  c.advance(5000)
  assert.equal(reclaim.length, n, "still adjusting the page after orphaning")
})
