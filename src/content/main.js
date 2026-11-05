// Platform-agnostic call watcher. Picks the adapter for this site, notices when a call
// starts and ends, turns caption rows into a transcript, and drives the audio recorder.
;(function () {
  "use strict"
  const CS = globalThis.CallScribe
  const adapter = (CS.adapters || []).find((a) => a.matches(location))
  if (!adapter || window.top !== window) return

  const TAG = "__callscribe"
  const END_GRACE_MS = 4000
  const SAVE_EVERY_MS = 3000

  let settings = { recordAudio: true, includeMic: true, autoCaptions: true, hideCaptions: true }
  let session = null // { id, tracker, startedAt, lastInCall, captionsTried, savedAt }
  let readTimer = 0
  let lastMuted

  // Your mic is only recorded while the call app says you're unmuted.
  function syncMute() {
    if (!adapter.selfMuted) return
    let muted
    try { muted = adapter.selfMuted() } catch { return }
    if (muted === undefined || muted === lastMuted) return
    lastMuted = muted
    toPage({ type: "mic", on: !muted })
  }

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {})
  const toPage = (msg) => window.postMessage({ [TAG]: "ext", ...msg }, location.origin)

  chrome.storage.local.get("settings").then((r) => {
    Object.assign(settings, r.settings || {})
    applyHide()
  })
  chrome.storage.onChanged.addListener((c) => {
    if (c.settings) Object.assign(settings, c.settings.newValue || {})
    applyHide()
  })

  // Hidden captions: keep the caption box rendering (we read it) but move it off-screen.
  function applyHide() {
    const id = "callscribe-hide-captions"
    let el = document.getElementById(id)
    const sel = adapter.captionContainer
    if (!settings.hideCaptions || !sel) return el && el.remove()
    if (el) return
    el = document.createElement("style")
    el.id = id
    el.textContent = `${sel} { position: fixed !important; left: -100000px !important; top: 0 !important; width: 800px !important; opacity: 0 !important; pointer-events: none !important; }`
    ;(document.head || document.documentElement).appendChild(el)
  }

  function startSession() {
    const id = `${adapter.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    session = { id, tracker: new CS.CaptionTracker(), startedAt: Date.now(), lastInCall: Date.now(), captionsTried: 0, savedAt: 0 }
    send({
      type: "session-start",
      session: { id, platform: adapter.id, platformName: adapter.name, title: adapter.title(), url: location.href, startedAt: session.startedAt },
    })
    lastMuted = undefined
    syncMute()
    // Keep the page applying caption updates even when the tab isn't drawn (see render-keepalive.js).
    toPage({ type: "render-keepalive", on: true })
    if (settings.recordAudio) toPage({ type: "start", id, includeMic: settings.includeMic })
    observe()
  }

  function save(force) {
    if (!session) return
    const now = Date.now()
    if (!force && !session.tracker.dirty && now - session.savedAt < 15000) return
    session.savedAt = now
    // Titles read outside the call UI fall back to weaker sources; keep the in-call one.
    if (adapter.inCall()) session.title = adapter.title() || session.title
    send({ type: "session-update", id: session.id, title: session.title, utterances: session.tracker.snapshot(), captionsOn: adapter.captionsOn() })
  }

  function endSession(reason) {
    if (!session) return
    const s = session
    readCaptions()
    save(true)
    session = null
    observer && observer.disconnect()
    toPage({ type: "render-keepalive", on: false })
    if (settings.recordAudio) {
      toPage({ type: "stop" })
      // The page posts 'stopped' after the last chunk; finalize then (or after a timeout).
      const done = (ev) => {
        if (ev.source === window && ev.data && ev.data[TAG] === "page" && ev.data.type === "stopped" && ev.data.id === s.id) finish()
      }
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        window.removeEventListener("message", done)
        send({ type: "session-end", id: s.id, reason })
      }
      window.addEventListener("message", done)
      setTimeout(finish, 6000)
    } else {
      send({ type: "session-end", id: s.id, reason })
    }
  }

  function readCaptions() {
    if (!session) return
    try {
      session.tracker.update(adapter.captionRows())
    } catch (e) {
      console.debug("[CallScribe] caption read failed", e)
    }
  }

  // Captions change many times a second; read at most every 250 ms.
  let observer = null
  function observe() {
    observer && observer.disconnect()
    observer = new MutationObserver(() => {
      if (readTimer) return
      readTimer = setTimeout(() => {
        readTimer = 0
        readCaptions()
      }, 250)
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  }

  // Page -> extension: audio chunks.
  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || ev.data[TAG] !== "page") return
    const m = ev.data
    if (m.type === "chunk") {
      send({ type: "audio-chunk", id: m.id, seq: m.seq, mime: m.mime, b64: b64(m.buf) })
    } else if (m.type === "started" || m.type === "error" || m.type === "log") {
      send({ type: "audio-" + m.type, id: m.id, detail: m })
    }
  })

  function b64(buf) {
    const bytes = new Uint8Array(buf)
    let s = ""
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    return btoa(s)
  }

  // Heartbeat: call state, caption auto-enable, periodic save. Timers keep running in background tabs.
  setInterval(() => {
    const inCall = adapter.inCall()
    if (inCall && !session) startSession()
    if (!session) return
    if (inCall) {
      session.lastInCall = Date.now()
      syncMute()
    } else if (Date.now() - session.lastInCall > END_GRACE_MS) return endSession("left")

    if (settings.autoCaptions && adapter.enableCaptions && !adapter.captionsOn() && session.captionsTried < 3) {
      const since = Date.now() - session.startedAt
      if (since > 1000 + session.captionsTried * 5000) {
        session.captionsTried++
        adapter.enableCaptions()
      }
    }
    readCaptions()
    if (Date.now() - session.savedAt >= SAVE_EVERY_MS) save(false)
  }, 1000)

  window.addEventListener("pagehide", () => endSession("page-closed"))

  // Popup asks what is happening in this tab.
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === "tab-status") {
      reply({
        platform: adapter.name,
        inCall: adapter.inCall(),
        captionsOn: adapter.captionsOn(),
        hint: adapter.hints && adapter.hints.captionsOff,
        session: session ? { id: session.id, lines: session.tracker.entries.length, startedAt: session.startedAt } : null,
      })
    }
  })
})()
