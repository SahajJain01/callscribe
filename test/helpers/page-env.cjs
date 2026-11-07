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

// Events the fake browser fires carry this (module-private) mark; everything a test (playing
// the page) constructs and dispatches itself is untrusted, as in Chrome.
const TRUSTED = Symbol("trusted")
const blobArrayBuffer = Blob.prototype.arrayBuffer // the fake FileReader's own (native) reader
class FakeEvent extends Event {
  get isTrusted() { return this[TRUSTED] === true }
}

class MouseEvent extends Event {
  constructor(type, init = {}) {
    super(type, init)
    this._related = init.relatedTarget || null
  }
  get relatedTarget() {
    return this._related
  }
}

class BlobEvent extends FakeEvent {
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

  // --- media. Like Chrome, methods and accessors live on the prototypes (so a test can patch
  // them the way a page script would), and only events the "browser" fires are trusted.
  const contexts = []
  const recorders = []
  const fire = (target, ev) => { ev[TRUSTED] = true; return target.dispatchEvent(ev) }
  class Track extends EventTarget {
    constructor(kind = "audio") {
      super()
      this._kind = kind
      this._state = "live"
      this.listeners = 0
    }
    get kind() { return this._kind }
    get readyState() { return this._state }
    addEventListener(type, fn, o) { if (type === "ended") this.listeners++; return super.addEventListener(type, fn, o) }
    removeEventListener(type, fn, o) { if (type === "ended") this.listeners--; return super.removeEventListener(type, fn, o) }
    stop() { this._state = "ended" } // like Chrome: a local stop() fires no "ended" event
    end() { this._state = "ended"; fire(this, new FakeEvent("ended")) } // the remote side went away
  }
  class RTCRtpReceiver {
    constructor(track) { this._track = track }
    get track() { return this._track }
  }
  class RTCTrackEvent extends FakeEvent {
    constructor(type, init = {}) { super(type, init); this._track = init.track }
    get track() { return this._track }
  }
  class MessageEvent extends FakeEvent {
    constructor(type, init = {}) { super(type, init); this._data = init.data }
    get data() { return this._data }
  }
  class RTCDataChannelEvent extends FakeEvent {
    constructor(type, init = {}) { super(type, init); this._channel = init.channel }
    get channel() { return this._channel }
  }
  class RTCDataChannel extends EventTarget {
    constructor(label) {
      super()
      this._label = label
      this._state = "open"
      this.sent = []
    }
    get label() { return this._label }
    get readyState() { return this._state }
    send(d) { this.sent.push(d) }
  }
  class PeerConnection extends EventTarget {
    constructor() {
      super()
      this._conn = "new"
      this._sig = "stable"
      this.receivers = []
      this.channels = []
    }
    get connectionState() { return this._conn }
    get signalingState() { return this._sig }
    getReceivers() { return this.receivers.slice() }
    addRemoteTrack(track) {
      this.receivers.push(new RTCRtpReceiver(track))
      fire(this, new RTCTrackEvent("track", { track }))
    }
    close() { this._conn = "closed"; this._sig = "closed" } // no event, like Chrome
    createDataChannel(label) {
      const ch = new RTCDataChannel(label)
      this.channels.push(ch)
      return ch
    }
    remoteChannel(label) { // a channel the other side opened
      const ch = new RTCDataChannel(label)
      fire(this, new RTCDataChannelEvent("datachannel", { channel: ch }))
      return ch
    }
  }
  class AudioParam {
    constructor(v) { this._v = v }
    get value() { return this._v }
    set value(v) { this._v = v }
    setValueAtTime(v) { this._v = v }
    setTargetAtTime(v) { this._v = v }
    cancelScheduledValues() {}
  }
  class AudioNode {
    constructor(ctx) { this.ctx = ctx; this.out = []; this.disconnected = false }
    connect(n) { this.out.push(n); return n }
    disconnect() { this.out = []; this.disconnected = true }
  }
  class GainNode extends AudioNode {
    constructor(ctx) { super(ctx); this._gain = new AudioParam(1) }
    get gain() { return this._gain }
  }
  class ConstantSourceNode extends AudioNode {
    constructor(ctx) { super(ctx); this._offset = new AudioParam(1); this.started = false }
    get offset() { return this._offset }
    start() { this.started = true }
  }
  class MediaStreamAudioDestinationNode extends AudioNode {
    constructor(ctx) { super(ctx); this._stream = new MediaStream() }
    get stream() { return this._stream }
  }
  class MediaStreamAudioSourceNode extends AudioNode {}
  class AudioContext {
    constructor() {
      this._state = opts.ctxState || "running"
      this.closed = false
      this.sources = []
      this.gains = []
      this.resumeCalls = 0
      contexts.push(this)
    }
    get state() { return this._state }
    get currentTime() { return 0 }
    createMediaStreamDestination() { return (this.dest = new MediaStreamAudioDestinationNode(this)) }
    createConstantSource() { return new ConstantSourceNode(this) }
    createGain() { const n = new GainNode(this); this.gains.push(n); return n }
    createMediaStreamSource(stream) { const n = new MediaStreamAudioSourceNode(this); n.track = stream.tracks[0]; this.sources.push(n); return n }
    resume() {
      this.resumeCalls++
      if (opts.resumeRejects) return Promise.reject(new Error("resume refused"))
      return Promise.resolve()
    }
    close() { this.closed = true; this._state = "closed"; return Promise.resolve() }
  }
  class MediaStream {
    constructor(tracks) { this.tracks = tracks ? [...tracks] : [] }
    addTrack(t) { this.tracks.push(t) }
    getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio") }
  }
  class MediaRecorder extends EventTarget {
    constructor(stream, o) {
      if (opts.recorderThrows) throw new Error("no recorder")
      super()
      this.stream = stream
      this.mimeType = o && o.mimeType
      this._state = "inactive"
      recorders.push(this)
    }
    static isTypeSupported(m) { return m === "audio/webm;codecs=opus" }
    get state() { return this._state }
    start(ms) { this._state = "recording"; this.timeslice = ms }
    pause() { if (this._state === "recording") this._state = "paused" }
    resume() { if (this._state === "paused") this._state = "recording" }
    stop() {
      if (this._state === "inactive") return
      this._state = "inactive"
      this.emit(new Uint8Array([9, 9]))
      queueMicrotask(() => fire(this, new FakeEvent("stop")))
    }
    emit(bytes) { fire(this, new BlobEvent("dataavailable", { data: new Blob([bytes], { type: "audio/webm" }) })) }
  }
  class FileReader extends EventTarget {
    constructor() { super(); this._result = null }
    get result() { return this._result }
    readAsArrayBuffer(blob) {
      if (!(blob instanceof Blob)) throw new TypeError("not a Blob")
      blobArrayBuffer.call(blob).then((buf) => { this._result = buf; fire(this, new FakeEvent("load")) })
    }
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
    Document, RTCPeerConnection: PeerConnection, RTCRtpReceiver, RTCTrackEvent, RTCDataChannel, RTCDataChannelEvent, MessageEvent,
    AudioContext, AudioNode, AudioParam, GainNode, ConstantSourceNode, MediaStreamAudioDestinationNode, MediaStreamAudioSourceNode,
    MediaStream, MediaStreamTrack: Track, MediaRecorder, FileReader, Blob, BlobEvent,
    Event, EventTarget, CustomEvent, MouseEvent, Promise, Reflect, Object, Map, Set, WeakMap, WeakSet, Array, ArrayBuffer, DataView,
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
    Track, PeerConnection, MouseEvent, MessageEvent, BlobEvent, FakeEvent, fire, HANDSHAKE, TO_PAGE, TO_EXT,
    get now() { return now },
  }
}

module.exports = { createPage, HANDSHAKE, TO_PAGE, TO_EXT }
