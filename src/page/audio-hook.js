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
//
// Page scripts must not reach the recording: the recorder, the AudioContext, its nodes and
// params, the blobs and buffers never pass through anything a page script can patch. Every
// built-in used here is captured when this file loads (before any page script exists) and only
// those captured functions are called, with Reflect.apply. That covers prototype methods and
// accessors (MediaRecorder, WebAudio, MediaStream/Track, RTCPeerConnection, Blob/FileReader),
// Map/Set methods (their entries are our tracks and nodes), timers and event listening.
// No array iteration, spread or promise chaining touches our objects (those consult
// patchable built-ins). Events are acted on only when the browser fired them (isTrusted,
// an unforgeable own property), so dispatchEvent() from page code changes nothing.
// What a page script can still do: feed its own media into the call (e.g. a WebRTC connection
// of its own whose remote audio we record like any other), or stop its own tracks.
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
  const construct = Reflect.construct
  const getOwn = Object.getOwnPropertyDescriptor
  const getProto = Object.getPrototypeOf
  const call = (fn, self, ...args) => apply(fn, self, args)
  // A prototype member (method, getter or setter), looked up along the chain now, at load.
  function member(C, key, kind) {
    for (let o = C && C.prototype; o; o = getProto(o)) {
      const d = getOwn(o, key)
      if (d) return kind === "get" ? d.get : kind === "set" ? d.set : d.value
    }
  }
  const addListener = EventTarget.prototype.addEventListener
  const removeListener = EventTarget.prototype.removeEventListener
  const dispatch = EventTarget.prototype.dispatchEvent
  const listen = (target, type, fn, capture) => call(addListener, target, type, fn, capture === true)
  const unlisten = (target, type, fn, capture) => call(removeListener, target, type, fn, capture === true)
  // isTrusted is an unforgeable own property of every Event: false for dispatchEvent() from script.
  const trusted = (ev) => Boolean(ev) && ev.isTrusted === true
  const relatedTargetOf = member(MouseEvent, "relatedTarget", "get")
  const detailOf = member(CustomEvent, "detail", "get")
  const hasOwn = Object.prototype.hasOwnProperty
  const NativeCustomEvent = CustomEvent
  const own = (m, k) => (apply(hasOwn, m, [k]) ? m[k] : undefined)
  const scriptsOf = member(Document, "scripts", "get")
  const setTimer = window.setTimeout
  const setRepeat = window.setInterval
  const later = (fn, ms) => call(setTimer, window, fn, ms)
  const noop = () => {}
  const promiseThen = Promise.prototype.then
  const settle = (p) => { try { call(promiseThen, p, noop, noop) } catch {} }
  const map = {
    get: Map.prototype.get, set: Map.prototype.set, has: Map.prototype.has, delete: Map.prototype.delete,
    forEach: Map.prototype.forEach, clear: Map.prototype.clear, size: member(Map, "size", "get"),
  }
  const set = { add: Set.prototype.add, has: Set.prototype.has, delete: Set.prototype.delete, forEach: Set.prototype.forEach, size: member(Set, "size", "get") }
  const NativeMap = Map
  const NativeSet = Set

  // Recording
  const NativeMediaRecorder = window.MediaRecorder
  const isTypeSupported = NativeMediaRecorder && NativeMediaRecorder.isTypeSupported
  const R = {
    start: member(NativeMediaRecorder, "start"), stop: member(NativeMediaRecorder, "stop"),
    pause: member(NativeMediaRecorder, "pause"), resume: member(NativeMediaRecorder, "resume"),
    state: member(NativeMediaRecorder, "state", "get"),
  }
  const blobDataOf = member(window.BlobEvent, "data", "get")
  const blobSize = member(Blob, "size", "get")
  const NativeFileReader = window.FileReader
  const readAsArrayBuffer = member(NativeFileReader, "readAsArrayBuffer")
  const readerResult = member(NativeFileReader, "result", "get")
  // Web Audio
  const NativeAudioContext = window.AudioContext
  const A = {
    source: member(NativeAudioContext, "createMediaStreamSource"), dest: member(NativeAudioContext, "createMediaStreamDestination"),
    constant: member(NativeAudioContext, "createConstantSource"), gain: member(NativeAudioContext, "createGain"),
    resume: member(NativeAudioContext, "resume"), close: member(NativeAudioContext, "close"),
    time: member(NativeAudioContext, "currentTime", "get"), state: member(NativeAudioContext, "state", "get"),
    connect: member(window.AudioNode, "connect"), disconnect: member(window.AudioNode, "disconnect"),
    offset: member(window.ConstantSourceNode, "offset", "get"), startSource: member(window.ConstantSourceNode, "start"),
    gainParam: member(window.GainNode, "gain", "get"), stream: member(window.MediaStreamAudioDestinationNode, "stream", "get"),
    setValue: member(window.AudioParam, "value", "set"), setValueAtTime: member(window.AudioParam, "setValueAtTime"),
    setTargetAtTime: member(window.AudioParam, "setTargetAtTime"), cancel: member(window.AudioParam, "cancelScheduledValues"),
  }
  // Media streams and WebRTC (the app's objects: read through captured accessors so a patched
  // getter can't lie to us about them)
  const NativeMediaStream = window.MediaStream
  const streamAddTrack = member(NativeMediaStream, "addTrack")
  const streamAudioTracks = member(NativeMediaStream, "getAudioTracks")
  const trackKind = member(window.MediaStreamTrack, "kind", "get")
  const trackState = member(window.MediaStreamTrack, "readyState", "get")
  const NativePC = window.RTCPeerConnection
  const pcConnState = member(NativePC, "connectionState", "get")
  const pcSigState = member(NativePC, "signalingState", "get")
  const pcReceivers = member(NativePC, "getReceivers")
  const receiverTrack = member(window.RTCRtpReceiver, "track", "get")
  const trackEventTrack = member(window.RTCTrackEvent, "track", "get")
  // Everything the recorder needs. If any of it is missing, starting reports an error instead.
  const canRecord = Boolean(NativeMediaRecorder && isTypeSupported && R.start && R.stop && R.pause && R.resume && R.state &&
    blobDataOf && blobSize && NativeFileReader && readAsArrayBuffer && readerResult && NativeAudioContext &&
    A.source && A.dest && A.constant && A.gain && A.resume && A.close && A.time && A.state && A.connect && A.disconnect &&
    A.offset && A.startSource && A.gainParam && A.stream && A.setValue && A.setValueAtTime && A.setTargetAtTime && A.cancel &&
    NativeMediaStream && streamAddTrack && trackKind && trackState)

  // --- private channel (see src/content/bridge.js)
  let port = null
  const post = (msg) => {
    if (port) apply(dispatch, port, [new NativeCustomEvent(TO_EXT, { __proto__: null, detail: msg })])
  }
  function onHandshake(ev) {
    unlisten(window, HANDSHAKE, onHandshake, true)
    const node = apply(relatedTargetOf, ev, [])
    // Fail closed: the genuine handshake comes at document_start, before the page has any
    // <script>. One arriving later could only come from page code.
    if (port || !node || apply(scriptsOf, document, []).length) return
    port = node
    listen(port, TO_PAGE, (e) => {
      const m = apply(detailOf, e, [])
      if (m && typeof m === "object") handle(m)
    })
  }
  listen(window, HANDSHAKE, onHandshake, true)

  const remote = new NativeMap() // track -> its "ended" listener
  const mic = new NativeMap()
  const peers = new NativeSet()
  let rec = null // { id, ctx, dest, micGain, micLevel, recorder, sources: Map<track, node>, includeMic, seq, mime, paused, unkick, queue... }
  let micOn = false // follows the call app's own mute button; closed until the content script says unmuted

  const kindOf = (t) => { try { return call(trackKind, t) } catch { return "" } }
  const stateOf = (t) => { try { return call(trackState, t) } catch { return "ended" } }

  function attach(track) {
    if (!rec || call(map.has, rec.sources, track) || stateOf(track) === "ended") return
    const isMic = call(map.has, mic, track)
    if (isMic && !rec.includeMic) return
    try {
      const stream = new NativeMediaStream()
      call(streamAddTrack, stream, track)
      const node = call(A.source, rec.ctx, stream)
      call(A.connect, node, isMic ? rec.micGain : rec.dest)
      call(map.set, rec.sources, track, node)
    } catch (e) {
      post({ type: "log", id: rec.id, message: "attach failed: " + String(e && e.name) })
    }
  }

  function detach(track) {
    const node = rec && call(map.get, rec.sources, track)
    if (node) {
      try { call(A.disconnect, node) } catch {}
      call(map.delete, rec.sources, track)
    }
  }

  function forget(track, from) {
    const onEnded = call(map.get, from, track)
    if (!onEnded) return
    call(map.delete, from, track)
    try { unlisten(track, "ended", onEnded) } catch {}
    detach(track)
  }

  function addTrack(track, to) {
    if (!track || kindOf(track) !== "audio" || call(map.has, to, track) || stateOf(track) === "ended") return
    const onEnded = (ev) => { if (trusted(ev)) forget(track, to) }
    call(map.set, to, track, onEnded)
    try { listen(track, "ended", onEnded) } catch {}
    attach(track)
  }

  // A local pc.close() or track.stop() fires no event: drop them by their state.
  function prune() {
    call(set.forEach, peers, (pc) => {
      let closed = true
      try { closed = call(pcConnState, pc) === "closed" || call(pcSigState, pc) === "closed" } catch {}
      if (closed) call(set.delete, peers, pc)
    })
    call(map.forEach, remote, (_, track) => { if (stateOf(track) === "ended") forget(track, remote) })
    call(map.forEach, mic, (_, track) => { if (stateOf(track) === "ended") forget(track, mic) })
  }

  // --- capture remote tracks from every peer connection the app creates
  if (NativePC) {
    const watch = (pc) => {
      call(set.add, peers, pc)
      listen(pc, "track", (ev) => {
        if (!trusted(ev) || !trackEventTrack) return
        addTrack(call(trackEventTrack, ev), remote)
      })
      listen(pc, "connectionstatechange", (ev) => {
        if (trusted(ev) && call(pcConnState, pc) === "closed") call(set.delete, peers, pc)
      })
    }
    const Wrapped = new Proxy(NativePC, {
      __proto__: null, // no traps inherited from a patched Object.prototype
      construct(target, args, newTarget) {
        const pc = construct(target, args, newTarget)
        try { watch(pc) } catch {}
        return pc
      },
    })
    window.RTCPeerConnection = Wrapped
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Wrapped
  }

  // --- capture the microphone the app opens
  const md = navigator.mediaDevices
  const nativeGUM = md && md.getUserMedia
  if (nativeGUM) {
    const onStream = (stream) => {
      try {
        const tracks = call(streamAudioTracks, stream)
        for (let i = 0; i < tracks.length; i++) addTrack(tracks[i], mic)
      } catch {}
      return stream
    }
    md.getUserMedia = function (constraints) {
      const p = call(nativeGUM, md, constraints)
      try { settle(call(promiseThen, p, onStream)) } catch {}
      return p
    }
  }

  function sweepPeers() {
    if (!pcReceivers || !receiverTrack) return
    call(set.forEach, peers, (pc) => {
      try {
        const rs = call(pcReceivers, pc)
        for (let i = 0; i < rs.length; i++) {
          const t = call(receiverTrack, rs[i])
          if (t && stateOf(t) === "live") addTrack(t, remote)
        }
      } catch {}
    })
  }

  function attachAll() {
    call(map.forEach, remote, (_, t) => attach(t))
    call(map.forEach, mic, (_, t) => attach(t))
  }

  // Mic gain follows the gate. Closing is immediate; opening ramps in over ~20 ms.
  function setMicLevel() {
    if (!rec) return
    const level = micOn && rec.includeMic ? 1 : 0
    if (rec.micLevel === level) return
    rec.micLevel = level
    const g = rec.micParam
    try {
      const t = call(A.time, rec.ctx)
      call(A.cancel, g, t)
      if (level) call(A.setTargetAtTime, g, 1, t, 0.02)
      else call(A.setValueAtTime, g, 0, t)
    } catch {
      try { call(A.setValue, g, level) } catch {}
    }
  }

  function teardown(state) {
    if (state.unkick) {
      try { state.unkick() } catch {}
      state.unkick = null
    }
    call(map.forEach, state.sources, (n) => { try { call(A.disconnect, n) } catch {} })
    call(map.clear, state.sources)
    if (state.ctx) {
      try { settle(call(A.close, state.ctx)) } catch {}
    }
  }

  // Chunks are read and posted strictly in order, 'stopped' after the last one. A FileReader of
  // our own (captured methods, trusted events only) reads each Blob: no promise chain that a
  // patched Promise.prototype could observe or stall.
  function enqueue(state, item) {
    call(map.set, state.queue, state.tail++, item)
    pump(state)
  }
  function pump(state) {
    while (!state.busy && call(map.has, state.queue, state.head)) {
      const item = call(map.get, state.queue, state.head)
      call(map.delete, state.queue, state.head++)
      if (item.stop) {
        post({ type: "stopped", id: state.id })
        continue
      }
      let reader
      try {
        reader = new NativeFileReader()
      } catch {
        continue
      }
      let done = false
      const finish = (ev, ok) => {
        if (done || !trusted(ev)) return
        done = true
        state.busy = false
        if (ok) {
          let buf = null
          try { buf = call(readerResult, reader) } catch {}
          if (buf) post({ type: "chunk", id: state.id, seq: item.seq, mime: state.mime, buf })
        }
        pump(state)
      }
      listen(reader, "load", (ev) => finish(ev, true))
      listen(reader, "error", (ev) => finish(ev, false))
      listen(reader, "abort", (ev) => finish(ev, false))
      state.busy = true
      try {
        call(readAsArrayBuffer, reader, item.blob)
      } catch {
        state.busy = false
      }
    }
  }

  function start(id, includeMic) {
    if (rec && rec.id === id) return
    if (rec) stop(rec.id)
    prune()
    const state = {
      __proto__: null, id, ctx: null, dest: null, micGain: null, micParam: null, micLevel: -1, recorder: null,
      sources: new NativeMap(), includeMic, seq: 0, mime: "", paused: false, unkick: null,
      queue: new NativeMap(), head: 0, tail: 0, busy: false,
    }
    try {
      if (!canRecord) throw new Error("audio recording is not available in this browser")
      const ctx = (state.ctx = new NativeAudioContext({ __proto__: null, sampleRate: 48000 }))
      // Autoplay policy can leave the graph suspended until the user interacts with the page.
      if (call(A.state, ctx) !== "running") {
        const resumed = () => { if (call(A.state, ctx) === "running") unkick() }
        const kick = () => {
          try { call(promiseThen, call(A.resume, ctx), resumed, noop) } catch {}
        }
        const unkick = () => {
          unlisten(document, "pointerdown", kick, true)
          unlisten(document, "keydown", kick, true)
        }
        listen(document, "pointerdown", kick, true)
        listen(document, "keydown", kick, true)
        state.unkick = unkick
        try { settle(call(A.resume, ctx)) } catch {}
      }
      state.dest = call(A.dest, ctx)
      // A silent constant keeps the recording continuous even before anyone speaks.
      const keepAlive = call(A.constant, ctx)
      call(A.setValue, call(A.offset, keepAlive), 0)
      call(A.connect, keepAlive, state.dest)
      call(A.startSource, keepAlive)
      state.micGain = call(A.gain, ctx)
      state.micParam = call(A.gainParam, state.micGain)
      call(A.setValue, state.micParam, 0)
      call(A.connect, state.micGain, state.dest)
      const mimes = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]
      for (let i = 0; i < mimes.length && !state.mime; i++) if (call(isTypeSupported, NativeMediaRecorder, mimes[i])) state.mime = mimes[i]
      state.recorder = new NativeMediaRecorder(call(A.stream, state.dest), { __proto__: null, mimeType: state.mime, audioBitsPerSecond: 48000 })
    } catch (e) {
      teardown(state)
      post({ type: "error", id, message: String((e && e.message) || e) })
      return
    }
    const recorder = state.recorder
    listen(recorder, "dataavailable", (ev) => {
      if (!trusted(ev)) return
      const blob = call(blobDataOf, ev)
      if (!blob || !call(blobSize, blob)) return
      enqueue(state, { __proto__: null, blob, seq: state.seq++, stop: false })
    })
    listen(recorder, "stop", (ev) => {
      if (trusted(ev)) enqueue(state, { __proto__: null, blob: null, seq: -1, stop: true })
    })
    rec = state
    setMicLevel()
    sweepPeers()
    attachAll()
    try {
      call(R.start, recorder, CHUNK_MS)
    } catch (e) {
      rec = null
      teardown(state)
      post({ type: "error", id, message: String((e && e.message) || e) })
      return
    }
    post({ type: "started", id, mime: state.mime, remote: call(map.size, remote), mic: call(map.size, mic), state: call(A.state, state.ctx) })
  }

  function stop(id) {
    if (!rec || rec.id !== id) return post({ type: "stopped", id })
    const r = rec
    rec = null
    if (r.unkick) {
      try { r.unkick() } catch {}
      r.unkick = null
    }
    try {
      if (call(R.state, r.recorder) !== "inactive") call(R.stop, r.recorder)
      else enqueue(r, { __proto__: null, blob: null, seq: -1, stop: true })
    } catch {
      enqueue(r, { __proto__: null, blob: null, seq: -1, stop: true })
    }
    // Let the final dataavailable fire before closing the graph.
    later(() => teardown(r), 1000)
  }

  function pause(id, on) {
    if (!rec || rec.id !== id) return
    try {
      const st = call(R.state, rec.recorder)
      if (on && st === "recording") call(R.pause, rec.recorder)
      else if (!on && st === "paused") call(R.resume, rec.recorder)
      rec.paused = on
      post({ type: on ? "paused" : "resumed", id })
    } catch (e) {
      post({ type: "log", id, message: "pause/resume failed: " + String(e && e.name) })
    }
  }

  function configure(id, includeMic) {
    if (!rec || rec.id !== id) return
    rec.includeMic = includeMic
    if (includeMic) call(map.forEach, mic, (_, t) => attach(t))
    else call(map.forEach, mic, (_, t) => detach(t))
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
        type: "status", recording: Boolean(rec), id: rec ? rec.id : null, paused: Boolean(rec && rec.paused), state: rec ? call(A.state, rec.ctx) : null,
        remote: call(map.size, remote), mic: call(map.size, mic), peers: call(set.size, peers), sources: rec ? call(map.size, rec.sources) : 0,
        micOn, includeMic: rec ? rec.includeMic : null, micGain: rec ? rec.micLevel : null,
      })
    }
  }

  // Tracks that appear mid-call (new participants, mic switches); drop closed ones.
  call(setRepeat, window, () => {
    prune()
    if (rec) {
      sweepPeers()
      attachAll()
    }
  }, 3000)
})()
