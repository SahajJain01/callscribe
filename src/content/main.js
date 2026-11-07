// Platform-agnostic call watcher. Picks the adapter for this site, notices when a call
// starts and ends, turns caption rows into a transcript, and drives the audio recorder.
//
// The MAIN-world scripts (src/page/*.js) are reached only through CallScribe.bridge, the
// private channel from src/content/bridge.js (message types listed there). What comes back
// is checked before it is used: chunks only for sessions this tab started a recorder for,
// ArrayBuffer of bounded size, strictly increasing seq, an audio MIME type.
//
// Recorder ownership lives on the session, not in the settings: session.rec is set when this
// session's recorder was started, and the end of the session always stops it by id.
// Turning audio off mid-call pauses that recorder, on again resumes it (or starts it if the
// call began with audio off); the mic setting attaches/detaches the mic mid-call.
//
// Every write to the service worker is acknowledged (see post/deliver): failures are retried
// with backoff, a session's writes wait until its session-start is stored, and session-end is
// sent only once every earlier write settled, so the last chunk is stored before export.
// Audio that still can't be stored shows as Audio "save failed" in the overlay.
//
// After the extension is updated or reloaded, this script is orphaned (chrome.runtime.id is
// gone, sendMessage throws). It then stops the recorder and render keepalive, drops the
// session and shows the pill as a warning while a call is on screen.
;(function () {
  "use strict"
  const CS = globalThis.CallScribe
  const adapter = (CS.adapters || []).find((a) => a.matches(location))
  if (!adapter || window.top !== window) return

  const END_GRACE_MS = 4000
  const SAVE_EVERY_MS = 3000
  const STOP_WAIT_MS = 6000
  const MAX_CHUNK_BYTES = 16 * 1024 * 1024
  const MAX_DC_BYTES = 1024 * 1024
  const AUDIO_MIME = /^audio\/(webm|ogg)(;|$)/
  // Page code flapping the call UI must not mass-create sessions (and downloads).
  const SESSIONS_PER_WINDOW = 6
  const SESSION_WINDOW_MS = 10 * 60 * 1000
  const ORPHAN_TEXT = "CallScribe was updated. Reload this tab to keep recording"
  const RETRY_MS = [500, 1000, 2000, 4000, 8000] // then give up on that write (~15 s)

  let settings = { recordAudio: true, includeMic: true, autoCaptions: true, hideCaptions: true, showOverlay: true }
  // { id, tracker, utterances, startedAt, lastInCall, captionsTried, savedAt, audio, lastCaptionAt, rec: { paused, includeMic, acked } | null }
  let session = null
  let readTimer = 0
  let lastMuted
  let micOpen = false // what the MAIN-world mic gate was last told; it starts closed there too
  let orphaned = false
  const sessionStarts = []
  const owned = new Map() // session id -> { nextSeq } for recorders this tab started, until 'stopped'
  const stopWaiters = new Map() // session id -> fn, called on 'stopped'

  const bridge = CS.bridge
  function toPage(msg) {
    try {
      if (bridge) bridge.send(msg)
    } catch (e) {
      console.debug("[CallScribe] page channel send failed", e)
    }
  }

  function contextAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id)
    } catch {
      return false
    }
  }
  // sendMessage throws synchronously once the extension context is gone: that is the orphan signal.
  function request(msg) {
    if (orphaned) return Promise.resolve(undefined)
    try {
      return Promise.resolve(chrome.runtime.sendMessage(msg))
    } catch (e) {
      becomeOrphan()
      return Promise.resolve(undefined)
    }
  }
  // One write, retried until the worker acknowledges it ({ok}). {error, fatal} (deleted session,
  // wrong tab) is final. Resolves true when stored; onFail runs when it gives up.
  function deliver(msg, onFail) {
    return new Promise((resolve) => {
      let attempt = 0
      const go = () => {
        request(msg)
          .then((r) => r || { error: "no reply" }, (e) => ({ error: String((e && e.message) || e) }))
          .then((r) => {
            if (orphaned) return resolve(false)
            if (!r.error) return resolve(true)
            if (r.fatal || attempt >= RETRY_MS.length) {
              console.debug("[CallScribe] save failed", msg.type, r.error)
              if (onFail) onFail(r)
              return resolve(false)
            }
            setTimeout(go, RETRY_MS[attempt++])
          })
      }
      go()
    })
  }
  // Per-session outbox: nothing goes out before session-start is stored.
  function newBox(s, startMsg) {
    const box = { ready: false, waiting: [], pending: new Set() }
    box.started = deliver(startMsg).then(() => {
      box.ready = true
      for (const [m, f] of box.waiting.splice(0)) post(s, m, f)
    })
    return box
  }
  function post(s, msg, onFail) {
    const box = s.box
    if (!box.ready) return void box.waiting.push([msg, onFail])
    const p = deliver(msg, onFail)
    box.pending.add(p)
    p.then(() => box.pending.delete(p))
  }
  async function drained(box) {
    await box.started
    while (box.pending.size) await Promise.all([...box.pending])
  }
  function audioSaveFailed(s) {
    s.audioSaveFailed = true
    if (session === s) syncOverlay()
  }

  // Your mic is only recorded while the call app positively says you're unmuted.
  function setMic(on) {
    if (on === micOpen) return
    micOpen = on
    toPage({ type: "mic", on })
  }
  function syncMute() {
    let muted
    try {
      muted = adapter.selfMuted ? adapter.selfMuted() : undefined
    } catch {
      muted = undefined
    }
    lastMuted = muted
    setMic(Boolean(session) && muted === false)
  }
  // A press on the mic toggle closes the gate at once; the next reading reopens it if still unmuted.
  function onMicPress(e) {
    if (!micOpen || !session) return
    if (e.type === "keydown" && e.key && e.key !== "Enter" && e.key !== " ") return
    let toggle = null
    try {
      toggle = adapter.micToggle ? adapter.micToggle() : null
    } catch {}
    if (toggle && e.target && toggle.contains(e.target)) setMic(false)
  }
  document.addEventListener("pointerdown", onMicPress, true)
  document.addEventListener("keydown", onMicPress, true)
  // The mute state lives in attributes of the mic toggle: re-read it as soon as one changes.
  let muteObserver = null
  function watchMute(on) {
    if (muteObserver) muteObserver.disconnect()
    muteObserver = null
    if (!on || !document.body) return
    muteObserver = new MutationObserver(() => {
      if (session) syncMute()
    })
    muteObserver.observe(document.body, { attributes: true, subtree: true, attributeFilter: ["aria-pressed", "aria-checked", "data-is-muted", "aria-label"] })
  }

  // Platforms with a structured caption feed (Meet) don't need captions drawn on the page.
  // The DOM tracker is the fallback while the feed is late or gone; the transcript is the
  // union of both (CS.mergeSources), so neither source's lines are lost.
  // Speaker id -> display name, learned before or during the call; cleared when a call ends.
  const names = new Map()
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

  function onSettings(next) {
    Object.assign(settings, next || {})
    if (orphaned) return
    applyHide()
    reconcileRecorder()
    syncOverlay()
  }

  // In-call overlay. It only reads state; any failure in it is logged and ignored so it
  // can never affect capture or saving.
  let overlay = null
  let overlayTimer = 0
  // The merged transcript is re-merged only when either source's view changed (merging
  // 2,000 + 2,000 lines costs milliseconds; comparing the views is a cheap scan). The
  // overlay then gets the same array back and skips its transcript work.
  let linesMemo = null
  const sameLine = (a, b) => a.text === b.text && a.speaker === b.speaker && a.live === b.live && a.start === b.start && a.end === b.end && a.device === b.device
  function sameView(a, b) {
    if (a.length !== b.length) return false
    for (let i = a.length - 1; i >= 0; i--) if (!sameLine(a[i], b[i])) return false
    return true
  }
  function overlayLines(s) {
    const feed = s.utterances.view()
    const page = s.tracker.view()
    const m = linesMemo
    if (m && m.s === s && sameView(m.feed, feed) && sameView(m.page, page)) return m.lines
    linesMemo = { s, feed, page, lines: CS.mergeSources(feed, page) }
    return linesMemo.lines
  }
  function overlayState() {
    const rec = session.rec
    return {
      platform: adapter.id,
      startedAt: session.startedAt,
      source: streamActive() ? "feed" : captionsOn() ? "cc" : "none",
      audio: session.audioSaveFailed ? "save-failed" : session.audio,
      micMuted: lastMuted,
      micRecorded: Boolean(rec && !rec.paused && rec.includeMic),
      lines: overlayLines(session),
      lastCaptionAt: session.lastCaptionAt,
      canHideCaptions: Boolean(adapter.captionContainer),
      captionsHidden: settings.hideCaptions !== false,
    }
  }
  // The overlay's Hide/Show button flips the same setting as the popup's "Hide captions on screen".
  async function setCaptionsHidden(hide) {
    try {
      const cur = (await chrome.storage.local.get("settings")).settings || {}
      await chrome.storage.local.set({ settings: { ...cur, hideCaptions: hide } })
    } catch (e) {
      console.debug("[CallScribe] overlay caption toggle failed", e)
    }
  }
  function removeOverlay() {
    if (overlay) overlay.remove()
    overlay = null
  }
  function syncOverlay() {
    // One refresh path: a refresh now makes a pending scheduled one redundant.
    clearTimeout(overlayTimer)
    overlayTimer = 0
    try {
      if (orphaned) return
      if (!session) linesMemo = null
      if (!session || settings.showOverlay === false) return removeOverlay()
      if (!overlay) overlay = CS.createOverlay({ doc: document, storage: chrome.storage.local, onToggleCaptions: setCaptionsHidden })
      overlay.update(overlayState())
    } catch (e) {
      console.debug("[CallScribe] overlay sync failed", e)
    }
  }
  // Orphaned: nothing is recorded any more. While a call is on screen the pill says so.
  function syncOrphanOverlay() {
    try {
      let inCall = false
      try {
        inCall = adapter.inCall()
      } catch {}
      if (!inCall) return removeOverlay()
      if (!overlay) overlay = CS.createOverlay({ doc: document, storage: null, onToggleCaptions: null })
      overlay.update({ orphan: ORPHAN_TEXT })
    } catch (e) {
      console.debug("[CallScribe] overlay warning failed", e)
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

  // Bring this session's recorder in line with the current settings.
  function reconcileRecorder() {
    const s = session
    if (!s || orphaned) return
    const includeMic = settings.includeMic !== false
    if (settings.recordAudio) {
      if (!s.rec) {
        s.rec = { paused: false, includeMic, acked: false }
        owned.set(s.id, { nextSeq: 0, session: s })
        s.audio = "starting"
        toPage({ type: "start", id: s.id, includeMic })
      } else if (s.rec.paused) {
        s.rec.paused = false
        s.audio = s.rec.acked ? "recording" : "starting"
        toPage({ type: "resume", id: s.id })
      }
    } else if (s.rec && !s.rec.paused) {
      s.rec.paused = true
      s.audio = "off"
      toPage({ type: "pause", id: s.id })
    }
    if (s.rec && s.rec.includeMic !== includeMic) {
      s.rec.includeMic = includeMic
      toPage({ type: "config", id: s.id, includeMic })
    }
  }

  function mayStartSession() {
    const now = Date.now()
    while (sessionStarts.length && now - sessionStarts[0] > SESSION_WINDOW_MS) sessionStarts.shift()
    if (sessionStarts.length >= SESSIONS_PER_WINDOW) return false
    sessionStarts.push(now)
    return true
  }

  function startSession() {
    const id = `${adapter.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    session = {
      id, tracker: new CS.CaptionTracker(), utterances: new CS.UtteranceTracker(), startedAt: Date.now(), lastInCall: Date.now(), captionsTried: 0, savedAt: 0,
      audio: "off", lastCaptionAt: 0, rec: null, rev: 0, audioSaveFailed: false,
    }
    names.forEach((name, speaker) => session.utterances.setName(speaker, name))
    session.box = newBox(session, {
      type: "session-start",
      session: { id, platform: adapter.id, platformName: adapter.name, title: adapter.title(), url: location.href, startedAt: session.startedAt },
    })
    if (orphaned) return
    lastMuted = undefined
    syncMute()
    watchMute(true)
    // Keep the page applying caption updates even when the tab isn't drawn (see render-keepalive.js).
    toPage({ type: "render-keepalive", on: true })
    reconcileRecorder()
    stream && stream.start()
    observe()
  }

  function save(s, force) {
    const now = Date.now()
    if (!force && !s.tracker.dirty && !s.utterances.dirty && now - s.savedAt < 15000) return
    s.savedAt = now
    // Titles read outside the call UI fall back to weaker sources; keep the in-call one.
    try {
      if (adapter.inCall()) s.title = adapter.title() || s.title
    } catch {}
    // The caption feed plus every on-page caption it doesn't already hold (transcript C1 / lifecycle F8).
    const utterances = CS.mergeSources(s.utterances.snapshot(), s.tracker.snapshot())
    // rev: a retried older snapshot never overwrites a newer one. A save that keeps failing
    // is redone from the latest state on the next heartbeat.
    post(s, { type: "session-update", id: s.id, rev: ++s.rev, title: s.title, utterances, captionsOn: captionsOn() }, () => {
      s.savedAt = 0
      s.utterances.dirty = true
    })
  }

  // Everything in the page that belongs to the live session: captions, keepalive, mic gate.
  function stopCapture() {
    try {
      stream && stream.stop()
    } catch {}
    unobserve()
    watchMute(false)
    clearTimeout(readTimer)
    readTimer = 0
    toPage({ type: "render-keepalive", on: false })
    setMic(false)
  }

  function endSession(reason) {
    if (!session) return
    const s = session
    readCaptions()
    session = null
    names.clear()
    // Local cleanup first: persistence below can find the extension gone.
    stopCapture()
    syncOverlay()
    if (s.rec) toPage({ type: "stop", id: s.id })
    save(s, true)
    // When the call ended: the last time it was seen on screen, or now if the page is closing.
    const at = reason === "left" ? s.lastInCall : Date.now()
    const end = () => drained(s.box).then(() => deliver({ type: "session-end", id: s.id, reason, at }))
    if (!s.rec) return void end()
    // The page posts 'stopped' after the last chunk; finalize once everything before it is stored
    // (or after a timeout: the worker still takes chunks that arrive later, until it exports).
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      stopWaiters.delete(s.id)
      end()
    }
    stopWaiters.set(s.id, finish)
    setTimeout(finish, STOP_WAIT_MS)
  }

  // The extension was updated or reloaded under us: stop everything in the page, warn.
  function becomeOrphan() {
    if (orphaned) return
    orphaned = true
    const s = session
    session = null
    try {
      stopCapture()
      if (s && s.rec) toPage({ type: "stop", id: s.id })
      clearTimeout(overlayTimer)
      overlayTimer = 0
    } catch (e) {
      console.debug("[CallScribe] orphan cleanup failed", e)
    }
    syncOrphanOverlay()
  }

  // Reads the captions drawn on the page. refresh: also schedule an overlay refresh (the
  // heartbeat refreshes the overlay itself right after, so it passes false).
  function readCaptions(refresh = true) {
    if (!session) return
    const wasDirty = session.tracker.dirty
    try {
      session.tracker.update(adapter.captionRows())
    } catch (e) {
      console.debug("[CallScribe] caption read failed", e)
    }
    if (session.tracker.dirty && !wasDirty) session.lastCaptionAt = Date.now()
    if (refresh) scheduleOverlay()
  }

  // Captions change many times a second; read at most every 250 ms. Only the caption
  // container is watched, once the page shows it (the heartbeat looks for it every second
  // and follows it when the app replaces it); the rest of the call UI never queues a read.
  let observer = null
  let observed = null
  function captionRoot() {
    try {
      if (adapter.captionRoot) return adapter.captionRoot() || null
      return adapter.captionContainer ? document.querySelector(adapter.captionContainer) : null
    } catch {
      return null
    }
  }
  function unobserve() {
    observer && observer.disconnect()
    observer = null
    observed = null
  }
  function observe() {
    const root = captionRoot()
    if (root === observed && observer) return
    unobserve()
    if (!root) return
    observed = root
    observer = new MutationObserver(() => {
      if (readTimer) return
      readTimer = setTimeout(() => {
        readTimer = 0
        readCaptions()
      }, 250)
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
  }

  // MAIN world -> extension, over the private channel only.
  function onPageMessage(m) {
    if (orphaned) return
    const type = m.type
    if (/^dc-/.test(type)) {
      if (!stream || typeof m.label !== "string") return
      if (type === "dc-msg" && !(m.buf instanceof ArrayBuffer && m.buf.byteLength <= MAX_DC_BYTES)) return
      return stream.handle(m)
    }
    const rec = owned.get(m.id)
    if (!rec) return // not a recorder this tab started
    if (type === "chunk") {
      const { buf, seq, mime } = m
      if (!(buf instanceof ArrayBuffer) || !buf.byteLength || buf.byteLength > MAX_CHUNK_BYTES) return
      if (!Number.isInteger(seq) || seq < rec.nextSeq || typeof mime !== "string" || !AUDIO_MIME.test(mime)) return
      rec.nextSeq = seq + 1
      const s = rec.session
      if (s) post(s, { type: "audio-chunk", id: m.id, seq, mime, b64: b64(buf) }, () => audioSaveFailed(s))
    } else if (type === "stopped") {
      owned.delete(m.id)
      const done = stopWaiters.get(m.id)
      if (done) done()
    } else if (type === "started" || type === "error" || type === "log") {
      if (session && session.id === m.id && session.rec && type !== "log") {
        if (type === "started") session.rec.acked = true
        if (!session.rec.paused) session.audio = type === "started" ? "recording" : "error"
      }
      const detail = { type, id: m.id }
      for (const k of ["mime", "remote", "mic", "state"]) if (typeof m[k] === "string" || typeof m[k] === "number") detail[k] = m[k]
      if (typeof m.message === "string") detail.message = m.message.slice(0, 300)
      if (rec.session) post(rec.session, { type: "audio-" + type, id: m.id, detail })
    }
  }
  if (bridge) bridge.onMessage(onPageMessage)

  function b64(buf) {
    const bytes = new Uint8Array(buf)
    let s = ""
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    return btoa(s)
  }

  // Settings can change mid-call (popup, overlay button): reconcile the recorder each time.
  try {
    chrome.storage.local.get("settings").then((r) => onSettings(r.settings), () => {})
    chrome.storage.onChanged.addListener((c) => {
      if (c.settings) onSettings(c.settings.newValue)
    })
  } catch {
    becomeOrphan()
  }

  // Heartbeat: call state, caption auto-enable, periodic save. Timers keep running in background tabs.
  setInterval(() => {
    if (orphaned) return syncOrphanOverlay()
    if (!contextAlive()) return becomeOrphan()
    const inCall = adapter.inCall()
    if (inCall && !session && mayStartSession()) startSession()
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
    // Page captions: the container observer reads them as they change. The heartbeat also
    // polls them as the fallback, but not while the caption feed is healthy (CC is off then).
    observe()
    if (!streamActive()) readCaptions(false)
    reclaimSpace()
    if (session && Date.now() - session.savedAt >= SAVE_EVERY_MS) save(session, false)
    // Every second regardless of dirty: the elapsed time ticks and live lines turn final.
    syncOverlay()
  }, 1000)

  window.addEventListener("pagehide", () => endSession("page-closed"))

  // Popup asks what is happening in this tab.
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (msg.type === "tab-status") {
        reply({
          platform: adapter.name,
          inCall: adapter.inCall(),
          captionsOn: captionsOn(),
          hint: adapter.hints && adapter.hints.captionsOff,
          session: session
            ? { id: session.id, lines: overlayLines(session).length, startedAt: session.startedAt }
            : null,
        })
      }
    })
  } catch {}
})()
