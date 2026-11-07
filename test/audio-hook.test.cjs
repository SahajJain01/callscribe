// src/page/audio-hook.js in a fake page: private channel only, recorder ownership per
// session id, the mic gate, cleanup of peers/tracks and of the autoplay resume listeners.
const test = require("node:test")
const assert = require("node:assert/strict")
const { createPage } = require("./helpers/page-env.cjs")

function setup(opts) {
  const p = createPage(opts)
  p.load("src/page/audio-hook.js")
  p.connect()
  return p
}
const of = (p, type) => p.fromPage.filter((m) => m.type === type)

async function micTrack(p) {
  await p.win.navigator.mediaDevices.getUserMedia({ audio: true })
  return p.gumTracks.at(-1)
}

async function status(p) {
  p.toPage({ type: "status" })
  await p.flush()
  return of(p, "status").at(-1)
}

test("commands posted on window (page-visible) are ignored; only the private channel drives the recorder", async () => {
  const p = createPage()
  p.load("src/page/audio-hook.js")
  p.connect()
  p.win.postMessage({ __callscribe: "ext", type: "start", id: "forged", includeMic: true })
  p.win.postMessage({ __callscribe: "ext", type: "mic", on: true })
  await p.flush()
  assert.equal(p.contexts.length, 0, "a window message must not start a recording")
  p.toPage({ type: "start", id: "s1", includeMic: true })
  await p.flush()
  assert.equal(p.contexts.length, 1)
  assert.equal(of(p, "started")[0].id, "s1")
})

test("nothing is ever broadcast with window.postMessage: chunks go over the channel only", async () => {
  const p = setup()
  p.toPage({ type: "start", id: "s1", includeMic: true })
  await p.flush()
  p.recorders[0].emit(new Uint8Array([1, 2, 3]))
  await p.flush()
  assert.equal(p.posted.length, 0, "window.postMessage used: " + JSON.stringify(p.posted.map((m) => m.type)))
  const c = of(p, "chunk")[0]
  assert.equal(c.id, "s1")
  assert.equal(c.seq, 0)
  assert.ok(c.buf instanceof ArrayBuffer)
  assert.deepEqual([...new Uint8Array(c.buf)], [1, 2, 3])
})

test("only the first bridge handshake is accepted: a later one (page script) gets no channel", async () => {
  const p = createPage()
  p.load("src/page/audio-hook.js")
  const real = p.connect()
  const attacker = new EventTarget()
  const seen = []
  attacker.addEventListener(p.TO_EXT, (e) => seen.push(e.detail))
  p.win.dispatchEvent(new p.MouseEvent(p.HANDSHAKE, { relatedTarget: attacker }))
  p.toPage({ type: "start", id: "s1", includeMic: true }, attacker)
  p.toPage({ type: "status" }, attacker)
  await p.flush()
  assert.equal(p.contexts.length, 0)
  assert.equal(seen.length, 0)
  p.toPage({ type: "start", id: "s1", includeMic: true }, real)
  p.recorders[0].emit(new Uint8Array([5]))
  await p.flush()
  assert.equal(seen.length, 0, "attacker node received " + JSON.stringify(seen))
})

test("a handshake once page scripts exist is refused: no channel (fail closed)", async () => {
  const p = createPage()
  p.load("src/page/audio-hook.js")
  p.doc._scripts = [{}]
  p.connect()
  p.toPage({ type: "start", id: "s1", includeMic: true })
  await p.flush()
  assert.equal(p.contexts.length, 0)
})

test("the mic gate starts closed and opens only on an explicit mic on", async () => {
  const p = setup()
  await micTrack(p)
  p.toPage({ type: "start", id: "s1", includeMic: true })
  await p.flush()
  let st = await status(p)
  assert.equal(st.micOn, false)
  assert.equal(st.micGain, 0)
  p.toPage({ type: "mic", on: true })
  st = await status(p)
  assert.equal(st.micOn, true)
  assert.equal(st.micGain, 1)
  p.toPage({ type: "mic", on: false })
  st = await status(p)
  assert.equal(st.micGain, 0)
})

test("start for a new session while another id records: the old recorder is stopped first, never reused", async () => {
  const p = setup()
  p.toPage({ type: "start", id: "old", includeMic: true })
  await p.flush()
  p.toPage({ type: "start", id: "new", includeMic: true })
  await p.flush()
  assert.equal(p.recorders.length, 2, "a second recorder must be created for the new session")
  assert.equal(p.recorders[0].state, "inactive")
  assert.ok(of(p, "stopped").some((m) => m.id === "old"))
  assert.ok(of(p, "started").some((m) => m.id === "new"))
  p.recorders[1].emit(new Uint8Array([7]))
  await p.flush()
  const chunks = of(p, "chunk")
  assert.equal(chunks.at(-1).id, "new")
  assert.equal(chunks.at(-1).seq, 0)
})

test("stop is scoped to the session id: a stop for another id is ignored, the right one stops", async () => {
  const p = setup()
  p.toPage({ type: "start", id: "s1", includeMic: true })
  await p.flush()
  p.toPage({ type: "stop", id: "other" })
  p.toPage({ type: "stop" })
  await p.flush()
  assert.equal(p.recorders[0].state, "recording")
  p.toPage({ type: "stop", id: "s1" })
  await p.flush()
  assert.equal(p.recorders[0].state, "inactive")
  // A stop for an id with no recorder is answered at once, so a waiting caller isn't held up.
  assert.deepEqual(of(p, "stopped").map((m) => m.id), ["other", "s1"])
  // the final chunk is posted before 'stopped'
  const idxChunk = p.fromPage.findIndex((m) => m.type === "chunk")
  const idxStopped = p.fromPage.findIndex((m) => m.type === "stopped" && m.id === "s1")
  assert.ok(idxChunk >= 0 && idxChunk < idxStopped)
})

