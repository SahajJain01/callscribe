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
    p.toPage({ type: "start", id: "s1", includeMic: true })
    await p.flush()
    const ctx = p.contexts[0]
    const first = ctx.resumeCalls
    assert.equal(first, 1, "resume() tried once at start")
    p.doc.dispatchEvent(new Event("pointerdown"))
    p.doc.dispatchEvent(new Event("keydown"))
    await p.flush()
    assert.equal(ctx.resumeCalls, 3, "a pointerdown and a keydown each retry resume() while suspended")
    p.toPage({ type: "stop", id: "s1" })
    await p.flush()
    p.doc.dispatchEvent(new Event("pointerdown"))
    p.doc.dispatchEvent(new Event("keydown"))
    await p.flush()
    assert.equal(ctx.resumeCalls, 3, "listener still active after stop")
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(rejections.length, 0, "unhandled resume() rejection")
  } finally {
    process.off("unhandledRejection", onRej)
  }
})

test("a failed start removes the resume listeners and reports the error", async () => {
  const p = setup({ ctxState: "suspended", recorderThrows: true })
  p.toPage({ type: "start", id: "s1", includeMic: true })
  await p.flush()
  assert.equal(of(p, "error")[0].id, "s1")
  assert.ok(p.contexts.length === 1 && p.contexts.every((c) => c.closed), "AudioContext left open after a failed start")
  const calls = p.contexts[0].resumeCalls
  p.doc.dispatchEvent(new Event("pointerdown"))
  p.doc.dispatchEvent(new Event("keydown"))
  await p.flush()
  assert.equal(p.contexts[0].resumeCalls, calls, "resume listener left after a failed start")
})

// --- Page scripts patching built-ins (Task 1 review C1, I1). The test plays a page script that
// runs after the hook loaded (any page script does) and patches every prototype the recorder
// path could touch. The hook must never call any of them, so none of them ever sees our
// recorder, graph, params or audio, and their behaviour can't change the recording.
const FAKE_HELPERS = new Set(["emit", "end", "addRemoteTrack", "remoteChannel"]) // the fake browser's own test hooks
function patchAll(p, protos) {
  const hits = []
  const undo = []
  for (const [name, proto] of protos) {
    for (const key of Reflect.ownKeys(proto)) {
      if (key === "constructor" || FAKE_HELPERS.has(key)) continue
      const d = Object.getOwnPropertyDescriptor(proto, key)
      const nd = { ...d }
      if (typeof d.value === "function") {
        nd.value = function () { hits.push(name + "." + String(key)); return d.value.apply(this, arguments) }
      } else if (d.get || d.set) {
        if (d.get) nd.get = function () { hits.push(name + ".get " + String(key)); return d.get.call(this) }
        if (d.set) nd.set = function (v) { hits.push(name + ".set " + String(key)); return d.set.call(this, v) }
      } else continue
      Object.defineProperty(proto, key, nd)
      undo.push(() => Object.defineProperty(proto, key, d))
    }
  }
  return { hits, undo: () => undo.forEach((f) => f()) }
}

