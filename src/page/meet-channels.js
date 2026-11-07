// Runs in Google Meet's own JS world at document_start, before Meet creates its WebRTC
// connection. Taps the two data channels that carry captions and participant names
// ("captions_v2", "collections") and forwards their raw messages to the content script, which
// decodes them (src/shared/meet-proto.js). The content script can ask to send a message on a
// channel; that's how it requests captions without the CC button (see meet-proto.js).
// Nothing Meet sends or receives is changed.
;(function () {
  "use strict"
  if (window.__callscribeMeetChannels) return
  window.__callscribeMeetChannels = true

  const TAG = "__callscribe"
  const LABELS = new Set(["captions_v2", "collections"])
  const channels = new Map() // label -> newest RTCDataChannel
  const pcs = new WeakSet()

  const post = (msg, transfer) => window.postMessage({ [TAG]: "page", ...msg }, location.origin, transfer || [])

  function forward(label, dir, data) {
    const t = Date.now()
    const emit = (buf) => post({ type: "dc-msg", label, dir, t, buf }, [buf])
    if (data instanceof ArrayBuffer) emit(data.slice(0))
    else if (ArrayBuffer.isView(data)) emit(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
    else if (data instanceof Blob) data.arrayBuffer().then(emit, () => {})
  }

  function tap(ch) {
    if (!LABELS.has(ch.label) || ch.__callscribe) return
    ch.__callscribe = true
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
      return send.apply(this, arguments)
    }
    if (ch.readyState === "open") post({ type: "dc-open", label })
  }

  const PC = window.RTCPeerConnection
  if (!PC || !PC.prototype.createDataChannel) return
  const create = PC.prototype.createDataChannel
  PC.prototype.createDataChannel = function () {
    const ch = create.apply(this, arguments)
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

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || ev.data[TAG] !== "ext") return
    if (ev.data.type === "dc-hello") {
      // The content script loaded (possibly after the call started): report open channels.
      for (const [label, ch] of channels) if (ch.readyState === "open") post({ type: "dc-open", label })
      return
    }
    if (ev.data.type !== "dc-send") return
    const ch = channels.get(ev.data.label)
    let ok = false
    try {
      if (ch && ch.readyState === "open") {
        ch.send(new Uint8Array(ev.data.buf))
        ok = true
      }
    } catch {}
    post({ type: "dc-sent", label: ev.data.label, ok })
  })
})()
