// Google Meet adapter. Captions come from Meet's caption data channel with CC left off
// (createCaptionStream); the captions panel Meet renders when CC is on is the fallback.
// DOM hooks verified against meet.google.com on 2026-11-04 (English UI; icon-name fallbacks are
// locale-free); caption channel verified 2026-11-07.
;(function () {
  "use strict"
  const CS = (globalThis.CallScribe = globalThis.CallScribe || {})
  const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "")
  const icon = (name) => [...document.querySelectorAll(".google-symbols, .material-icons-extended, i")].find((e) => e.textContent.trim() === name)

  function captionRegion() {
    return (
      document.querySelector('[role="region"][aria-label="Captions"]') ||
      document.querySelector('div[role="region"][tabindex="0"]:has(img)') ||
      null
    )
  }

  // Height of the band Meet sets aside for captions: the tallest box around the caption region,
  // stopping at the full-page layout. Moving the region off-screen doesn't shrink this band.
  function captionBandHeight(region) {
    let band = 0
    for (let e = region.parentElement; e && e !== document.body; e = e.parentElement) {
      const h = e.getBoundingClientRect().height
      if (h >= innerHeight * 0.6) break
      band = Math.max(band, h)
    }
    return band
  }

  function micButton() {
    for (const b of document.querySelectorAll("button[data-is-muted]")) {
      for (const i of b.querySelectorAll(".google-symbols, .material-icons-extended, i")) if (/^mic(_off|_none)?$/.test(i.textContent.trim())) return b
    }
    return null
  }

  // Your name, from your tile's menu button. That button comes and goes with the layout, so the
  // last name seen is kept: "You" captions stay under your name (transcript M4).
  let lastSelfName = ""
  function selfName() {
    const b = document.querySelector("button[aria-label^='More options for ']")
    const name = b ? b.getAttribute("aria-label").replace("More options for ", "").trim() : ""
    if (name) lastSelfName = name
    return lastSelfName
  }

  async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }
  const isGzip = (b, at) => b.length > at + 2 && b[at] === 0x1f && b[at + 1] === 0x8b && b[at + 2] === 8

  // The caption language to ask for when the content script doesn't pass one: the browser's.
  function browserLanguage() {
    const nav = typeof navigator !== "undefined" ? navigator : {}
    if (typeof CS.resolveCaptionLanguage !== "function") return "en-US" // languages.js not loaded
    return CS.resolveCaptionLanguage(undefined, nav.languages && nav.languages.length ? [...nav.languages] : [nav.language])
  }

  /**
   * Captions straight from Meet's captions_v2 data channel (see src/shared/meet-proto.js),
   * with CC left off: the page tap (src/page/meet-channels.js) forwards channel traffic here and
   * sends the "captions on" request we build. Meet's own code keeps acknowledging updates.
   * If the user turns CC off in Meet, that request stops the stream, so we ask again.
   * The language is CallScribe's choice (language()): when Meet's CC asks for another one, we
   * ask for ours again, and captions in the other language are dropped until our reply.
   */
  const sameLang = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase()

  function createCaptionStream({ toPage, onUtterance, onName, language }) {
    const P = CS.MeetProto
    const OWN_SEQ = 100000 // far above Meet's own request numbers, so replies can't be confused
    let seq = OWN_SEQ
    let want = false
    let open = false
    const wanted = () => {
      try {
        const l = language && language()
        if (l && typeof l === "string") return l
      } catch {}
      return browserLanguage()
    }
    let asked = "" // the language of our last request
    let switching = false // a request in another language than ours is (or may be) live until our reply
    let pending = 0 // seq of our request awaiting a reply
    let sentAt = 0
    let tries = 0
    let flowing = false // the server is streaming captions to this page
    let epoch = 0 // bumped whenever the stream restarts; utterance ids may restart with it
    let lastCaptionAt = 0

    function request() {
      // Out of tries with no reply (e.g. a code Meet doesn't take): stop holding back captions
      // in Meet's own language, so a bad choice can't leave the call with nothing.
      if (tries >= 5 && !pending) switching = false
      if (!want || !open || flowing || pending || tries >= 5) return
      pending = ++seq
      sentAt = Date.now()
      tries++
      asked = wanted()
      const buf = P.encodeLanguage(pending, asked).buffer
      toPage({ type: "dc-send", label: "captions_v2", buf })
    }

    function stopped() {
      if (flowing) epoch++
      flowing = false
      pending = 0
    }

    async function names(bytes) {
      try {
        if (isGzip(bytes, 0)) bytes = await gunzip(bytes)
        else if (isGzip(bytes, 3)) bytes = await gunzip(bytes.subarray(3))
        for (const [device, name] of P.findDeviceNames(bytes)) onName(device, name)
      } catch {}
    }

    return {
      handle(m) {
        if (m.label === "collections") {
          if (m.type === "dc-msg" && m.dir === "in") names(new Uint8Array(m.buf))
          return
        }
        if (m.label !== "captions_v2") return
        if (m.type === "dc-open") {
          open = true
          stopped()
          tries = 0
          request()
        } else if (m.type === "dc-close") {
          open = false
          stopped()
        } else if (m.type === "dc-sent") {
          if (!m.ok) pending = 0
        } else if (m.type === "dc-msg") {
          const bytes = new Uint8Array(m.buf)
          if (m.dir === "out") {
            const d = P.decodeOutgoing(bytes)
            if (!d || d.kind !== "language" || d.seq >= OWN_SEQ) return
            if (d.lang) {
              // A new subscription, even while ours flows: its utterance ids may start again (I4).
              epoch++
              if (sameLang(d.lang, wanted())) {
                flowing = true
                switching = false // the live subscription is in our language now (review M2)
              } else {
                // Meet's CC wants another language: ours wins, ask again.
                switching = true
                flowing = false
                pending = 0
                tries = 0
                request()
              }
            } else {
              // Meet turned CC off, which stops the stream for this page too: ask again.
              stopped()
              tries = 0
              setTimeout(request, 300)
            }
          } else {
            const d = P.decodeIncoming(bytes)
            if (!d) return
            if (d.kind === "reply" && d.seq === pending) {
              pending = 0
              tries = 0
              epoch++
              flowing = true
              switching = false
            } else if (d.kind === "captions") {
              lastCaptionAt = m.t
              const lang = wanted()
              for (const u of d.utterances) {
                if (switching && u.lang && !sameLang(u.lang, lang)) continue
                onUtterance({ ...u, epoch }, m.t)
              }
            }
          }
        }
      },
      start() {
        want = true
        tries = 0
        request()
      },
      stop() {
        want = false
      },
      // The chosen language changed: ask for it now, even while captions flow.
      languageChanged() {
        if (sameLang(asked, wanted())) return
        switching = true
        flowing = false
        pending = 0
        tries = 0
        request()
      },
      tick() {
        if (pending && Date.now() - sentAt > 5000) pending = 0 // no reply: try again
        request()
      },
      active: () => flowing || Date.now() - lastCaptionAt < 30000,
    }
  }

  // Name on each participant tile, keyed by the same device id the caption stream uses. One
  // person can have several tiles (camera and "Alice (Presentation)"): one name per id, the
  // shortest, so it doesn't flip between tiles (transcript M10). Only a presentation suffix is
  // removed; "Alice (she/her)" or "Bob (Acme)" is the person's name as shown and is kept.
  const PRESENTING = /\s*\((?:[^()]*\s)?(?:presentation|presenting|präsentation|présentation|presentación|apresentação|presentazione|presentatie|prezentacja|презентация|bản trình bày|đang trình bày|プレゼンテーション|演示|簡報|简报|프레젠테이션|발표|การนำเสนอ)(?:\s[^()]*)?\)$/i
  function participantNames() {
    const byId = new Map()
    for (const tile of document.querySelectorAll("[data-participant-id]")) {
      const id = tile.getAttribute("data-participant-id")
      const span = [...tile.querySelectorAll("span.notranslate")].find((s) => !s.children.length && text(s))
      if (!id || !span) continue
      const name = text(span).replace(PRESENTING, "") || text(span)
      const had = byId.get(id)
      if (!had || name.length < had.length || (name.length === had.length && name < had)) byId.set(id, name)
    }
    return [...byId]
  }

  const adapter = {
    id: "google-meet",
    name: "Google Meet",
    matches: (loc) => loc.hostname === "meet.google.com",
    captionContainer: '[role="region"][aria-label="Captions"]',
    // The element main.js watches for caption changes (also found in non-English UIs).
    captionRoot: captionRegion,
    createCaptionStream,
    participantNames,

    inCall() {
      return Boolean(document.querySelector('button[aria-label="Leave call"]') || icon("call_end"))
    },

    title() {
      const named = document.querySelector("[data-meeting-title]")?.getAttribute("data-meeting-title")
      if (named) return named
      const t = document.title.replace(/^Meet\s*[-–]\s*/, "").trim()
      if (t && t !== "Meet") return t
      const code = location.pathname.match(/([a-z]{3}-[a-z]{4}-[a-z]{3})/)
      return code ? code[1] : ""
    },

    /**
     * true = muted, false = live, undefined = can't tell (the mic is then not recorded).
     * Meet's mic button carries data-is-muted and a "mic"/"mic_off" icon in every UI language
     * (the camera button has data-is-muted too, so the icon picks the right one). The English
     * labels are only a fallback.
     */
    selfMuted() {
      const v = micButton()?.getAttribute("data-is-muted")
      if (v === "true" || v === "false") return v === "true"
      if (document.querySelector('button[aria-label^="Turn on microphone"]')) return true
      if (document.querySelector('button[aria-label^="Turn off microphone"]')) return false
      return undefined
    },

    /** The control that mutes/unmutes you (a press on it closes the mic gate at once). */
    micToggle() {
      return micButton() || document.querySelector('button[aria-label^="Turn on microphone"], button[aria-label^="Turn off microphone"]')
    },

    captionsOn() {
      return Boolean(captionRegion())
    },

    enableCaptions() {
      const btn =
        document.querySelector('button[aria-label^="Turn on captions"]') ||
        icon("closed_caption_off")?.closest("button")
      if (btn) btn.click()
      else document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", bubbles: true }))
    },

    // While captions are on, Meet shrinks the video grid by a fixed caption band (the bottom of its
    // inline `inset`) and lays tiles out for that smaller box. It never re-measures, so hiding the
    // caption box leaves an empty gap. When hidden, scale and centre the tiles into the grid plus
    // the band. Only tiles are moved; the grid's other children are left alone.
    // Meet owns the tiles' `transform` (animations, layouts): we never write it. Our move uses the
    // separate `translate` and `scale` properties, which the browser applies on top of the tile's
    // own transform, so a host transform is kept and scaled with the tile (runtime I5). A grid
    // whose tiles already use `translate`/`scale` themselves is left alone.
    reclaimCaptionSpace(hidden) {
      const ATTR = "data-callscribe-tile"
      const region = hidden ? captionRegion() : null
      const band = region ? captionBandHeight(region) : 0
      const want = new Map()
      const r = (n) => Math.round(n * 100) / 100
      const hostMoves = (k) => {
        if (k.hasAttribute(ATTR)) return false // ours
        const cs = getComputedStyle(k)
        return (cs.translate && cs.translate !== "none") || (cs.scale && cs.scale !== "none")
      }
      if (band) {
        for (const g of document.querySelectorAll('[style*="inset"]')) {
          if (!g.querySelector("[data-participant-id]")) continue
          // offset* ignore transforms, so this is Meet's own layout even after we've moved tiles.
          const tiles = [...g.children].filter(
            (k) => k.offsetWidth && k.offsetHeight && (k.matches("[data-participant-id]") || k.querySelector("[data-participant-id]")),
          )
          if (!tiles.length || tiles.some(hostMoves)) continue
          const x0 = Math.min(...tiles.map((k) => k.offsetLeft))
          const y0 = Math.min(...tiles.map((k) => k.offsetTop))
          const bw = Math.max(...tiles.map((k) => k.offsetLeft + k.offsetWidth)) - x0
          const bh = Math.max(...tiles.map((k) => k.offsetTop + k.offsetHeight)) - y0
          const W = g.offsetWidth
          const H = g.offsetHeight + band
          const s = Math.max(1, Math.min(W / bw, H / bh))
          // Every tile point p (as Meet draws it, own transform included) goes to s * p + (tx, ty).
          const tx = (W - s * bw) / 2 - s * x0
          const ty = (H - s * bh) / 2 - s * y0
          for (const k of tiles) {
            // `scale` works about the tile's transform-origin O, so translate by T + (s - 1) * O.
            const [ox, oy] = getComputedStyle(k).transformOrigin.split(" ").map(parseFloat)
            const dx = tx + (s - 1) * (k.offsetLeft + (ox || 0))
            const dy = ty + (s - 1) * (k.offsetTop + (oy || 0))
            want.set(k, `translate: ${r(dx)}px ${r(dy)}px !important; scale: ${Math.round(s * 1000) / 1000} !important;`)
          }
        }
      }
      for (const k of document.querySelectorAll(`[${ATTR}]`)) if (!want.has(k)) k.removeAttribute(ATTR)
      const rules = []
      let i = 0
      for (const [k, t] of want) {
        if (k.getAttribute(ATTR) !== String(i)) k.setAttribute(ATTR, String(i))
        rules.push(`[${ATTR}="${i++}"] { ${t} }`)
      }
      const css = rules.join("\n")
      let sheet = document.getElementById("callscribe-caption-space")
      if (!css) return sheet && sheet.remove()
      if (!sheet) {
        sheet = document.createElement("style")
        sheet.id = "callscribe-caption-space"
        ;(document.head || document.documentElement).appendChild(sheet)
      }
      if (sheet.textContent !== css) sheet.textContent = css
    },

    captionRows() {
      const region = captionRegion()
      if (!region) return []
      const me = selfName()
      const rows = []
      // Each spoken block is a direct child holding [avatar + name] and [caption text].
      for (const row of region.children) {
        if (row.querySelector("button") || row.children.length < 2) continue
        const nameEl = row.firstElementChild
        const textEl = row.lastElementChild
        let speaker = text(nameEl.querySelector("span") || nameEl)
        const said = text(textEl)
        if (!said) continue
        if (me && speaker === "You") speaker = me
        rows.push({ key: row, speaker, text: said })
      }
      return rows
    },

    hints: {
      captionsOff: "Turn on captions in Meet (CC button, or press c) so the transcript can be captured.",
    },
  }

  CS.adapters = CS.adapters || []
  CS.adapters.push(adapter)
})()