test("page-patched MediaRecorder/WebAudio/MediaStream/WebRTC/Blob prototypes and timers are never called (C1, I1)", async () => {
  const p = setup()
  const w = p.win
  const mic = await micTrack(p)
  const pc = new w.RTCPeerConnection()
  const remote = new p.Track("audio")
  pc.addRemoteTrack(remote)
  const protos = [
    ["MediaRecorder", w.MediaRecorder.prototype], ["AudioContext", w.AudioContext.prototype], ["AudioNode", w.AudioNode.prototype],
    ["GainNode", w.GainNode.prototype], ["ConstantSourceNode", w.ConstantSourceNode.prototype], ["AudioParam", w.AudioParam.prototype],
    ["MediaStreamAudioDestinationNode", w.MediaStreamAudioDestinationNode.prototype], ["MediaStream", w.MediaStream.prototype],
    ["MediaStreamTrack", w.MediaStreamTrack.prototype], ["RTCPeerConnection", p.PeerConnection.prototype],
    ["RTCRtpReceiver", w.RTCRtpReceiver.prototype], ["RTCTrackEvent", w.RTCTrackEvent.prototype], ["FileReader", w.FileReader.prototype],
    ["BlobEvent", w.BlobEvent.prototype],
  ]
  const patched = patchAll(p, protos)
  // Shared with the test process (same realm objects): patched only around the hook's work.
  const blob = patchAll(p, [["Blob", Blob.prototype]])
  const timers = []
  const st = w.setTimeout
  const si = w.setInterval
  w.setTimeout = (fn, ms) => { timers.push("setTimeout"); return st(fn, ms) }
  w.setInterval = (fn, ms) => { timers.push("setInterval"); return si(fn, ms) }
  try {
    p.toPage({ type: "start", id: "s1", includeMic: true })
    p.toPage({ type: "mic", on: true })
    p.toPage({ type: "mic", on: false })
    p.toPage({ type: "pause", id: "s1" })
    p.toPage({ type: "resume", id: "s1" })
    p.toPage({ type: "config", id: "s1", includeMic: false })
    p.toPage({ type: "config", id: "s1", includeMic: true })
    p.toPage({ type: "status" })
    remote.end()
    p.advance(3500)
    p.recorders[0].emit(new Uint8Array([1, 2, 3]))
    await p.flush()
    p.toPage({ type: "stop", id: "s1" })
    await p.flush()
    p.advance(1500)
    await p.flush()
  } finally {
    blob.undo()
    patched.undo()
  }
  // control: the patches are live (the test calling them is counted)
  const probe = patchAll(p, [["MediaRecorder", w.MediaRecorder.prototype]])
  void p.recorders[0].state
  probe.undo()
  assert.deepEqual(probe.hits, ["MediaRecorder.get state"], "control: a patched prototype getter is seen")
  assert.deepEqual(patched.hits, [], "the hook called page-patchable built-ins")
  assert.deepEqual(blob.hits, [], "the hook called page-patchable Blob methods")
  assert.deepEqual(timers, [], "the hook used page-patchable timers")
  // and it all still worked
  assert.equal(of(p, "started")[0].id, "s1")
  assert.deepEqual(of(p, "chunk").map((c) => [...new Uint8Array(c.buf)]), [[1, 2, 3], [9, 9]])
  assert.deepEqual(of(p, "stopped").map((m) => m.id), ["s1"])
  assert.equal(p.contexts[0].closed, true)
  assert.ok(mic && p.contexts[0].sources.some((n) => n.track === mic), "the mic was attached")
})

test("events dispatched by page code on the recorder are ignored: no forged chunk, no forged stop (C1)", async () => {
  const p = setup()
  p.toPage({ type: "start", id: "s1", includeMic: true })
  await p.flush()
  const r = p.recorders[0] // as if a page script had got hold of it
  r.dispatchEvent(new p.BlobEvent("dataavailable", { data: new Blob([new Uint8Array(16).fill(65)], { type: "audio/webm" }) }))
  r.dispatchEvent(new Event("stop"))
  await p.flush()
  assert.equal(of(p, "chunk").length, 0, "a forged chunk was posted")
  assert.equal(of(p, "stopped").length, 0, "a forged stop was posted")
  r.emit(new Uint8Array([4, 5])) // control: the browser's own events still go through
  await p.flush()
  assert.deepEqual(of(p, "chunk").map((c) => [c.seq, [...new Uint8Array(c.buf)]]), [[0, [4, 5]]])
})

