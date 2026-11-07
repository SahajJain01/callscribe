// Private channel between this content script (isolated world) and CallScribe's MAIN-world
// scripts (src/page/*.js). Runs at document_start, after the MAIN-world scripts (manifest
// order) and before any page script.
//
// Handover: the MAIN-world scripts have each registered a one-shot listener on window for
// HANDSHAKE. This script creates a detached element (never inserted into the document) and
// dispatches HANDSHAKE once, synchronously, with that element as relatedTarget. DOM nodes are
// shared between worlds, so every MAIN-world script receives the same element, removes its
// listener and from then on talks only through events dispatched on that element. No page
// script has run yet, so none can see the handshake, and none ever gets a reference to the
// element: events on a detached node don't propagate to window or document. A page script
// that later dispatches its own HANDSHAKE finds no listener left. The MAIN-world side calls
// natives captured at document_start, so prototypes patched later by the page don't see the
// traffic either. CustomEvent detail is structured-cloned between worlds (ArrayBuffers included).
//
// API (globalThis.CallScribe.bridge, isolated world only):
//   send(msg)        -> deliver msg ({ type, ... }) to the MAIN world, synchronously
//   onMessage(fn)    -> fn(msg) for every message from the MAIN world; returns an unsubscribe fn
//   connected()      -> true once a MAIN-world script has spoken on the channel
//
// Event names on the private element:
//   "__callscribe_to_page"  extension -> MAIN world (detail = msg)
//   "__callscribe_to_ext"   MAIN world -> extension (detail = msg)
// Message types:
//   to the page:  start {id, includeMic} | pause {id} | resume {id} | config {id, includeMic}
//                 | stop {id} | mic {on} | status | render-keepalive {on} | keepalive-status
//                 | dc-hello | dc-send {label, buf}
//   from the page: started {id, mime, remote, mic, state} | paused {id} | resumed {id}
//                 | chunk {id, seq, mime, buf} | stopped {id} | error {id, message} | log {id, message}
//                 | status {...} | keepalive-status {active, fallbacks, pending}
//                 | dc-open {label} | dc-close {label} | dc-msg {label, dir, t, buf} | dc-sent {label, ok}
;(function () {
  "use strict"
  const HANDSHAKE = "__callscribe_bridge"
  const TO_PAGE = "__callscribe_to_page"
  const TO_EXT = "__callscribe_to_ext"
  const CS = (globalThis.CallScribe = globalThis.CallScribe || {})
  if (CS.bridge || window.top !== window) return

  const node = document.createElement("span")
  const listeners = new Set()
  let heard = false
  node.addEventListener(TO_EXT, (ev) => {
    const msg = ev.detail
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return
    heard = true
    for (const fn of [...listeners]) {
      try {
        fn(msg)
      } catch (e) {
        console.debug("[CallScribe] bridge listener failed", e)
      }
    }
  })
  window.dispatchEvent(new MouseEvent(HANDSHAKE, { relatedTarget: node }))

  CS.bridge = {
    send(msg) {
      node.dispatchEvent(new CustomEvent(TO_PAGE, { detail: msg }))
    },
    onMessage(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    connected: () => heard,
  }
})()
