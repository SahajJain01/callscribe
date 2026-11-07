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
  const isLabel = (l) => l === "captions_v2" || l === "collections"
  const MAX_SEND = 64 * 1024

  // --- natives, captured before any page script can patch them. Only these are called, so a
  // page script that patches RTCDataChannel/MessageEvent/Map prototypes sees none of our calls
  // and can't change what we read. Data-channel events are forwarded only when the browser fired
  // them (isTrusted, an unforgeable own property): dispatchEvent(new MessageEvent(...)) from
  // page code on Meet's channel changes nothing.
  // What a page script can still do: open a real data channel of its own with one of these
  // labels and send real messages on it; we can't tell that from Meet's own channel.
  const apply = Reflect.apply
  const getOwn = Object.getOwnPropertyDescriptor
  const getProto = Object.getPrototypeOf
  const call = (fn, self, ...args) => apply(fn, self, args)
  function member(C, key, kind) {
    for (let o = C && C.prototype; o; o = getProto(o)) {
      const d = getOwn(o, key)
      if (d) return kind === "get" ? d.get : kind === "set" ? d.set : d.value
    }
  }
  const addListener = EventTarget.prototype.addEventListener
  const removeListener = EventTarget.prototype.removeEventListener
  const dispatch = EventTarget.prototype.dispatchEvent
  const listen = (target, type, fn) => call(addListener, target, type, fn)
  const trusted = (ev) => Boolean(ev) && ev.isTrusted === true
  const relatedTargetOf = member(MouseEvent, "relatedTarget", "get")
  const detailOf = member(CustomEvent, "detail", "get")
  const hasOwn = Object.prototype.hasOwnProperty
  const NativeCustomEvent = CustomEvent
  const own = (m, k) => (apply(hasOwn, m, [k]) ? m[k] : undefined)
  const scriptsOf = member(Document, "scripts", "get")
  const now = Date.now
  const NativeUint8Array = Uint8Array
  const blobArrayBuffer = Blob.prototype.arrayBuffer
  const promiseThen = Promise.prototype.then
  const sliceBuffer = ArrayBuffer.prototype.slice
  const bufferLength = member(ArrayBuffer, "byteLength", "get")
  const isView = ArrayBuffer.isView
  const TypedArray = getProto(Uint8Array)
  const view = { buffer: member(TypedArray, "buffer", "get"), offset: member(TypedArray, "byteOffset", "get"), length: member(TypedArray, "byteLength", "get") }
  const dataView = { buffer: member(DataView, "buffer", "get"), offset: member(DataView, "byteOffset", "get"), length: member(DataView, "byteLength", "get") }
  const map = { get: Map.prototype.get, set: Map.prototype.set, delete: Map.prototype.delete, forEach: Map.prototype.forEach }
  const weak = { has: WeakSet.prototype.has, add: WeakSet.prototype.add }
  const NativeMap = Map
  const NativeWeakSet = WeakSet
  const DC = window.RTCDataChannel
  const dcLabel = member(DC, "label", "get")
  const dcState = member(DC, "readyState", "get")
  const dcSend = member(DC, "send")
  const messageData = member(window.MessageEvent, "data", "get")
  const channelOf = member(window.RTCDataChannelEvent, "channel", "get")
  const NativeBlob = Blob

  // --- private channel (see src/content/bridge.js)
  let port = null
  const post = (msg) => {
    if (port) apply(dispatch, port, [new NativeCustomEvent(TO_EXT, { __proto__: null, detail: msg })])
  }
  function onHandshake(ev) {
    call(removeListener, window, HANDSHAKE, onHandshake, true)
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
  call(addListener, window, HANDSHAKE, onHandshake, true)

  const channels = new NativeMap() // label -> newest RTCDataChannel
  const tapped = new NativeWeakSet()
  const pcs = new NativeWeakSet()
  const labelOf = (ch) => { try { return call(dcLabel, ch) } catch { return "" } }
  const isOpen = (ch) => { try { return call(dcState, ch) === "open" } catch { return false } }

  // A copy of the message bytes, read only through captured accessors.
  function forward(label, dir, data) {
    const t = now()
    const emit = (buf) => post({ type: "dc-msg", label, dir, t, buf })
    if (isView(data)) {
      let v = view
      try { call(view.buffer, data) } catch { v = dataView }
      try {
        const off = call(v.offset, data)
        emit(call(sliceBuffer, call(v.buffer, data), off, off + call(v.length, data)))
      } catch {}
      return
    }
    try {
      call(bufferLength, data) // throws unless data is a real ArrayBuffer
      emit(call(sliceBuffer, data, 0))
      return
    } catch {}
    if (data instanceof NativeBlob) {
      try { call(promiseThen, call(blobArrayBuffer, data), emit, () => {}) } catch {}
    }
  }

  function tap(ch) {
    const label = labelOf(ch)
    if (!isLabel(label) || call(weak.has, tapped, ch)) return
    call(weak.add, tapped, ch)
    call(map.set, channels, label, ch)
    listen(ch, "message", (e) => {
      if (trusted(e)) forward(label, "in", call(messageData, e))
    })
    listen(ch, "open", (e) => {
      if (!trusted(e)) return
      call(map.set, channels, label, ch)
      post({ type: "dc-open", label })
    })
    listen(ch, "close", (e) => {
      if (!trusted(e)) return
      if (call(map.get, channels, label) === ch) call(map.delete, channels, label)
      post({ type: "dc-close", label })
    })
    // Watch Meet's own requests (CC on/off) so the content script knows the current state.
    // (Whatever goes through here is really sent on the channel.)
    ch.send = function (data) {
      try { forward(label, "out", data) } catch {}
      return apply(dcSend, this, arguments)
    }
    if (isOpen(ch)) post({ type: "dc-open", label })
  }

  function handle(m) {
    const type = own(m, "type")
    if (type === "dc-hello") {
      // The content script loaded (possibly after the call started): report open channels.
      call(map.forEach, channels, (ch, label) => { if (isOpen(ch)) post({ type: "dc-open", label }) })
      return
    }
    if (type !== "dc-send") return
    const label = own(m, "label")
    const buf = own(m, "buf")
    const ch = isLabel(label) ? call(map.get, channels, label) : undefined
    let ok = false
    try {
      if (ch && isOpen(ch) && call(bufferLength, buf) <= MAX_SEND) {
        call(dcSend, ch, new NativeUint8Array(buf))
        ok = true
      }
    } catch {}
    post({ type: "dc-sent", label, ok })
  }

  const PC = window.RTCPeerConnection
  if (!PC || !PC.prototype.createDataChannel || !DC || !dcLabel || !dcState || !dcSend || !messageData) return
  const create = PC.prototype.createDataChannel
  PC.prototype.createDataChannel = function () {
    const ch = apply(create, this, arguments)
    try {
      // "collections" is opened by the server, so listen on every connection Meet uses.
      if (!call(weak.has, pcs, this)) {
        call(weak.add, pcs, this)
        listen(this, "datachannel", (e) => {
          if (trusted(e) && channelOf) tap(call(channelOf, e))
        })
      }
      tap(ch)
    } catch {}
    return ch
  }
})()