test("pause and resume apply to the owning session only", async () => {
  const p = setup()
  p.toPage({ type: "start", id: "s1", includeMic: true })
  await p.flush()
  p.toPage({ type: "pause", id: "nope" })
  assert.equal(p.recorders[0].state, "recording")
  p.toPage({ type: "pause", id: "s1" })
  assert.equal(p.recorders[0].state, "paused")
  p.toPage({ type: "resume", id: "s1" })
  assert.equal(p.recorders[0].state, "recording")
})

test("turning mic recording off mid-call detaches the mic; on again re-attaches it", async () => {
  const p = setup()
  const t = await micTrack(p)
  p.toPage({ type: "start", id: "s1", includeMic: true })
  p.toPage({ type: "mic", on: true })
  await p.flush()
  const ctx = p.contexts[0]
  const micNode = ctx.sources.find((n) => n.track === t)
  assert.ok(micNode && !micNode.disconnected)
  p.toPage({ type: "config", id: "s1", includeMic: false })
  let st = await status(p)
  assert.ok(micNode.disconnected, "mic source still connected")
  assert.equal(st.includeMic, false)
  assert.equal(st.micGain, 0)
  p.toPage({ type: "config", id: "s1", includeMic: true })
  st = await status(p)
  assert.equal(st.includeMic, true)
  assert.ok(ctx.sources.filter((n) => n.track === t && !n.disconnected).length === 1)
})

test("closed peer connections and ended tracks are released (runtime I2)", async () => {
  const p = setup()
  const pc = new p.win.RTCPeerConnection()
  const remote = new p.Track("audio")
  pc.addRemoteTrack(remote)
  const mic = await micTrack(p)
  let st = await status(p)
  assert.equal(st.peers, 1)
  assert.equal(st.remote, 1)
  assert.equal(st.mic, 1)
  // The app hangs up: closes its connection and stops its mic, no events fire.
  pc.close()
  remote.stop()
  mic.stop()
  p.advance(3500) // the periodic sweep runs even when not recording
  st = await status(p)
  assert.equal(st.peers, 0, "closed peer connection still held")
  assert.equal(st.remote, 0, "ended remote track still held")
  assert.equal(st.mic, 0, "ended mic track still held")
  assert.equal(remote.listeners, 0, "listener left on ended remote track")
  assert.equal(mic.listeners, 0, "listener left on ended mic track")
})

test("a new recording never attaches tracks from a closed connection", async () => {
  const p = setup()
  const pc = new p.win.RTCPeerConnection()
  const remote = new p.Track("audio")
  pc.addRemoteTrack(remote)
  pc.close()
  remote.stop()
  p.toPage({ type: "start", id: "s1", includeMic: true })
  await p.flush()
  assert.equal(p.contexts[0].sources.length, 0)
  const st = await status(p)
  assert.equal(st.peers, 0)
})

test("suspended AudioContext: resume listeners are removed on stop and resume() rejections are caught", async () => {
  const rejections = []
  const onRej = (e) => rejections.push(e)
  process.on("unhandledRejection", onRej)
  try {
    const p = setup({ ctxState: "suspended", resumeRejects: true })
    const added = []
    const removed = []
    const add = p.doc.addEventListener.bind(p.doc)
    const rem = p.doc.removeEventListener.bind(p.doc)
    p.doc.addEventListener = (t, fn, o) => { added.push(t); return add(t, fn, o) }
    p.doc.removeEventListener = (t, fn, o) => { removed.push(t); return rem(t, fn, o) }
    p.toPage({ type: "start", id: "s1", includeMic: true })
    await p.flush()
    assert.deepEqual(added.sort(), ["keydown", "pointerdown"])
    p.doc.dispatchEvent(new Event("pointerdown"))
    await p.flush()
    p.toPage({ type: "stop", id: "s1" })
    await p.flush()
    assert.deepEqual(removed.sort(), ["keydown", "pointerdown"])
    const calls = p.contexts[0].resumeCalls
    p.doc.dispatchEvent(new Event("pointerdown"))
    await p.flush()
    assert.equal(p.contexts[0].resumeCalls, calls, "listener still active after stop")
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(rejections.length, 0, "unhandled resume() rejection")
  } finally {
    process.off("unhandledRejection", onRej)
  }
})

test("a failed start removes the resume listeners and reports the error", async () => {
  const p = setup({ ctxState: "suspended", recorderThrows: true })
  const live = new Set()
  const add = p.doc.addEventListener.bind(p.doc)
  const rem = p.doc.removeEventListener.bind(p.doc)
  p.doc.addEventListener = (t, fn, o) => { live.add(t); return add(t, fn, o) }
  p.doc.removeEventListener = (t, fn, o) => { live.delete(t); return rem(t, fn, o) }
  p.toPage({ type: "start", id: "s1", includeMic: true })
  await p.flush()
  assert.equal(of(p, "error")[0].id, "s1")
  assert.equal(live.size, 0)
  assert.ok(p.contexts.every((c) => c.closed), "AudioContext left open after a failed start")
})
