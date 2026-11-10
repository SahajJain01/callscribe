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
// Audio or a transcript save that still can't be stored shows as "save failed" in the overlay.
// A refusal the worker marks closed is final for the whole session: the tab stops sending for it
// and stops its recorder. closed "deleted" (the user deleted the live call in the popup): the
// session ends quietly and that call isn't recorded again until it is left. closed "finalized"
// (the worker already ended it as stale, e.g. while the laptop slept or the tab was frozen):
// the rest of the call goes on in a new session with its own recorder; its transcript holds
// what the first session hadn't stored (see save), and the overlay keeps the call's clock.
//
// After the extension is updated or reloaded, this script is orphaned (chrome.runtime.id is
// gone, sendMessage throws). It then stops the recorder and render keepalive, drops the
// session, gives the page its own captions and layout back and shows the pill as a warning
// while a call is on screen.
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

  let settings = { recordAudio: true, includeMic: true, autoCaptions: true, showOverlay: true }
  // { id, tracker, utterances, startedAt, callStartedAt, lastInCall, ccPressedAt, savedAt, audio, lastCaptionAt,
  //   rec: { paused, includeMic, acked } | null, stored (last transcript the worker stored), skip (lines an earlier session of the call stored) }
  let session = null
  let readTimer = 0
  let lastMuted
  let micOpen = false // what the MAIN-world mic gate was last told; it starts closed there too
  let orphaned = false
  let refusedAt = 0 // the worker refused the session for good: last seen in that call (0 = not refused)
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
  // One write, retried until the worker acknowledges it ({ok}). {error, fatal} (bad message,
  // deleted session, wrong tab) is final; {closed} too says the whole session is over for this
  // tab. Resolves true when stored; onFail(reply) runs when it gives up.
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
    box.started = deliver(startMsg, (r) => r.closed && sessionGone(s, r.closed)).then(() => {
      box.ready = true
      for (const [m, f, ok] of box.waiting.splice(0)) post(s, m, f, ok)
    })
    return box
  }
  // onOk runs once the write is stored.
  function post(s, msg, onFail, onOk) {
    if (s.closed) return
    const box = s.box
    if (!box.ready) return void box.waiting.push([msg, onFail, onOk])
    const p = deliver(msg, (r) => (r.closed ? sessionGone(s, r.closed) : onFail && onFail(r)))
    box.pending.add(p)
    p.then((stored) => {
      box.pending.delete(p)
      if (stored && onOk) onOk()
    })
  }
  async function drained(box) {
    await box.started
    while (box.pending.size) await Promise.all([...box.pending])
  }
  function audioSaveFailed(s) {
    s.audioSaveFailed = true
    if (session === s) syncOverlay()
  }
  function transcriptSaveFailed(s, failed) {
    if (s.transcriptSaveFailed === failed) return
    s.transcriptSaveFailed = failed
    if (session === s) syncOverlay()
  }
  // The worker refused the session for good. Nothing more is sent for it and, if it is the live
  // one, its recorder stops; it gets no session-end (the worker has nothing to finalise).
  // "finalized" (ended as stale while this tab was still in the call): the call carries on in a
  // new session. Otherwise (deleted): the session ends here with no "save failed", and the
  // same call isn't picked up again.
  function sessionGone(s, why) {
    if (s.closed) return
    s.closed = true
    s.box.waiting.length = 0
    if (session !== s) return
    if (s.rec) toPage({ type: "stop", id: s.id })
    // A session-start the worker never stored can't have been finalised: never loop on one.
    if (why === "finalized" && s.box.ready && !orphaned) {
      session = null
      startSession(s)
      return syncOverlay()
    }
    session = null
    refusedAt = Date.now()
    names.clear()
    stopCapture()
    syncOverlay()
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
  // The caption language CallScribe asks Meet for: the saved choice, else the browser's.
  const browserLangs = () => {
    const nav = typeof navigator !== "undefined" ? navigator : {}
    return nav.languages && nav.languages.length ? [...nav.languages] : [nav.language]
  }
  const captionLanguage = () => CS.resolveCaptionLanguage(settings.captionLang, browserLangs())
  const stream = adapter.createCaptionStream
    ? adapter.createCaptionStream({
        toPage,
        language: captionLanguage,
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
  const CC_RETRY_MS = 5000
  if (stream) toPage({ type: "dc-hello" })

  function onSettings(next) {
    const lang = captionLanguage()
    Object.assign(settings, next || {})
    // A key removed from storage (e.g. captionLang reset) must not linger here.
    if (next && !("captionLang" in next)) delete settings.captionLang
    if (orphaned) return
    if (stream && stream.languageChanged && captionLanguage() !== lang) stream.languageChanged()
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
      startedAt: session.callStartedAt,
      source: streamActive() ? "feed" : captionsOn() ? "cc" : "none",
      audio: session.audioSaveFailed ? "save-failed" : session.audio,
      transcript: session.transcriptSaveFailed ? "save-failed" : "ok",
      micMuted: lastMuted,
      micRecorded: Boolean(rec && !rec.paused && rec.includeMic),
      lines: overlayLines(session),
      lastCaptionAt: session.lastCaptionAt,
      // Meet takes a caption language from us; Slack's is set in Slack.
      captionLanguage: stream ? { code: captionLanguage(), options: CS.CAPTION_LANGUAGES } : null,
      captionHint: stream ? null : SLACK_LANGUAGE_HINT,
    }
  }
  const SLACK_LANGUAGE_HINT = "Caption language: change it in Slack's huddle caption settings"
  async function setCaptionLanguage(code) {
    try {
      if (!CS.isCaptionLanguage(code)) return
      const cur = (await chrome.storage.local.get("settings")).settings || {}
      await chrome.storage.local.set({ settings: { ...cur, captionLang: code } })
    } catch (e) {
      console.debug("[CallScribe] caption language change failed", e)
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
      if (!overlay) overlay = CS.createOverlay({ doc: document, storage: chrome.storage.local, onCaptionLanguage: setCaptionLanguage })
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
      if (!overlay) overlay = CS.createOverlay({ doc: document, storage: null })
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

  // A line's identity across sessions of one call (see save).
  const lineKey = (u) => `${u.device || u.speaker}\u0000${u.start}\u0000${u.text}`

  // prev: the session of this call the worker already finalised (sessionGone). The new one
  // carries on with its caption state, so nothing said meanwhile is lost and the lines on
  // screen aren't read again, and skips what prev (and those before it) stored. It isn't
  // counted against the per-tab session limit: it is the same call, and the worker only
  // finalises a live call after it missed the liveness probe (at most once per sweep).
  function startSession(prev) {
    const id = `${adapter.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const now = Date.now()
    session = {
      id, tracker: prev ? prev.tracker : new CS.CaptionTracker(), utterances: prev ? prev.utterances : new CS.UtteranceTracker(),
      startedAt: now, callStartedAt: prev ? prev.callStartedAt : now, lastInCall: prev ? prev.lastInCall : now, ccPressedAt: prev ? prev.ccPressedAt : 0, savedAt: 0,
      audio: "off", lastCaptionAt: prev ? prev.lastCaptionAt : 0, rec: null, rev: 0, audioSaveFailed: false, transcriptSaveFailed: false, closed: false,
      stored: null, storedRev: 0, skip: prev ? new Set([...(prev.skip || []), ...(prev.stored || []).map(lineKey)]) : null,
    }
    names.forEach((name, speaker) => session.utterances.setName(speaker, name))
    session.box = newBox(session, {
      type: "session-start",
      session: { id, platform: adapter.id, platformName: adapter.name, title: adapter.title(), url: location.href, startedAt: session.startedAt },
    })
    if (orphaned) return
    // Carrying a call on: the caption feed, observer, keepalive and mic gate are still running.
    if (prev) return reconcileRecorder()
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
    // A session carrying a finalised call on leaves out the lines that one stored: the remainder
    // only. A line stored while still being spoken is sent again in full (overlap, never a gap).
    let utterances = CS.mergeSources(s.utterances.snapshot(), s.tracker.snapshot())
    if (s.skip) utterances = utterances.filter((u) => !s.skip.has(lineKey(u)))
    // rev: a retried older snapshot never overwrites a newer one. A save that keeps failing
    // is redone from the latest state on the next heartbeat; one refused outright (fatal) is
    // not resent before the usual 15 s. Either way the overlay says the transcript isn't saved.
    const msg = { type: "session-update", id: s.id, rev: ++s.rev, title: s.title, utterances, captionsOn: captionsOn() }
    post(s, msg, (r) => {
      if (!r.fatal) {
        s.savedAt = 0
        s.utterances.dirty = true
      }
      transcriptSaveFailed(s, true)
    }, () => {
      if (msg.rev > s.storedRev) {
        s.stored = utterances
        s.storedRev = msg.rev
      }
      transcriptSaveFailed(s, false)
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
    save(s, true)
    // When the call ended: the last time it was seen on screen, or now if the page is closing.
    const at = reason === "left" ? s.lastInCall : Date.now()
    const end = () => drained(s.box).then(() => !s.closed && deliver({ type: "session-end", id: s.id, reason, at }))
    if (!s.rec) return void end()
    // The page posts 'stopped' after the last chunk; finalize once everything before it is stored
    // (or after a timeout: the worker still takes chunks that arrive later, until it exports).
    // The waiter is in place before 'stop' goes out: with no live recorder the page answers
    // 'stopped' at once, from inside toPage.
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      stopWaiters.delete(s.id)
      end()
    }
    stopWaiters.set(s.id, finish)
    setTimeout(finish, STOP_WAIT_MS)
    toPage({ type: "stop", id: s.id })
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
    // A refused call stays unrecorded until it has been left (off screen past the end grace).
    if (refusedAt) {
      if (inCall) refusedAt = Date.now()
      else if (Date.now() - refusedAt > END_GRACE_MS) refusedAt = 0
    }
    if (inCall && !session && !refusedAt && mayStartSession()) startSession()
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

    // CC fallback: if the caption feed isn't running, turn CC on and read it off the page.
    // Pressed again every few seconds for as long as CC is off (the user turned it off, the
    // button wasn't there yet); nothing on the page is hidden or moved.
    if (settings.autoCaptions && adapter.enableCaptions && !captionsOn()) {
      const now = Date.now()
      if (now - session.startedAt > (stream ? STREAM_GRACE_MS : 1000) && now - session.ccPressedAt >= CC_RETRY_MS) {
        session.ccPressedAt = now
        adapter.enableCaptions()
      }
    }
    // Page captions: the container observer reads them as they change. The heartbeat also
    // polls them as the fallback, but not while the caption feed is healthy (CC is off then).
    observe()
    if (!streamActive()) readCaptions(false)
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
