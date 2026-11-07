// Runs in the page's own JS world at document_start, before the call app loads.
// Collects the call's audio tracks (remote WebRTC tracks + your microphone) without
// changing what the app sends or plays, and records a mix of them on request.
//
// Talks to the extension's content script only over the private channel set up by
// src/content/bridge.js (all message types are listed there); nothing is posted on window.
// The recorder belongs to one session id at a time:
//   start {id, includeMic}  starts a recorder for id; if another id still owns one, that one
//                           is stopped first (it posts its last chunk and 'stopped')
//   pause/resume {id}       pause or resume the recorder of id (audio switched off/on mid-call)
//   config {id, includeMic} attach or detach your mic mid-call
//   stop {id}               stop the recorder of id; 'stopped' {id} follows its last chunk.
//                           For an id with no recorder, 'stopped' is posted straight away.
//   mic {on}                mute gate for your mic. Starts closed; only an explicit on opens it.
//   status                  -> status {recording, id, paused, state, remote, mic, peers, sources, micOn, includeMic, micGain}
// Closed peer connections and ended tracks are dropped every few seconds and before each start.
;(function () {
  "use strict"
  if (window.__callscribeAudioHook) return
  Object.defineProperty(window, "__callscribeAudioHook", { value: true })

  const HANDSHAKE = "__callscribe_bridge"
  const TO_PAGE = "__callscribe_to_page"
  const TO_EXT = "__callscribe_to_ext"
  const CHUNK_MS = 5000

  // --- natives, captured before any page script can patch them
  const apply = Reflect.apply
  const addListener = EventTarget.prototype.addEventListener
  const removeListener = EventTarget.prototype.removeEventListener
  const dispatch = EventTarget.prototype.dispatchEvent
  const relatedTargetOf = Object.getOwnPropertyDescriptor(MouseEvent.prototype, "relatedTarget").get
  const detailOf = Object.getOwnPropertyDescriptor(CustomEvent.prototype, "detail").get
  const hasOwn = Object.prototype.hasOwnProperty
  const NativeCustomEvent = CustomEvent
  const NativeAudioContext = window.AudioContext
  const NativeMediaStream = window.MediaStream
  const NativeMediaRecorder = window.MediaRecorder
  const isTypeSupported = NativeMediaRecorder && NativeMediaRecorder.isTypeSupported
  const blobDataOf = window.BlobEvent && Object.getOwnPropertyDescriptor(BlobEvent.prototype, "data").get
  const blobArrayBuffer = Blob.prototype.arrayBuffer
  const own = (m, k) => (apply(hasOwn, m, [k]) ? m[k] : undefined)
  const scriptsOf = Object.getOwnPropertyDescriptor(Document.prototype, "scripts").get

  // --- private channel (see src/content/bridge.js)
  let port = null
  const post = (msg) => {
    if (port) apply(dispatch, port, [new NativeCustomEvent(TO_EXT, { __proto__: null, detail: msg })])
  }
  function onHandshake(ev) {
    apply(removeListener, window, [HANDSHAKE, onHandshake, true])
    const node = apply(relatedTargetOf, ev, [])
    // Fail closed: the genuine handshake comes at document_start, before the page has any
    // <script>. One arriving later could only come from page code.
    if (port || !node || apply(scriptsOf, document, []).length) return
    port = node
    apply(addListener, port, [TO_PAGE, (e) => {
      const m = apply(detailOf, e, [])
      if (m && typeof m === "object") handle(m)
    }])
  }
  apply(addListener, window, [HANDSHAKE, onHandshake, true])

  const remote = new Map() // track -> its "ended" listener
  const mic = new Map()
  const peers = new Set()
  let rec = null // { id, ctx, dest, micGain, micLevel, recorder, sources: Map<track, node>, includeMic, seq, mime, paused, cleanup: [] }
  let micOn = false // follows the call app's own mute button; closed until the content script says unmuted

  function attach(track) {
    if (!rec || rec.sources.has(track) || track.readyState === "ended") return
    if (mic.has(track) && !rec.includeMic) return
    try {
      const node = rec.ctx.createMediaStreamSource(new NativeMediaStream([track]))
      node.connect(mic.has(track) ? rec.micGain : rec.dest)
      rec.sources.set(track, node)
    } catch (e) {
      post({ type: "log", id: rec.id, message: "attach failed: " + e.message })
    }
  }

  function detach(track) {
    const node = rec && rec.sources.get(track)
    if (node) {
      try { node.disconnect() } catch {}
      rec.sources.delete(track)
    }
  }

  function forget(track, set) {
    const onEnded = set.get(track)
    if (!onEnded) return
    set.delete(track)
    try { track.removeEventListener("ended", onEnded) } catch {}
    detach(track)
  }

  function addTrack(track, set) {
    if (!track || track.kind !== "audio" || set.has(track) || track.readyState === "ended") return
    const onEnded = () => forget(track, set)
    set.set(track, onEnded)
    track.addEventListener("ended", onEnded, { once: true })
    attach(track)
  }

  // A local pc.close() or track.stop() fires no event: drop them by their state.
  function prune() {
    for (const pc of peers) {
      if (pc.connectionState === "closed" || pc.signalingState === "closed") peers.delete(pc)
    }
    for (const set of [remote, mic]) {
      for (const track of [...set.keys()]) if (track.readyState === "ended") forget(track, set)
    }
  }

  // --- capture remote tracks from every peer connection the app creates
  const NativePC = window.RTCPeerConnection
  if (NativePC) {
    const watch = (pc) => {
      peers.add(pc)
      pc.addEventListener("track", (ev) => addTrack(ev.track, remote))
      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "closed") peers.delete(pc)
      })
    }
    const Wrapped = new Proxy(NativePC, {
      construct(target, args, newTarget) {
        const pc = Reflect.construct(target, args, newTarget)
        try { watch(pc) } catch {}
        return pc
      },
    })
    window.RTCPeerConnection = Wrapped
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Wrapped
  }

  // --- capture the microphone the app opens
  const md = navigator.mediaDevices
  if (md && md.getUserMedia) {
    const nativeGUM = md.getUserMedia.bind(md)
    md.getUserMedia = async function (constraints) {
      const stream = await nativeGUM(constraints)
      try { stream.getAudioTracks().forEach((t) => addTrack(t, mic)) } catch {}
      return stream
    }
  }

  function sweepPeers() {
    for (const pc of peers) {
      try {
        for (const r of pc.getReceivers()) if (r.track && r.track.readyState === "live") addTrack(r.track, remote)
      } catch {}
    }
  }

  function attachAll() {
    remote.forEach((_, t) => attach(t))
    mic.forEach((_, t) => attach(t))
  }

  // Mic gain follows the gate. Closing is immediate; opening ramps in over ~20 ms.
  function setMicLevel() {
    if (!rec) return
    const level = micOn && rec.includeMic ? 1 : 0
    if (rec.micLevel === level) return
    rec.micLevel = level
    const g = rec.micGain.gain
    try {
      const t = rec.ctx.currentTime
      if (g.cancelScheduledValues) g.cancelScheduledValues(t)
      if (level) g.setTargetAtTime(1, t, 0.02)
      else g.setValueAtTime(0, t)
    } catch {
      g.value = level
    }
  }

  function teardown(state) {
    for (const fn of state.cleanup.splice(0)) {
      try { fn() } catch {}
    }
    state.sources.forEach((n) => { try { n.disconnect() } catch {} })
    state.sources.clear()
    if (state.ctx) state.ctx.close().catch(() => {})
  }

  function start(id, includeMic) {
    if (rec && rec.id === id) return
    if (rec) stop(rec.id)
    prune()
    const state = { id, ctx: null, dest: null, micGain: null, micLevel: -1, recorder: null, sources: new Map(), includeMic, seq: 0, mime: "", paused: false, cleanup: [] }
    try {
      const ctx = (state.ctx = new NativeAudioContext({ sampleRate: 48000 }))
      // Autoplay policy can leave the graph suspended until the user interacts with the page.
      if (ctx.state !== "running") {
        const kick = () => {
          ctx.resume().then(() => { if (ctx.state === "running") unkick() }, () => {})
        }
        const unkick = () => {
          document.removeEventListener("pointerdown", kick, true)
          document.removeEventListener("keydown", kick, true)
        }
        document.addEventListener("pointerdown", kick, true)
        document.addEventListener("keydown", kick, true)
        state.cleanup.push(unkick)
        ctx.resume().catch(() => {})
      }
      state.dest = ctx.createMediaStreamDestination()
      // A silent constant keeps the recording continuous even before anyone speaks.
      const keepAlive = ctx.createConstantSource()
      keepAlive.offset.value = 0
      keepAlive.connect(state.dest)
      keepAlive.start()
      state.micGain = ctx.createGain()
      state.micGain.gain.value = 0
      state.micGain.connect(state.dest)
      state.mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((m) => apply(isTypeSupported, NativeMediaRecorder, [m]))
      state.recorder = new NativeMediaRecorder(state.dest.stream, { mimeType: state.mime, audioBitsPerSecond: 48000 })
    } catch (e) {
      teardown(state)
      post({ type: "error", id, message: String((e && e.message) || e) })
      return
    }
    const { recorder, mime } = state
    let queue = Promise.resolve() // keeps chunks in order and 'stopped' after the last one
    apply(addListener, recorder, ["dataavailable", (ev) => {
      const blob = blobDataOf ? apply(blobDataOf, ev, []) : ev.data
      if (!blob || !blob.size) return
      const seq = state.seq++
      queue = queue.then(async () => {
        const buf = await apply(blobArrayBuffer, blob, [])
        post({ type: "chunk", id, seq, mime, buf })
      }).catch(() => {})
    }])
    apply(addListener, recorder, ["stop", () => {
      queue = queue.then(() => post({ type: "stopped", id }))
    }])
    rec = state
    setMicLevel()
    sweepPeers()
    attachAll()
    try {
      recorder.start(CHUNK_MS)
    } catch (e) {
      rec = null
      teardown(state)
      post({ type: "error", id, message: String((e && e.message) || e) })
      return
    }
    post({ type: "started", id, mime, remote: remote.size, mic: mic.size, state: state.ctx.state })
  }

  function stop(id) {
    if (!rec || rec.id !== id) return post({ type: "stopped", id })
    const r = rec
    rec = null
    for (const fn of r.cleanup.splice(0)) {
      try { fn() } catch {}
    }
    try {
      if (r.recorder.state !== "inactive") r.recorder.stop()
      else post({ type: "stopped", id })
    } catch {
      post({ type: "stopped", id })
    }
    // Let the final dataavailable fire before closing the graph.
    setTimeout(() => teardown(r), 1000)
  }

  function pause(id, on) {
    if (!rec || rec.id !== id) return
    try {
      if (on && rec.recorder.state === "recording") rec.recorder.pause()
      else if (!on && rec.recorder.state === "paused") rec.recorder.resume()
      rec.paused = on
      post({ type: on ? "paused" : "resumed", id })
    } catch (e) {
      post({ type: "log", id, message: "pause/resume failed: " + e.message })
    }
  }

  function configure(id, includeMic) {
    if (!rec || rec.id !== id) return
    rec.includeMic = includeMic
    if (includeMic) mic.forEach((_, t) => attach(t))
    else mic.forEach((_, t) => detach(t))
    setMicLevel()
  }

  function handle(m) {
    const type = own(m, "type")
    const id = own(m, "id")
    if (type === "start") {
      if (typeof id === "string" && id) start(id, own(m, "includeMic") !== false)
    } else if (type === "stop") {
      if (typeof id === "string") stop(id)
    } else if (type === "pause" || type === "resume") {
      pause(id, type === "pause")
    } else if (type === "config") {
      configure(id, own(m, "includeMic") !== false)
    } else if (type === "mic") {
      micOn = own(m, "on") === true
      setMicLevel()
    } else if (type === "status") {
      post({
        type: "status", recording: Boolean(rec), id: rec ? rec.id : null, paused: Boolean(rec && rec.paused), state: rec ? rec.ctx.state : null,
        remote: remote.size, mic: mic.size, peers: peers.size, sources: rec ? rec.sources.size : 0,
        micOn, includeMic: rec ? rec.includeMic : null, micGain: rec ? rec.micLevel : null,
      })
    }
  }

  // Tracks that appear mid-call (new participants, mic switches); drop closed ones.
  setInterval(() => {
    prune()
    if (rec) {
      sweepPeers()
      attachAll()
    }
  }, 3000)
})()
