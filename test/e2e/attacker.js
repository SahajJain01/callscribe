// Hostile page script for the e2e fixtures. The test servers inline it as the FIRST <script>
// in <head>, so it is the earliest page code there can be. It tries to obtain CallScribe's
// private page<->extension channel, read the recording and captions going over it, and forge
// extension<->MAIN-world messages (audio chunks, captions, stop, mic on, keepalive, dc-send).
// Everything it manages to see is counted in window.__atk; the e2e asserts it all stays zero
// and that the forged messages change nothing. window.__attack(id) re-runs the forgeries,
// with a session id the harness hands it (as if it had leaked).
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
    offer()
  }
  window.__attack = (id) => {
    try { forge(id) } catch (e) { atk.errors.push("forge: " + e) }
    return atk.forged
  }
  // Keep at it on its own too: the keepalive-off and mic-on forgeries must lose every time.
  setInterval(() => { try { forge(null) } catch (e) { atk.errors.push("forge: " + e) } }, 700)
})()
