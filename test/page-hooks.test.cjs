// src/page/render-keepalive.js and src/page/meet-channels.js in a fake page: private channel
// only, no page-visible globals, no rAF bookkeeping outside calls.
const test = require("node:test")
const assert = require("node:assert/strict")
const { createPage } = require("./helpers/page-env.cjs")

const of = (p, type) => p.fromPage.filter((m) => m.type === type)

function keepalive() {
  const p = createPage()
  const native = p.win.requestAnimationFrame
  p.load("src/page/render-keepalive.js")
  p.connect()
  return { p, native }
}

test("render keepalive: no writable __csRafFallbacks global (security M4)", () => {
  const { p } = keepalive()
  assert.equal("__csRafFallbacks" in p.win, false)
})

test("render keepalive: outside a call rAF goes straight to the native one, nothing is tracked", () => {
  const { p } = keepalive()
  const cb = () => {}
  const id = p.win.requestAnimationFrame(cb)
  assert.equal(p.rafs.get(id), cb, "the page's own callback must be handed to the native rAF unwrapped")
  p.win.cancelAnimationFrame(id)
  assert.equal(p.rafs.size, 0)
  assert.equal(p.timers.size, 0, "no fallback timers outside a call")
})

test("render keepalive: a frame requested in a hidden tab before the call is run once the call starts", () => {
  const { p } = keepalive()
  p.doc._visibility = "hidden"
  let ran = 0
  p.win.requestAnimationFrame(() => ran++)
  p.advance(1000)
  assert.equal(ran, 0, "no fallback outside a call")
  assert.equal(p.timers.size, 0, "no timers outside a call")
  p.toPage({ type: "render-keepalive", on: true })
  p.advance(600)
  assert.equal(ran, 1)
})

test("render keepalive: in a call a stalled frame runs from the fallback; the counter is read over the channel", () => {
  const { p } = keepalive()
  p.toPage({ type: "render-keepalive", on: true })
  let ran = 0
  p.win.requestAnimationFrame(() => ran++)
  p.advance(600)
  assert.equal(ran, 1)
  p.frame() // a real frame later must not run it again
  assert.equal(ran, 1)
  p.toPage({ type: "keepalive-status" })
  const st = of(p, "keepalive-status").at(-1)
  assert.equal(st.active, true)
  assert.equal(st.fallbacks, 1)
})

test("render keepalive: a real frame wins and cancels the fallback", () => {
  const { p } = keepalive()
  p.toPage({ type: "render-keepalive", on: true })
  let ran = 0
  p.win.requestAnimationFrame(() => ran++)
  p.frame()
  p.advance(600)
  assert.equal(ran, 1)
  p.toPage({ type: "keepalive-status" })
  assert.equal(of(p, "keepalive-status").at(-1).fallbacks, 0)
})

test("render keepalive: cancelAnimationFrame cancels wrapped frames", () => {
  const { p } = keepalive()
  p.toPage({ type: "render-keepalive", on: true })
  let ran = 0
  const id = p.win.requestAnimationFrame(() => ran++)
  p.win.cancelAnimationFrame(id)
  p.advance(600)
  p.frame()
  assert.equal(ran, 0)
  p.win.requestAnimationFrame(() => ran++) // control: the keepalive is really on
  p.advance(600)
  assert.equal(ran, 1)
})

test("render keepalive: turning it off clears fallback timers that were already armed", () => {
  const { p } = keepalive()
  p.toPage({ type: "render-keepalive", on: true })
  let ran = 0
  p.win.requestAnimationFrame(() => ran++)
  p.advance(600)
  assert.equal(ran, 1, "control: the keepalive is on")
  ran = 0
  p.win.requestAnimationFrame(() => ran++)
  p.toPage({ type: "render-keepalive", on: false })
  p.advance(1000)
  assert.equal(ran, 0, "an armed fallback fired after the call ended")
  p.frame() // the native frame still runs when the tab is drawn
  assert.equal(ran, 1)
})

test("render keepalive: window messages can't switch it on (security M3)", async () => {
  const { p } = keepalive()
  p.win.postMessage({ __callscribe: "ext", type: "render-keepalive", on: true })
  await p.flush()
  let ran = 0
  p.win.requestAnimationFrame(() => ran++)
  p.advance(1000)
  assert.equal(ran, 0)
  p.toPage({ type: "render-keepalive", on: true }) // control: the private channel does switch it on
  p.win.requestAnimationFrame(() => ran++)
  p.advance(1000)
  assert.equal(ran, 1)
})

function meet() {
  const p = createPage()
  p.win.location.hostname = "meet.google.com"
  p.load("src/page/meet-channels.js")
  p.connect()
  return p
}

test("meet channels: caption traffic goes over the private channel, never window.postMessage", async () => {
  const p = meet()
  const pc = new p.win.RTCPeerConnection()
  const ch = pc.createDataChannel("captions_v2")
  p.fire(ch, new p.MessageEvent("message", { data: new Uint8Array([1, 2, 3]).buffer }))
  await p.flush()
  assert.equal(p.posted.length, 0)
  const m = of(p, "dc-msg")[0]
  assert.equal(m.label, "captions_v2")
  assert.deepEqual([...new Uint8Array(m.buf)], [1, 2, 3])
})