test("page code can't detach a call track or attach one with forged ended/track events", async () => {
  const p = setup()
  const pc = new p.win.RTCPeerConnection()
  const remote = new p.Track("audio")
  pc.addRemoteTrack(remote)
  p.toPage({ type: "start", id: "s1", includeMic: true })
  await p.flush()
  const node = p.contexts[0].sources.find((n) => n.track === remote)
  assert.ok(node)
  remote.dispatchEvent(new Event("ended"))
  const fake = new Event("track")
  fake.track = new p.Track("audio")
  pc.dispatchEvent(fake)
  const forgedTrackEvent = new p.win.RTCTrackEvent("track", { track: new p.Track("audio") })
  pc.dispatchEvent(forgedTrackEvent)
  let st = await status(p)
  assert.equal(node.disconnected, false, "a forged ended event detached the remote track")
  assert.equal(st.remote, 1, "a forged track event added a track")
  remote.end() // control: a real ended does detach it
  st = await status(p)
  assert.equal(node.disconnected, true)
  assert.equal(st.remote, 0)
})

test("the mic gate can't be opened through patched AudioParam/AudioNode prototypes (I1)", async () => {
  const p = setup()
  const w = p.win
  const mic = await micTrack(p)
  // A page script tries to keep the mic gain at 1 and to wire the mic straight to the mix.
  const P = w.AudioParam.prototype
  const val = Object.getOwnPropertyDescriptor(P, "value")
  Object.defineProperty(P, "value", { ...val, set() { val.set.call(this, 1) } })
  for (const k of ["setValueAtTime", "setTargetAtTime"]) {
    const orig = P[k]
    P[k] = function (v, ...rest) { return orig.call(this, 1, ...rest) }
  }
  const connect = w.AudioNode.prototype.connect
  w.AudioNode.prototype.connect = function (n) { return connect.call(this, this.ctx && this.ctx.dest ? this.ctx.dest : n) }
  p.toPage({ type: "start", id: "s1", includeMic: true })
  await p.flush()
  const ctx = p.contexts[0]
  const gain = ctx.gains[0]
  const micNode = ctx.sources.find((n) => n.track === mic)
  assert.equal(gain._gain._v, 0, "mic gain opened by a patched AudioParam")
  assert.deepEqual(micNode.out, [gain], "mic source rewired by a patched AudioNode.connect")
  assert.ok(!ctx.dest.out.length && !micNode.out.includes(ctx.dest))
  const st = await status(p)
  assert.equal(st.micOn, false)
  p.toPage({ type: "mic", on: true }) // control: the real gate still opens
  assert.equal(gain._gain._v, 1)
})

test("patched Map/Set prototypes never see the recorder's tracks, nodes or blobs (C1)", async () => {
  const p = setup()
  const mic = await micTrack(p)
  const leaked = []
  const isOurs = (v) => v instanceof p.win.AudioNode || v instanceof p.win.MediaRecorder || v instanceof Blob ||
    v instanceof p.win.AudioParam || v === mic
  const undo = []
  for (const C of [Map, Set]) {
    for (const k of ["get", "set", "has", "delete", "forEach", "add", "clear", "keys", "values", "entries"]) {
      const orig = C.prototype[k]
      if (!orig) continue
      C.prototype[k] = function (...a) {
        try {
          if (a.some(isOurs)) leaked.push(C.name + "." + k)
          orig.call(this, (v, key) => { if (isOurs(v) || isOurs(key)) leaked.push(C.name + "." + k + " entry") })
        } catch {}
        return orig.apply(this, a)
      }
      undo.push(() => { C.prototype[k] = orig })
    }
  }
  try {
    p.toPage({ type: "start", id: "s1", includeMic: true })
    p.toPage({ type: "mic", on: true })
    p.toPage({ type: "status" })
    p.recorders[0].emit(new Uint8Array([1]))
    await p.flush()
    p.toPage({ type: "stop", id: "s1" })
    await p.flush()
  } finally {
    undo.forEach((f) => f())
  }
  assert.deepEqual(leaked, [])
  assert.equal(of(p, "chunk").length, 2, "control: the recording ran")
})
