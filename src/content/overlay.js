// In-call overlay: a draggable pill with the elapsed time and the latest caption, which
// expands into a status row plus a scrollable transcript. Pure helpers (overlayModel,
// clampPos, formatElapsed, renderRows) are unit-tested in Node; createOverlay is the DOM part.
;(function (root) {
  "use strict"

  const MARGIN = 4
  const DRAG_PX = 4
  const SILENCE_MS = 30000
  const FOLLOW_PX = 24

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
  }

  function overlayModel(state, now) {
    const startedAt = state.startedAt || now
    const lines = state.lines || []
    const warn = now - startedAt > SILENCE_MS && now - (state.lastCaptionAt || startedAt) > SILENCE_MS
    const last = lines[lines.length - 1]
    const status = [captionRow(state, warn), { label: "Audio", ...(AUDIO[state.audio] || AUDIO.off) }]
    if (state.micMuted === true) status.push({ label: "Mic", value: "muted, not recorded", level: "warn" })
    else if (state.micMuted === false) status.push({ label: "Mic", value: "on", level: "ok" })
    status.push({ label: "Lines", value: String(lines.length), level: "plain" })
    return {
      elapsed: formatElapsed(now - startedAt),
      latest: last ? { speaker: last.speaker, text: last.text, live: !!last.live } : null,
      warn,
      status,
    }
  }

  // One element per line index. Existing rows are patched only where speaker, text, time or
  // the live flag changed; new lines are appended. Text goes in via textContent only.
  function renderRows(doc, list, lines, startedAt) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      let row = list.children[i]
      if (!row) {
        row = doc.createElement("div")
        row.time = doc.createElement("span")
        row.time.className = "t"
        row.speaker = doc.createElement("b")
        row.text = doc.createElement("span")
        row.appendChild(row.time)
        row.appendChild(row.speaker)
        row.appendChild(row.text)
        row.className = "row"
        list.appendChild(row)
      }
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
    while (list.children.length > lines.length) list.lastChild.remove()
  }

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.box { font: 12px/1.45 "Google Sans", Roboto, system-ui, sans-serif; color: #e8eaed;
  background: rgba(32,33,36,.96); border: 1px solid #5f6368; box-shadow: 0 2px 8px rgba(0,0,0,.35); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #ea4335; flex: none;
  box-shadow: 0 0 0 3px rgba(234,67,53,.25); }
