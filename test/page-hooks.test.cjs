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
  const ev = new Event("message")
  ev.data = new Uint8Array([1, 2, 3]).buffer
  ch.dispatchEvent(ev)
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
