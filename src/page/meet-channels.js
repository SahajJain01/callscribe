// Runs in Google Meet's own JS world at document_start, before Meet creates its WebRTC
// connection. Taps the two data channels that carry captions and participant names
// ("captions_v2", "collections") and forwards their raw messages to the content script, which
// decodes them (src/shared/meet-proto.js). The content script can ask to send a message on a
// channel; that's how it requests captions without the CC button (see meet-proto.js).
// Nothing Meet sends or receives is changed.
//
// Talks only over the private channel (src/content/bridge.js):
//   to the page:   dc-hello (report open channels) | dc-send {label, buf}
//   from the page: dc-open {label} | dc-close {label} | dc-msg {label, dir: "in"|"out", t, buf} | dc-sent {label, ok}
;(function () {
  "use strict"
  if (window.__callscribeMeetChannels) return
  Object.defineProperty(window, "__callscribeMeetChannels", { value: true })

  const HANDSHAKE = "__callscribe_bridge"
  const TO_PAGE = "__callscribe_to_page"
  const TO_EXT = "__callscribe_to_ext"
  const LABELS = new Set(["captions_v2", "collections"])
  const MAX_SEND = 64 * 1024

  // --- natives, captured before any page script can patch them
  const apply = Reflect.apply
  const addListener = EventTarget.prototype.addEventListener
  const removeListener = EventTarget.prototype.removeEventListener
  const dispatch = EventTarget.prototype.dispatchEvent
  const relatedTargetOf = Object.getOwnPropertyDescriptor(MouseEvent.prototype, "relatedTarget").get
  const detailOf = Object.getOwnPropertyDescriptor(CustomEvent.prototype, "detail").get
  const hasOwn = Object.prototype.hasOwnProperty
  const NativeCustomEvent = CustomEvent
  const own = (m, k) => (apply(hasOwn, m, [k]) ? m[k] : undefined)
  const scriptsOf = Object.getOwnPropertyDescriptor(Document.prototype, "scripts").get
  const blobArrayBuffer = Blob.prototype.arrayBuffer
  const sliceBuffer = ArrayBuffer.prototype.slice

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

  const channels = new Map() // label -> newest RTCDataChannel
  const tapped = new WeakSet()
  const pcs = new WeakSet()

  function forward(label, dir, data) {
    const t = Date.now()
    const emit = (buf) => post({ type: "dc-msg", label, dir, t, buf })
    if (data instanceof ArrayBuffer) emit(apply(sliceBuffer, data, [0]))
    else if (ArrayBuffer.isView(data)) emit(apply(sliceBuffer, data.buffer, [data.byteOffset, data.byteOffset + data.byteLength]))
    else if (data instanceof Blob) apply(blobArrayBuffer, data, []).then(emit, () => {})
  }

  function tap(ch) {
    if (!LABELS.has(ch.label) || tapped.has(ch)) return
    tapped.add(ch)
    const label = ch.label
    channels.set(label, ch)
    ch.addEventListener("message", (e) => forward(label, "in", e.data))
    ch.addEventListener("open", () => post({ type: "dc-open", label }))
    ch.addEventListener("close", () => {
      if (channels.get(label) === ch) channels.delete(label)
      post({ type: "dc-close", label })
    })
    // Watch Meet's own requests (CC on/off) so the content script knows the current state.
    const send = ch.send
    ch.send = function (data) {
      try { forward(label, "out", data) } catch {}
      return apply(send, this, arguments)
    }
    if (ch.readyState === "open") post({ type: "dc-open", label })
  }

  function handle(m) {
    const type = own(m, "type")
    if (type === "dc-hello") {
      // The content script loaded (possibly after the call started): report open channels.
      for (const [label, ch] of channels) if (ch.readyState === "open") post({ type: "dc-open", label })
      return
    }
    if (type !== "dc-send") return
    const label = own(m, "label")
    const buf = own(m, "buf")
    const ch = channels.get(label)
    let ok = false
    try {
      if (ch && ch.readyState === "open" && buf instanceof ArrayBuffer && buf.byteLength <= MAX_SEND) {
        ch.send(new Uint8Array(buf))
        ok = true
      }
    } catch {}
    post({ type: "dc-sent", label, ok })
  }

  const PC = window.RTCPeerConnection
  if (!PC || !PC.prototype.createDataChannel) return
  const create = PC.prototype.createDataChannel
  PC.prototype.createDataChannel = function () {
    const ch = apply(create, this, arguments)
    try {
      // "collections" is opened by the server, so listen on every connection Meet uses.
      if (!pcs.has(this)) {
        pcs.add(this)
        this.addEventListener("datachannel", (e) => tap(e.channel))
      }
      tap(ch)
    } catch {}
    return ch
  }
})()