test("meet channels: dc-send only from the channel; window dc-send is ignored (security M3)", async () => {
  const p = meet()
  const pc = new p.win.RTCPeerConnection()
  const ch = pc.createDataChannel("captions_v2")
  p.win.postMessage({ __callscribe: "ext", type: "dc-send", label: "captions_v2", buf: new Uint8Array([6]).buffer })
  await p.flush()
  assert.equal(ch.sent.length, 0)
  p.toPage({ type: "dc-send", label: "captions_v2", buf: new Uint8Array([8]).buffer })
  assert.equal(ch.sent.length, 1)
  const sent = of(p, "dc-sent")[0]
  assert.equal(sent.label, "captions_v2")
  assert.equal(sent.ok, true)
})

test("meet channels: dc-hello reports open channels over the channel", () => {
  const p = meet()
  const pc = new p.win.RTCPeerConnection()
  pc.createDataChannel("collections")
  p.fromPage.length = 0
  p.toPage({ type: "dc-hello" })
  assert.deepEqual(of(p, "dc-open").map((m) => m.label), ["collections"])
})

// --- Task 1 review I2: page code holding Meet's data channel (it can always get it, e.g. by
// wrapping createDataChannel after us) must not be able to inject caption frames.
test("meet channels: message/open/close events dispatched by page code are ignored (I2)", async () => {
  const p = meet()
  const pc = new p.win.RTCPeerConnection()
  const ch = pc.createDataChannel("captions_v2")
  p.fromPage.length = 0
  ch.dispatchEvent(new p.MessageEvent("message", { data: new Uint8Array([6, 6, 6]).buffer }))
  const plain = new Event("message")
  plain.data = new Uint8Array([7]).buffer
  ch.dispatchEvent(plain)
  ch.dispatchEvent(new Event("open"))
  ch.dispatchEvent(new Event("close"))
  await p.flush()
  assert.deepEqual(p.fromPage, [], "forged channel events were forwarded")
  p.fire(ch, new p.MessageEvent("message", { data: new Uint8Array([1]).buffer })) // control
  await p.flush()
  assert.deepEqual(of(p, "dc-msg").map((m) => [...new Uint8Array(m.buf)]), [[1]])
})

test("meet channels: a forged datachannel event can't plant a channel; Meet's real one is tapped (I2)", async () => {
  const p = meet()
  const pc = new p.win.RTCPeerConnection()
  pc.createDataChannel("other") // registers the datachannel listener on this connection
  const planted = new p.win.RTCDataChannel("captions_v2")
  pc.dispatchEvent(new p.win.RTCDataChannelEvent("datachannel", { channel: planted }))
  p.fire(planted, new p.MessageEvent("message", { data: new Uint8Array([6]).buffer }))
  await p.flush()
  assert.equal(of(p, "dc-msg").length, 0, "a channel handed over by a forged datachannel event was tapped")
  const real = pc.remoteChannel("collections") // control
  p.fire(real, new p.MessageEvent("message", { data: new Uint8Array([2]).buffer }))
  await p.flush()
  assert.deepEqual(of(p, "dc-msg").map((m) => m.label), ["collections"])
})

test("meet channels: patched MessageEvent/RTCDataChannel/Date built-ins can't change what is forwarded (I2)", async () => {
  const p = meet()
  const w = p.win
  const pc = new w.RTCPeerConnection()
  const ch = pc.createDataChannel("captions_v2")
  const hits = []
  const undo = []
  const patch = (proto, key, get) => {
    const d = Object.getOwnPropertyDescriptor(proto, key)
    Object.defineProperty(proto, key, { ...d, get() { hits.push(key); return get.call(this, d.get) } })
    undo.push(() => Object.defineProperty(proto, key, d))
  }
  patch(w.MessageEvent.prototype, "data", () => new Uint8Array([6, 6, 6]).buffer) // forged frame for a real event
  patch(w.RTCDataChannel.prototype, "label", () => "captions_v2")
  patch(w.RTCDataChannel.prototype, "readyState", () => "open")
  const send = w.RTCDataChannel.prototype.send
  w.RTCDataChannel.prototype.send = function (d) { hits.push("send"); return send.call(this, d) }
  undo.push(() => { w.RTCDataChannel.prototype.send = send })
  const now = Date.now
  Date.now = () => 1
  undo.push(() => { Date.now = now })
  try {
    p.fire(ch, new p.MessageEvent("message", { data: new Uint8Array([3, 4]).buffer }))
    p.toPage({ type: "dc-send", label: "captions_v2", buf: new Uint8Array([8]).buffer })
    p.toPage({ type: "dc-hello" })
    const late = pc.remoteChannel("collections")
    p.fire(late, new p.MessageEvent("message", { data: new Uint8Array([5]).buffer }))
    await p.flush()
  } finally {
    undo.forEach((f) => f())
  }
  assert.deepEqual(hits, [], "page-patched built-ins were called")
  const msgs = of(p, "dc-msg").filter((m) => m.dir === "in")
  assert.deepEqual(msgs.map((m) => [m.label, [...new Uint8Array(m.buf)]]), [["captions_v2", [3, 4]], ["collections", [5]]])
  assert.ok(msgs.every((m) => m.t > 1), "timestamps came from a patched Date.now")
  assert.equal(ch.sent.length, 1)
})
