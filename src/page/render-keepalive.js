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
// the tab is drawn normally, real frames win and the timer is cancelled. Outside a call the
// wrapper only passes through to the native rAF.
;(function () {
  "use strict"
  if (window.__callscribeRenderKeepalive) return
  window.__callscribeRenderKeepalive = true

  const TAG = "__callscribe"
  const FALLBACK_MS = 500
  const nativeRAF = window.requestAnimationFrame.bind(window)
  const nativeCancel = window.cancelAnimationFrame.bind(window)
  const pending = new Map() // our id -> { rafId, timer, run }
  let next = 1
  let active = false
  window.__csRafFallbacks = 0

  function arm(entry) {
    if (!entry.timer) entry.timer = setTimeout(() => entry.run(performance.now(), true), FALLBACK_MS)
  }

  window.requestAnimationFrame = function requestAnimationFrame(cb) {
    const id = next++
    const entry = { rafId: 0, timer: 0, run: null }
    entry.run = (ts, viaFallback) => {
      if (!pending.has(id)) return
      pending.delete(id)
      if (viaFallback) {
        nativeCancel(entry.rafId)
        window.__csRafFallbacks++
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
    if (!entry) return
    pending.delete(id)
    nativeCancel(entry.rafId)
    if (entry.timer) clearTimeout(entry.timer)
  }

  function setActive(on) {
    active = Boolean(on)
    // Frames requested before the call started may be stuck behind a stalled tab: arm them too.
    if (active) pending.forEach(arm)
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || ev.data[TAG] !== "ext" || ev.data.type !== "render-keepalive") return
    setActive(ev.data.on)
  })
})()
