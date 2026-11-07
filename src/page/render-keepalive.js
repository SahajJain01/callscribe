// Runs in the page's own JS world at document_start (before the call app captures
// requestAnimationFrame).
//
// Why: Meet applies caption updates to the page from requestAnimationFrame callbacks.
// Chrome stops running rAF whenever the tab isn't being drawn: a background tab, a
// minimized or fully covered window, a Companion-mode tab left behind. visibilityState can
// even say "visible" while rAF is stalled. The caption DOM then freezes and the whole backlog
// is applied the moment the tab is drawn again, so every line looked like it arrived then
// (2026-11-05 Companion-mode call: 61 turns all stamped 01:02:25).
//
// Fix: while a call is being recorded, each requestAnimationFrame also arms a fallback timer.
// If the browser hasn't run the callback within FALLBACK_MS, the timer runs it (once). When
// the tab is drawn normally, real frames win and the timer is cancelled. Outside a call, in a
// visible tab, the page's callback goes straight to the native rAF: nothing is wrapped or
// tracked. Outside a call in a hidden tab, frames are tracked (no timers) so that a frame
// already stuck when the call starts can still be run; a stalled tab requests few frames.
// Switching off clears the fallback timers already armed.
//
// Controlled only over the private channel (src/content/bridge.js):
//   render-keepalive {on}   switch the fallback on (call started) or off (call ended)
//   keepalive-status        -> keepalive-status {active, fallbacks, pending}
;(function () {
  "use strict"
  if (window.__callscribeRenderKeepalive) return
  Object.defineProperty(window, "__callscribeRenderKeepalive", { value: true })

  const HANDSHAKE = "__callscribe_bridge"
  const TO_PAGE = "__callscribe_to_page"
  const TO_EXT = "__callscribe_to_ext"
  const FALLBACK_MS = 500
  // Ids for wrapped frames live far above the native ones, so cancelAnimationFrame can tell them apart.
  const ID_BASE = 0x40000000

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

  const visibilityOf = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState").get
  const hidden = () => apply(visibilityOf, document, []) === "hidden"
  const nativeRAF = window.requestAnimationFrame.bind(window)
  const nativeCancel = window.cancelAnimationFrame.bind(window)
  const pending = new Map() // our id -> { rafId, timer, run }
  let next = ID_BASE
  let active = false
  let fallbacks = 0

  function arm(entry) {
    if (!entry.timer) entry.timer = setTimeout(() => entry.run(performance.now(), true), FALLBACK_MS)
  }

  window.requestAnimationFrame = function requestAnimationFrame(cb) {
    if (!active && !hidden()) return nativeRAF(cb)
    const id = next++
    const entry = { rafId: 0, timer: 0, run: null }
    entry.run = (ts, viaFallback) => {
      if (!pending.has(id)) return
      pending.delete(id)
      if (viaFallback) {
        nativeCancel(entry.rafId)
        fallbacks++
      } else if (entry.timer) {
        clearTimeout(entry.timer)
      }
      cb(ts)
    }
    entry.rafId = nativeRAF((ts) => entry.run(ts, false))
    pending.set(id, entry)
    if (active) arm(entry)
    return id
  }

  window.cancelAnimationFrame = function cancelAnimationFrame(id) {
    const entry = pending.get(id)
    if (!entry) return nativeCancel(id)
    pending.delete(id)
    nativeCancel(entry.rafId)
    if (entry.timer) clearTimeout(entry.timer)
  }

  function setActive(on) {
    active = on
    pending.forEach((entry) => {
      if (on) arm(entry)
      else if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = 0
      }
    })
  }

  function handle(m) {
    const type = own(m, "type")
    if (type === "render-keepalive") setActive(own(m, "on") === true)
    else if (type === "keepalive-status") post({ type: "keepalive-status", active, fallbacks, pending: pending.size })
  }
})()