.dot.warn { background: #fdd663; box-shadow: 0 0 0 3px rgba(253,214,99,.25); }
.pill { display: flex; align-items: center; gap: 7px; max-width: 420px; border-radius: 999px;
  padding: 5px 11px; white-space: nowrap; cursor: pointer; user-select: none; touch-action: none; }
.pill .el { font-variant-numeric: tabular-nums; flex: none; }
.pill .sep { color: #9aa0a6; flex: none; }
.sp, .row b { color: #8ab4f8; font-weight: 600; }
.pill .sp { flex: none; max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
.pill .sp:empty { display: none; }
.tail { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }
.tail > span { direction: ltr; unicode-bidi: isolate; }
.tail.wait { color: #9aa0a6; direction: ltr; }
.live, .tail.live { font-style: italic; }
.card { position: relative; width: 310px; border-radius: 10px; overflow: hidden; }
.hd { display: flex; align-items: center; gap: 7px; font-weight: 600; font-size: 12px;
  padding: 8px 11px 4px; cursor: pointer; user-select: none; touch-action: none; }
.hd .x { margin-left: auto; color: #9aa0a6; font-weight: 400; }
.st { display: flex; gap: 4px 10px; flex-wrap: wrap; padding: 0 11px 7px; color: #bdc1c6;
  font-size: 11px; border-bottom: 1px solid #3c4043; }
.ok { color: #81c995; } .warn { color: #fdd663; } .plain { color: #e8eaed; }
.log { max-height: 220px; overflow-y: auto; padding: 6px 11px 8px; overscroll-behavior: contain;
  scrollbar-width: thin; scrollbar-color: #5f6368 transparent; }
.row { margin-bottom: 4px; overflow-wrap: anywhere; }
.row .t { color: #9aa0a6; font-size: 10.5px; margin-right: 5px; font-variant-numeric: tabular-nums; }
.row b { margin-right: 4px; }
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
    host.style.cssText = "position:fixed;z-index:2147483647;top:8px;left:50%;transform:translateX(-50%);margin:0;padding:0;border:0;"
    host.setAttribute("data-state", "collapsed")
    host.setAttribute("data-latest", "")
    const shadow = host.attachShadow({ mode: "closed" })
    el("style", null, shadow).textContent = CSS

    // Collapsed pill.
    const pill = el("div", "box pill", shadow)
    const pDot = el("span", "dot", pill)
    const pEl = el("span", "el", pill, "0:00")
    el("span", "sep", pill, "·")
    const pSp = el("span", "sp", pill)
    const pTail = el("span", "tail wait", pill)
    const pTailText = el("span", null, pTail, "waiting for captions…")

    // Expanded card.
    const card = el("div", "box card", shadow)
    card.hidden = true
    const hd = el("div", "hd", card)
    const cDot = el("span", "dot", hd)
    const cTitle = el("span", null, hd, "CallScribe · 0:00")
    el("span", "x", hd, "▴")
    const st = el("div", "st", card)
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
    const seen = {} // cache of last written values for the cheap update path

    const set = (key, node, value) => {
      if (seen[key] === value) return
      seen[key] = value
      node.textContent = value
    }
    const attr = (name, value) => {
      if (host.getAttribute(name) !== value) host.setAttribute(name, value)
    }

    const viewport = () => ({ vw: win.innerWidth, vh: win.innerHeight })
    function place() {
      if (!pos) {
        host.style.left = "50%"
        host.style.transform = "translateX(-50%)"
        host.style.top = "8px"
        return
      }
      const r = host.getBoundingClientRect()
      pos = clampPos(pos, { w: r.width, h: r.height }, viewport())
      host.style.transform = "none"
      host.style.left = `${pos.x}px`
      host.style.top = `${pos.y}px`
    }

    function atBottom() {
      return log.scrollHeight - log.scrollTop - log.clientHeight <= FOLLOW_PX
    }
    function toBottom() {
      log.scrollTop = log.scrollHeight
    }

    function renderList(state) {
      const lines = state.lines || []
      empty.hidden = lines.length > 0
      renderRows(doc, list, lines, state.startedAt || 0)
      if (follow) toBottom()
      jump.hidden = follow
    }

    function render(state) {
      const now = Date.now()
      const m = overlayModel(state, now)
      const dotCls = m.warn ? "dot warn" : "dot"
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

      const stKey = JSON.stringify(m.status)
      if (seen.st !== stKey) {
        seen.st = stKey
        st.textContent = ""
        for (const r of m.status) {
          const item = el("span", null, st, `${r.label} `)
          el("span", r.level, item, r.value)
        }
      }
      if (expanded) renderList(state)
    }

    function toggle() {
      expanded = !expanded
      pill.hidden = expanded
      card.hidden = !expanded
      attr("data-state", expanded ? "expanded" : "collapsed")
      if (expanded) {
        follow = true
        if (last) renderList(last)
        toBottom()
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
      pos = { x: drag.x + dx, y: drag.y + dy }
      place()
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
      if (!onLogScrollbar(e)) e.preventDefault()
    })

    log.addEventListener("scroll", () => {
      follow = atBottom()
      jump.hidden = follow
    })
    jump.addEventListener("click", (e) => {
      e.stopPropagation()
      follow = true
      jump.hidden = true
      toBottom()
    })

    const onResize = () => {
      if (pos) place()
    }
    win.addEventListener("resize", onResize)

    doc.documentElement.appendChild(host)

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
