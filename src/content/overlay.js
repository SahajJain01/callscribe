// In-call overlay: a draggable pill with the elapsed time and the latest caption, which
// expands into a status row plus a scrollable transcript. Pure helpers (overlayModel,
// clampPos, formatElapsed, renderRows) are unit-tested in Node; createOverlay is the DOM part.
// update({ orphan: message }) turns it into a warning-only pill that doesn't expand
// (extension updated mid-call; host data-state="orphaned"). That needs only the DOM.
;(function (root) {
  "use strict"

  const MARGIN = 4
  const DRAG_PX = 4
  const SILENCE_MS = 30000
  const FOLLOW_PX = 24
  const AUDIO_START_MS = 10000
  // The expanded transcript mounts a window of the latest WINDOW lines, and BATCH more each
  // time the user scrolls near its top, so opening a long call is one short task and the
  // whole call can still be scrolled back to. While following the latest line, the window
  // is trimmed back once it holds more than MAX_FOLLOW rows.
  const WINDOW = 60
  const BATCH = 60
  const MAX_FOLLOW = 240
  const EXTEND_PX = 300

  const pad = (n) => String(n).padStart(2, "0")

  function formatElapsed(ms) {
    const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
  }

  // Keeps the whole box inside the viewport, MARGIN px from each edge (top-left wins if it can't fit).
  function clampPos(pos, size, view) {
    const x = Math.min(pos.x, view.vw - size.w - MARGIN)
    const y = Math.min(pos.y, view.vh - size.h - MARGIN)
    return { x: Math.max(MARGIN, x), y: Math.max(MARGIN, y) }
  }

  function captionRow(state, warn) {
    if (state.source === "feed") return { label: "Captions", value: "Meet feed", level: "ok" }
    if (state.source === "cc") {
      return state.platform === "slack-huddle"
        ? { label: "Captions", value: "Slack captions", level: "ok" }
        : { label: "Captions", value: "CC fallback", level: "warn" }
    }
    return { label: "Captions", value: "none yet", level: warn ? "warn" : "plain" }
  }

  const AUDIO = {
    recording: { value: "recording", level: "ok" },
    starting: { value: "starting", level: "plain" },
    off: { value: "off", level: "plain" },
    error: { value: "error", level: "warn" },
    stalled: { value: "not starting", level: "warn" },
    "save-failed": { value: "save failed", level: "warn" }, // the browser couldn't store it
  }

  // warn: caption silence. dotWarn: anything the collapsed pill should flag (caption silence,
  // audio error, audio stuck starting, a transcript or audio save failure). A muted mic is
  // normal for most of a call, so it isn't.
  // state.orphan (a message): the extension was updated mid-call and this tab no longer records.
  // The pill then carries only that warning.
  function overlayModel(state, now) {
    if (state.orphan) {
      return { orphan: String(state.orphan), elapsed: "", latest: null, warn: true, dotWarn: true, status: [], language: null, languageHint: null }
    }
    const startedAt = state.startedAt || now
    const lines = state.lines || []
    const warn = now - startedAt > SILENCE_MS && now - (state.lastCaptionAt || startedAt) > SILENCE_MS
    const last = lines[lines.length - 1]
    const audioKey = state.audio === "starting" && now - startedAt > AUDIO_START_MS ? "stalled" : state.audio
    const audio = AUDIO[audioKey] || AUDIO.off
    const status = [captionRow(state, warn), { label: "Audio", ...audio }]
    // The browser couldn't store the transcript (only shown while that is so).
    const transcriptFailed = state.transcript === "save-failed"
    if (transcriptFailed) status.push({ label: "Transcript", value: "save failed", level: "warn" })
    if (state.micRecorded === false) status.push({ label: "Mic", value: "not recorded", level: "plain" })
    else if (state.micMuted === true) status.push({ label: "Mic", value: "muted, not recorded", level: "warn" })
    else if (state.micMuted === false) status.push({ label: "Mic", value: "on", level: "ok" })
    status.push({ label: "Lines", value: String(lines.length), level: "plain" })
    return {
      elapsed: formatElapsed(now - startedAt),
      latest: last ? { speaker: last.speaker, text: last.text, live: !!last.live } : null,
      warn,
      dotWarn: warn || audio.level === "warn" || transcriptFailed,
      status,
      // Meet: the caption language menu. Slack: where to change it in Slack.
      language: state.captionLanguage && state.captionLanguage.code ? state.captionLanguage : null,
      languageHint: state.captionHint || null,
    }
  }

  // A transcript row. Names and captions can be in any script: each picks its own direction
  // (dir=auto, which also isolates it) inside the overlay's left-to-right layout.
  function makeRow(doc) {
    const row = doc.createElement("div")
    row.time = doc.createElement("span")
    row.time.className = "t"
    row.speaker = doc.createElement("b")
    row.speaker.dir = "auto"
    row.text = doc.createElement("span")
    row.text.dir = "auto"
    row.appendChild(row.time)
    row.appendChild(row.speaker)
    row.appendChild(row.text)
    row.className = "row"
    return row
  }
  // Writes only what changed. Text goes in via textContent only.
  function patchRow(row, line, startedAt) {
    const time = formatElapsed(line.start - startedAt)
    const speaker = `${line.speaker}:`
    const live = !!line.live
    if (row._time !== time) row.time.textContent = row._time = time
    if (row._speaker !== speaker) row.speaker.textContent = row._speaker = speaker
    if (row._text !== line.text) row.text.textContent = row._text = line.text
    if (row._live !== live) {
      row._live = live
      row.className = live ? "row live" : "row"
    }
  }

  // One element per line, for lines[from..]: row k shows lines[from + k]. Existing rows are
  // patched only where speaker, text, time or the live flag changed; new lines are appended.
  function renderRows(doc, list, lines, startedAt, from = 0) {
    for (let i = from; i < lines.length; i++) {
      let row = list.children[i - from]
      if (!row) row = list.appendChild(makeRow(doc))
      patchRow(row, lines[i], startedAt)
    }
    while (list.children.length > Math.max(0, lines.length - from)) list.lastChild.remove()
  }

  const CSS = `
:host { all: initial; direction: ltr; }
* { box-sizing: border-box; }
.box { font: 12px/1.45 "Google Sans", Roboto, system-ui, sans-serif; color: #e8eaed;
  background: rgba(32,33,36,.96); border: 1px solid #5f6368; box-shadow: 0 2px 8px rgba(0,0,0,.35); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #ea4335; flex: none;
  box-shadow: 0 0 0 3px rgba(234,67,53,.25); }
.dot.warn { background: #fdd663; box-shadow: 0 0 0 3px rgba(253,214,99,.25); }
.box { direction: ltr; unicode-bidi: isolate; }
.pill { display: flex; align-items: center; gap: 7px; max-width: min(420px, calc(var(--cs-vw, 100vw) - 8px)); border-radius: 999px;
  padding: 5px 11px; white-space: nowrap; cursor: pointer; user-select: none; touch-action: none; }
.pill .el { font-variant-numeric: tabular-nums; flex: none; }
.pill .sep { color: #9aa0a6; flex: none; }
.sp, .row b { color: #8ab4f8; font-weight: 600; }
.pill .sp { flex: none; max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
.pill .sp:empty { display: none; }
.tail { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }
.tail > span { unicode-bidi: isolate; }
.tail.wait { color: #9aa0a6; direction: ltr; }
.live, .tail.live { font-style: italic; }
.card { position: relative; width: min(310px, calc(var(--cs-vw, 100vw) - 8px)); border-radius: 10px; overflow: hidden;
  display: flex; flex-direction: column; max-height: calc(var(--cs-vh, 100vh) - 12px); }
.hd, .st { flex: none; }
.hd { display: flex; align-items: center; gap: 7px; font-weight: 600; font-size: 12px;
  padding: 8px 11px 4px; cursor: pointer; user-select: none; touch-action: none; }
.hd .x { margin-left: auto; color: #9aa0a6; font-weight: 400; }
.st { display: flex; gap: 4px 10px; flex-wrap: wrap; padding: 0 11px 7px; color: #bdc1c6;
  font-size: 11px; border-bottom: 1px solid #3c4043; }
.ok { color: #81c995; } .warn { color: #fdd663; } .plain { color: #e8eaed; }
.lang { font: inherit; font-size: 10.5px; margin-left: 6px; max-width: 130px; padding: 0 4px; border-radius: 6px; cursor: pointer;
  color: #e8eaed; background: #303134; border: 1px solid #5f6368; line-height: 16px; }
.hint { flex-basis: 100%; color: #9aa0a6; }
.log { flex: 0 1 auto; min-height: 0; max-height: 220px; overflow-y: auto; padding: 6px 11px 8px; overscroll-behavior: contain; overflow-anchor: none;
  scrollbar-width: thin; scrollbar-color: #5f6368 transparent; }
.row { margin-bottom: 4px; overflow-wrap: anywhere; }
.row .t { color: #9aa0a6; font-size: 10.5px; margin-right: 5px; font-variant-numeric: tabular-nums; }
.row b { margin-right: 4px; }
.row b, .row span { unicode-bidi: isolate; }
.row.live { opacity: .75; }
.empty { color: #9aa0a6; padding: 2px 0 4px; }
.jump { position: absolute; right: 10px; bottom: 8px; background: #8ab4f8; color: #202124;
  border-radius: 999px; padding: 2px 9px; font-size: 11px; font-weight: 600; cursor: pointer; user-select: none; }
[hidden] { display: none !important; }
`

  function createOverlay(opts) {
    opts = opts || {}
    const doc = opts.doc || document
    const win = doc.defaultView || root
    const storage = opts.storage || (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) || null

    const el = (tag, cls, parent, text) => {
      const n = doc.createElement(tag)
      if (cls) n.className = cls
      if (text) n.textContent = text
      if (parent) parent.appendChild(n)
      return n
    }

    const host = doc.createElement("div")
    host.id = "callscribe-overlay"
    host.style.cssText = "position:fixed;z-index:2147483647;top:8px;left:50%;transform:translateX(-50%);margin:0;padding:0;border:0;direction:ltr;"
    host.setAttribute("data-state", "collapsed")
    host.setAttribute("data-latest", "")
    const shadow = host.attachShadow({ mode: "closed" })
    el("style", null, shadow).textContent = CSS

    // Collapsed pill.
    const pill = el("div", "box pill", shadow)
    const pDot = el("span", "dot", pill)
    const pEl = el("span", "el", pill, "0:00")
    const pSep = el("span", "sep", pill, "·")
    const pSp = el("span", "sp", pill)
    pSp.dir = "auto"
    const pTail = el("span", "tail wait", pill)
    const pTailText = el("span", null, pTail, "waiting for captions…")
    pTailText.dir = "auto"

    // Expanded card.
    const card = el("div", "box card", shadow)
    card.hidden = true
    const hd = el("div", "hd", card)
    const cDot = el("span", "dot", hd)
    const cTitle = el("span", null, hd, "CallScribe · 0:00")
    el("span", "x", hd, "▴")
    const st = el("div", "st", card)
    // Caption language menu (Meet): built once, moved into the Captions row on each rebuild.
    const langSel = doc.createElement("select")
    langSel.className = "lang"
    langSel.title = "Caption language"
    langSel.setAttribute("aria-label", "Caption language")
    let langSlot = null
    let langKey = ""
    for (const type of ["pointerdown", "pointerup", "click"]) langSel.addEventListener(type, (e) => e.stopPropagation())
    // The menu takes keyboard focus only while it's used: a choice, Escape, Enter or Tab hands
    // it back to the page (Meet's Space-to-unmute, and no arrow key changes the language).
    langSel.addEventListener("change", (e) => {
      e.stopPropagation()
      if (opts.onCaptionLanguage) opts.onCaptionLanguage(langSel.value)
      langSel.blur()
    })
    langSel.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === "Tab") langSel.blur()
    })
    // Catch up on status changes held back while the menu was in use.
    langSel.addEventListener("blur", () => {
      if (!removed && last) win.setTimeout(() => !removed && last && render(last), 0)
    })
    function syncLanguage(lang) {
      if (!lang) {
        if (langSel.parentNode) langSel.remove()
        return
      }
      // A browser code outside the list (sent as-is, as 0.3.0 did) is shown as itself.
      const listed = lang.options.some((o) => o[0] === lang.code)
      const options = listed ? lang.options : [[lang.code, lang.code], ...lang.options]
      const key = options.map((o) => o[0]).join(",")
      if (langKey !== key) {
        langKey = key
        langSel.textContent = ""
        for (const [code, name] of options) {
          const o = doc.createElement("option")
          o.value = code
          o.textContent = name
          langSel.appendChild(o)
        }
      }
      if (langSel.value !== lang.code) langSel.value = lang.code
      if (langSlot && langSel.parentNode !== langSlot) langSlot.appendChild(langSel)
    }
    const log = el("div", "log", card)
    const empty = el("div", "empty", log, "waiting for captions…")
    const list = el("div", null, log)
    const jump = el("div", "jump", card, "↓ latest")
    jump.hidden = true

    let expanded = false
    let follow = true
    let pos = null // null = default top-centre
    let dragged = false
    let removed = false
    let last = null // last state, for re-rendering on expand
    let orphan = false // warning-only pill: no expanding
    let from = 0 // the transcript shows lines[from..]
    let shown = null // the lines array the transcript was last rendered from
    const seen = {} // cache of last written values for the cheap update path

    const set = (key, node, value) => {
      if (seen[key] === value) return
      seen[key] = value
      node.textContent = value
    }
    const attr = (name, value) => {
      if (host.getAttribute(name) !== value) host.setAttribute(name, value)
    }

    // pos is where the user put it (drag or saved overlayPos). What's shown is a clamped copy,
    // so growing or expanding near an edge never moves the remembered spot.
    // The usable viewport excludes page scrollbars; at high zoom or in a small window the
    // pill and card shrink to it (--cs-vw/--cs-vh), so the default top-centre spot fits too.
    function viewport() {
      const de = doc.documentElement
      const vw = Math.min(win.innerWidth, (de && de.clientWidth) || win.innerWidth)
      const vh = Math.min(win.innerHeight, (de && de.clientHeight) || win.innerHeight)
      return { vw, vh }
    }
    let view = null
    function fitViewport() {
      const v = viewport()
      if (view && v.vw === view.vw && v.vh === view.vh) return
      view = v
      host.style.setProperty("--cs-vw", `${v.vw}px`)
      host.style.setProperty("--cs-vh", `${v.vh}px`)
    }
    let size = { w: 0, h: 0 }
    function place() {
      const r = host.getBoundingClientRect()
      size = { w: r.width, h: r.height }
      if (!pos) {
        host.style.left = "50%"
        host.style.transform = "translateX(-50%)"
        host.style.top = "8px"
        return null
      }
      const at = clampPos(pos, size, viewport())
      host.style.transform = "none"
      host.style.left = `${at.x}px`
      host.style.top = `${at.y}px`
      return at
    }
    // The pill's width follows its text (up to 420 px): re-clamp whenever the size changes.
    function placeIfResized() {
      if (!pos) return
      const r = host.getBoundingClientRect()
      if (r.width !== size.w || r.height !== size.h) place()
    }

    function atBottom() {
      return log.scrollHeight - log.scrollTop - log.clientHeight <= FOLLOW_PX
    }
    function toBottom() {
      log.scrollTop = log.scrollHeight
    }

    // Only the lines from `from` on are mounted. An unchanged lines array (main.js hands the
    // same one back while nothing changed) costs nothing; otherwise only mounted rows are
    // patched, and scroll geometry is touched only to follow the latest line.
    function renderList(state, force) {
      const lines = state.lines || []
      if (!force && lines === shown) return
      shown = lines
      empty.hidden = lines.length > 0
      const n = lines.length
      if (from > n) {
        list.textContent = ""
        from = Math.max(0, n - WINDOW)
      }
      if (follow && n - from > MAX_FOLLOW) {
        const drop = n - WINDOW - from
        for (let k = 0; k < drop && list.firstChild; k++) list.firstChild.remove()
        from += drop
      }
      renderRows(doc, list, lines, state.startedAt || 0, from)
      if (follow) toBottom()
      jump.hidden = follow
    }
    // Scrolled near the top of what's mounted: mount the previous BATCH lines above it,
    // keeping what the user is looking at in place.
    function extendUp() {
      if (!expanded || !from || !shown || log.scrollTop > EXTEND_PX) return
      const k = Math.min(BATCH, from)
      const startedAt = (last && last.startedAt) || 0
      const frag = doc.createDocumentFragment()
      for (let i = from - k; i < from; i++) {
        const row = makeRow(doc)
        patchRow(row, shown[i], startedAt)
        frag.appendChild(row)
      }
      const h = log.scrollHeight
      list.insertBefore(frag, list.firstChild)
      from -= k
      log.scrollTop += log.scrollHeight - h
    }
    // Collapsed: no transcript rows are kept in the page.
    function releaseList() {
      list.textContent = ""
      shown = null
      from = 0
    }

    function renderOrphan(m) {
      if (expanded) toggle()
      orphan = true
      pDot.className = cDot.className = seen.dot = "dot warn"
      pEl.hidden = pSep.hidden = true
      set("sp", pSp, "")
      set("tail", pTailText, m.orphan)
      pTail.className = seen.tailCls = "tail wait"
      attr("data-latest", "")
      attr("data-state", "orphaned")
      placeIfResized()
    }

    function render(state) {
      const now = Date.now()
      const m = overlayModel(state, now)
      if (m.orphan) return renderOrphan(m)
      const dotCls = m.dotWarn ? "dot warn" : "dot"
      if (seen.dot !== dotCls) {
        seen.dot = dotCls
        pDot.className = cDot.className = dotCls
      }
      set("el", pEl, m.elapsed)
      set("title", cTitle, `CallScribe · ${m.elapsed}`)
      const latest = m.latest
      set("sp", pSp, latest ? `${latest.speaker}:` : "")
      // Long lines: keep only the tail, the CSS ellipsis trims the rest from the left.
      const tail = latest ? (latest.text.length > 300 ? latest.text.slice(-300) : latest.text) : "waiting for captions…"
      set("tail", pTailText, tail)
      const tailCls = !latest ? "tail wait" : latest.live ? "tail live" : "tail"
      if (seen.tailCls !== tailCls) pTail.className = seen.tailCls = tailCls
      attr("data-latest", latest ? latest.text : "")

      const stKey = JSON.stringify([m.status, m.languageHint])
      // While the language menu is in use, leave the row alone: moving the menu would close it.
      const choosing = shadow.activeElement === langSel
      if (seen.st !== stKey && !choosing) {
        seen.st = stKey
        // The language menu lives on across status rebuilds, so an open dropdown survives a refresh.
        if (langSel.parentNode) langSel.remove()
        st.textContent = ""
        for (const r of m.status) {
          const item = el("span", null, st, `${r.label} `)
          el("span", r.level, item, r.value)
          if (r.label === "Captions") langSlot = item
        }
        if (m.languageHint) el("span", "hint", st, m.languageHint)
      }
      syncLanguage(m.language)
      if (expanded) renderList(state)
      placeIfResized()
    }

    function toggle() {
      if (orphan && !expanded) return
      expanded = !expanded
      pill.hidden = expanded
      card.hidden = !expanded
      attr("data-state", expanded ? "expanded" : "collapsed")
      if (expanded) {
        follow = true
        const n = (last && last.lines && last.lines.length) || 0
        from = Math.max(0, n - WINDOW)
        if (last) renderList(last, true)
        toBottom()
      } else {
        releaseList()
      }
      place()
    }

    // Click toggles; a move over DRAG_PX is a drag that moves the host and saves on release.
    let drag = null
    function onDown(e) {
      if (e.button !== 0) return
      const r = host.getBoundingClientRect()
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: r.left, y: r.top, moving: false, target: e.currentTarget }
      try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
    }
    function onMove(e) {
      if (!drag || e.pointerId !== drag.id) return
      const dx = e.clientX - drag.sx
      const dy = e.clientY - drag.sy
      if (!drag.moving && Math.hypot(dx, dy) <= DRAG_PX) return
      drag.moving = true
      dragged = true
      // A drag is the user choosing a spot: remember what is actually shown.
      pos = { x: drag.x + dx, y: drag.y + dy }
      pos = place()
    }
    function onUp(e) {
      if (!drag || e.pointerId !== drag.id) return
      const d = drag
      drag = null
      try { d.target.releasePointerCapture(e.pointerId) } catch {}
      if (!d.moving) return toggle()
      if (storage && pos) {
        try { Promise.resolve(storage.set({ overlayPos: pos })).catch(() => {}) } catch {}
      }
    }
    function onCancel() {
      drag = null
    }
    for (const target of [pill, hd]) {
      target.addEventListener("pointerdown", onDown)
      target.addEventListener("pointermove", onMove)
      target.addEventListener("pointerup", onUp)
      target.addEventListener("pointercancel", onCancel)
    }

    // Keep keyboard focus on the page: cancelling mousedown stops Chromium's focus fix-up
    // (pointerdown preventDefault alone does not). Presses on the log's scrollbar are left
    // alone so the native thumb drag keeps working; those never move focus anyway.
    function onLogScrollbar(e) {
      if (e.target !== log) return false
      const r = log.getBoundingClientRect()
      return e.clientX >= r.left + log.clientLeft + log.clientWidth
    }
    shadow.addEventListener("mousedown", (e) => {
      // The language menu needs its mousedown to open (and takes focus while it's used).
      if (e.target === langSel || langSel.contains(e.target)) return
      if (!onLogScrollbar(e)) e.preventDefault()
    })

    log.addEventListener("scroll", () => {
      follow = atBottom()
      jump.hidden = follow
      extendUp()
    })
    jump.addEventListener("click", (e) => {
      e.stopPropagation()
      follow = true
      jump.hidden = true
      // Back to a short window at the latest line.
      if (last && shown && shown.length - from > WINDOW) {
        releaseList()
        from = Math.max(0, ((last.lines && last.lines.length) || 0) - WINDOW)
        renderList(last, true)
      }
      toBottom()
    })

    const onResize = () => {
      fitViewport()
      if (pos) place()
    }
    win.addEventListener("resize", onResize)

    doc.documentElement.appendChild(host)
    fitViewport()

    if (storage) {
      try {
        Promise.resolve(storage.get("overlayPos"))
          .then((r) => {
            const p = r && r.overlayPos
            if (removed || dragged || !p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return
            pos = { x: p.x, y: p.y }
            place()
          })
          .catch(() => {})
      } catch {}
    }

    return {
      update(state) {
        if (removed || !state) return
        // Page code may have removed the host; put it back while the overlay is alive.
        if (!host.isConnected) doc.documentElement.appendChild(host)
        last = state
        render(state)
      },
      remove() {
        if (removed) return
        removed = true
        win.removeEventListener("resize", onResize)
        host.remove()
      },
    }
  }

  const api = { overlayModel, clampPos, formatElapsed, renderRows }
  root.CallScribe = Object.assign(root.CallScribe || {}, api, { createOverlay })
  if (typeof module !== "undefined" && module.exports) module.exports = api
})(typeof globalThis !== "undefined" ? globalThis : this)
