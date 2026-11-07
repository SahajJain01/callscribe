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

  let settings = { recordAudio: true, includeMic: true, autoCaptions: true, hideCaptions: true, showOverlay: true }
  let session = null // { id, tracker, utterances, startedAt, lastInCall, captionsTried, savedAt, audio, lastCaptionAt }
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

  // Platforms with a structured caption feed (Meet) don't need captions drawn on the page.
  // The DOM tracker stays as the fallback when the feed delivers nothing.
  const names = new Map() // speaker id -> display name, learned before or during the call
  const stream = adapter.createCaptionStream
    ? adapter.createCaptionStream({
        toPage,
        onUtterance: (u, t) => {
          if (!session) return
          session.utterances.add(u, t)
          session.lastCaptionAt = Date.now()
          scheduleOverlay()
        },
        onName: (id, name) => {
          names.set(id, name)
          session && session.utterances.setName(id, name)
        },
      })
    : null
  const streamActive = () => Boolean(stream && stream.active())
  const captionsOn = () => streamActive() || adapter.captionsOn()
  // Give the feed this long to start before falling back to turning CC on.
  const STREAM_GRACE_MS = 8000
  if (stream) toPage({ type: "dc-hello" })

  chrome.storage.local.get("settings").then((r) => {
    Object.assign(settings, r.settings || {})
    applyHide()
    syncOverlay()
  })
  chrome.storage.onChanged.addListener((c) => {
    if (c.settings) Object.assign(settings, c.settings.newValue || {})
    applyHide()
    syncOverlay()
  })

  // In-call overlay. It only reads state; any failure in it is logged and ignored so it
  // can never affect capture or saving.
  let overlay = null
  let overlayTimer = 0
  function overlayState() {
    const feed = session.utterances.view()
    return {
      platform: adapter.id,
      startedAt: session.startedAt,
      source: streamActive() ? "feed" : captionsOn() ? "cc" : "none",
      audio: session.audio,
      micMuted: lastMuted,
      micRecorded: Boolean(settings.recordAudio && settings.includeMic),
      lines: feed.length ? feed : session.tracker.view(),
      lastCaptionAt: session.lastCaptionAt,
    }
  }
  // After the extension is updated or reloaded mid-call this script is orphaned
  // (chrome.runtime.id is gone) and nothing is saved any more: don't show a live overlay then.
  function contextAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id)
    } catch {
      return false
    }
  }
  function syncOverlay() {
    try {
      if (!session || settings.showOverlay === false || !contextAlive()) {
        if (overlay) overlay.remove()
        overlay = null
        return
      }
      if (!overlay) overlay = CS.createOverlay({ doc: document, storage: chrome.storage.local })
      overlay.update(overlayState())
    } catch (e) {
      console.debug("[CallScribe] overlay sync failed", e)
    }
  }
  // Caption updates refresh the overlay at most every 250 ms.
  function scheduleOverlay() {
    if (overlayTimer) return
    overlayTimer = setTimeout(() => {
      overlayTimer = 0
      syncOverlay()
    }, 250)
  }

  // Hidden captions: keep the caption box rendering (we read it) but move it off-screen.
  function applyHide() {
    reclaimSpace()
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

  // Some apps keep layout space reserved for captions even when the box is moved away.
  function reclaimSpace() {
    try {
      adapter.reclaimCaptionSpace && adapter.reclaimCaptionSpace(settings.hideCaptions)
    } catch (e) {
      console.debug("[CallScribe] reclaim caption space failed", e)
    }
  }

  function startSession() {
    const id = `${adapter.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    session = {
      id, tracker: new CS.CaptionTracker(), utterances: new CS.UtteranceTracker(), startedAt: Date.now(), lastInCall: Date.now(), captionsTried: 0, savedAt: 0,
      audio: settings.recordAudio ? "starting" : "off", lastCaptionAt: 0,
    }
    names.forEach((name, speaker) => session.utterances.setName(speaker, name))
    send({
      type: "session-start",
      session: { id, platform: adapter.id, platformName: adapter.name, title: adapter.title(), url: location.href, startedAt: session.startedAt },
    })
    lastMuted = undefined
    syncMute()
    // Keep the page applying caption updates even when the tab isn't drawn (see render-keepalive.js).
    toPage({ type: "render-keepalive", on: true })
    if (settings.recordAudio) toPage({ type: "start", id, includeMic: settings.includeMic })
    stream && stream.start()
    observe()
  }

  function save(force) {
    if (!session) return
    const now = Date.now()
    if (!force && !session.tracker.dirty && !session.utterances.dirty && now - session.savedAt < 15000) return
    session.savedAt = now
    // Titles read outside the call UI fall back to weaker sources; keep the in-call one.
    if (adapter.inCall()) session.title = adapter.title() || session.title
    // Prefer the caption feed; the on-page captions are only used if it captured nothing.
    const fromFeed = session.utterances.entries.length > 0
    const utterances = fromFeed ? session.utterances.snapshot() : session.tracker.snapshot()
    ;(fromFeed ? session.tracker : session.utterances).dirty = false
    send({ type: "session-update", id: session.id, title: session.title, utterances, captionsOn: captionsOn() })
  }

  function endSession(reason) {
    if (!session) return
    const s = session
    readCaptions()
    save(true)
    session = null
    syncOverlay()
    stream && stream.stop()
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
    const wasDirty = session.tracker.dirty
    try {
      session.tracker.update(adapter.captionRows())
    } catch (e) {
      console.debug("[CallScribe] caption read failed", e)
    }
    if (session.tracker.dirty && !wasDirty) session.lastCaptionAt = Date.now()
    scheduleOverlay()
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
    if (stream && /^dc-/.test(m.type)) {
      stream.handle(m)
    } else if (m.type === "chunk") {
      send({ type: "audio-chunk", id: m.id, seq: m.seq, mime: m.mime, b64: b64(m.buf) })
    } else if (m.type === "started" || m.type === "error" || m.type === "log") {
      if (session && m.id === session.id && m.type !== "log") session.audio = m.type === "started" ? "recording" : "error"
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

    if (stream) stream.tick()
    if (adapter.participantNames) {
      try {
        for (const [id, name] of adapter.participantNames()) if (names.get(id) !== name) {
          names.set(id, name)
          session.utterances.setName(id, name)
        }
      } catch {}
    }

    // Fallback: show captions so the page can be read, if the caption feed hasn't started.
    if (settings.autoCaptions && adapter.enableCaptions && !captionsOn() && session.captionsTried < 3) {
      const since = Date.now() - session.startedAt
      if (since > (stream ? STREAM_GRACE_MS : 1000) + session.captionsTried * 5000) {
        session.captionsTried++
        adapter.enableCaptions()
      }
    }
    readCaptions()
    reclaimSpace()
    if (Date.now() - session.savedAt >= SAVE_EVERY_MS) save(false)
    // Every second regardless of dirty: the elapsed time ticks and live lines turn final.
    syncOverlay()
  }, 1000)

  window.addEventListener("pagehide", () => endSession("page-closed"))

  // Popup asks what is happening in this tab.
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === "tab-status") {
      reply({
        platform: adapter.name,
        inCall: adapter.inCall(),
        captionsOn: captionsOn(),
        hint: adapter.hints && adapter.hints.captionsOff,
        session: session
          ? { id: session.id, lines: session.utterances.entries.length || session.tracker.entries.length, startedAt: session.startedAt }
          : null,
      })
    }
  })
})()
