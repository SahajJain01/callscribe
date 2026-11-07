// A fake page for unit-testing the MAIN-world scripts (src/page/*.js) in Node's vm.
// It models only what those scripts touch: window events, timers, rAF, WebRTC peer
// connections and tracks, getUserMedia, Web Audio nodes and MediaRecorder.
// The test plays the extension's side of the private channel (src/content/bridge.js):
// connect() hands over a detached node with the bridge's handshake event, then
// toPage()/fromPage collect the traffic on that node.
const vm = require("node:vm")
const fs = require("node:fs")
const path = require("node:path")

const ROOT = path.join(__dirname, "../..")
const HANDSHAKE = "__callscribe_bridge"
const TO_PAGE = "__callscribe_to_page"
const TO_EXT = "__callscribe_to_ext"

class MouseEvent extends Event {
  constructor(type, init = {}) {
    super(type, init)
    this._related = init.relatedTarget || null
  }
  get relatedTarget() {
    return this._related
  }
}

class BlobEvent extends Event {
  constructor(type, init = {}) {
    super(type, init)
    this._data = init.data
  }
  get data() {
    return this._data
  }
}

function createPage(opts = {}) {
  // --- fake clock
  let now = 0
  let nextTimer = 1
  const timers = new Map() // id -> { at, fn, every }
  const setTimeout = (fn, ms) => { const id = nextTimer++; timers.set(id, { at: now + (ms || 0), fn }); return id }
  const clearTimeout = (id) => { timers.delete(id) }
  const setInterval = (fn, ms) => { const id = nextTimer++; timers.set(id, { at: now + ms, fn, every: ms }); return id }
  const clearInterval = clearTimeout
  function advance(ms) {
    const end = now + ms
    for (;;) {
      let first = null
      for (const [id, t] of timers) if (t.at <= end && (!first || t.at < first[1].at)) first = [id, t]
      if (!first) break
      const [id, t] = first
      now = t.at
      if (t.every) t.at += t.every
      else timers.delete(id)
      t.fn()
    }
    now = end
  }

  // --- rAF that never runs on its own (a tab that isn't drawn) unless the test calls frame()
  const rafs = new Map()
  let nextRaf = 1
  const nativeRAF = (cb) => { const id = nextRaf++; rafs.set(id, cb); return id }
  const nativeCancel = (id) => { rafs.delete(id) }
  function frame() {
    const due = [...rafs]
    rafs.clear()
    for (const [, cb] of due) cb(now)
  }

  // --- media
  const contexts = []
  const recorders = []
  class Track extends EventTarget {
    constructor(kind = "audio") {
      super()
      this.kind = kind
      this.readyState = "live"
      this.listeners = 0
    }
    addEventListener(type, fn, o) { if (type === "ended") this.listeners++; return super.addEventListener(type, fn, o) }
    removeEventListener(type, fn, o) { if (type === "ended") this.listeners--; return super.removeEventListener(type, fn, o) }
    stop() { this.readyState = "ended" } // like Chrome: a local stop() fires no "ended" event
  }
  class PeerConnection extends EventTarget {
    constructor() {
      super()
      this.connectionState = "new"
      this.signalingState = "stable"
      this.receivers = []
      this.channels = []
    }
    getReceivers() { return this.receivers }
    addRemoteTrack(track) {
      this.receivers.push({ track })
      const ev = new Event("track")
      ev.track = track
      this.dispatchEvent(ev)
    }
    close() { this.connectionState = "closed"; this.signalingState = "closed" } // no event, like Chrome
    createDataChannel(label) {
      const ch = new EventTarget()
      ch.label = label
      ch.readyState = "open"
      ch.sent = []
      ch.send = (d) => ch.sent.push(d)
      this.channels.push(ch)
      return ch
    }
  }
  class AudioNode {
    constructor(ctx) { this.ctx = ctx; this.out = new Set(); this.disconnected = false }
    connect(n) { this.out.add(n) }
    disconnect() { this.out.clear(); this.disconnected = true }
  }
  class AudioContext {
    constructor() {
      this.state = opts.ctxState || "running"
      this.currentTime = 0
      this.closed = false
      this.sources = []
      this.resumeCalls = 0
      contexts.push(this)
    }
    createMediaStreamDestination() { const n = new AudioNode(this); n.stream = { id: "mix" }; return n }
    createConstantSource() { const n = new AudioNode(this); n.offset = { value: 1 }; n.start = () => {}; return n }
    createGain() {
      const n = new AudioNode(this)
      n.gain = { value: 1, setTargetAtTime(v) { this.value = v }, setValueAtTime(v) { this.value = v } }
      return n
    }
    createMediaStreamSource(stream) { const n = new AudioNode(this); n.track = stream.tracks[0]; this.sources.push(n); return n }
    resume() {
      this.resumeCalls++
      if (opts.resumeRejects) return Promise.reject(new Error("resume refused"))
      return Promise.resolve()
    }
    close() { this.closed = true; this.state = "closed"; return Promise.resolve() }
  }
  class MediaStream {
    constructor(tracks) { this.tracks = tracks || [] }
    getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio") }
  }
  class MediaRecorder extends EventTarget {
    constructor(stream, o) {
      if (opts.recorderThrows) throw new Error("no recorder")
      super()
      this.stream = stream
      this.mimeType = o && o.mimeType
      this.state = "inactive"
      recorders.push(this)
    }
    static isTypeSupported(m) { return m === "audio/webm;codecs=opus" }
    start(ms) { this.state = "recording"; this.timeslice = ms }
    pause() { if (this.state === "recording") this.state = "paused" }
    resume() { if (this.state === "paused") this.state = "recording" }
    stop() {
      if (this.state === "inactive") return
      this.state = "inactive"
      this.emit(new Uint8Array([9, 9]))
      queueMicrotask(() => this.dispatchEvent(new Event("stop")))
    }
    emit(bytes) { this.dispatchEvent(new BlobEvent("dataavailable", { data: new Blob([bytes]) })) }
  }

  // --- window / document
  const win = new EventTarget()
  class Document extends EventTarget {
    get visibilityState() { return this._visibility || "visible" }
    get scripts() { return this._scripts || [] }
  }
  const doc = new Document()
  const posted = [] // anything sent with window.postMessage
  win.postMessage = (data) => {
    posted.push(data)
    const ev = new Event("message")
    Object.defineProperty(ev, "data", { value: data })
    Object.defineProperty(ev, "source", { value: globalProxy })
    queueMicrotask(() => win.dispatchEvent(ev))
  }
  const gumTracks = []
  const navigator = {
    mediaDevices: {
      async getUserMedia() {
        const t = new Track("audio")
        gumTracks.push(t)
        return new MediaStream([t])
      },
    },
  }
  Object.assign(win, {
    window: win, document: doc, navigator, location: { origin: "https://app.slack.com", hostname: "app.slack.com" },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, performance: { now: () => now },
    requestAnimationFrame: nativeRAF, cancelAnimationFrame: nativeCancel,
    Document, RTCPeerConnection: PeerConnection, AudioContext, MediaStream, MediaRecorder, Blob, BlobEvent,
    Event, EventTarget, CustomEvent, MouseEvent, Promise, Reflect, Object, Map, Set, WeakMap, WeakSet, Array, ArrayBuffer,
    Uint8Array, Number, String, Boolean, Error, Date, Math, JSON, console,
  })
  vm.createContext(win)
  // Inside the vm, `window` is the context's global proxy, not `win` itself.
  const globalProxy = vm.runInContext("globalThis", win)

  function load(file) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), win, { filename: file })
  }

  // --- the extension side of the private channel
  const fromPage = []
  let node = null
  function connect(target) {
    node = target || new EventTarget()
    node.addEventListener(TO_EXT, (e) => fromPage.push(e.detail))
    win.dispatchEvent(new MouseEvent(HANDSHAKE, { relatedTarget: node }))
    return node
  }
  function toPage(msg, via) {
    ;(via || node).dispatchEvent(new CustomEvent(TO_PAGE, { detail: msg }))
  }
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)) }

  return {
    win, doc, load, connect, toPage, fromPage, posted, advance, frame, flush, rafs, timers, contexts, recorders, gumTracks,
    Track, PeerConnection, MouseEvent, HANDSHAKE, TO_PAGE, TO_EXT,
    get now() { return now },
  }
}

module.exports = { createPage, HANDSHAKE, TO_PAGE, TO_EXT }
