// Google Meet adapter. Reads the live captions panel Meet renders when CC is on.
// Hooks verified against meet.google.com on 2026-11-04 (English UI; icon-name fallbacks are locale-free).
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

  function selfName() {
    const b = [...document.querySelectorAll("button[aria-label^='More options for ']")][0]
    return b ? b.getAttribute("aria-label").replace("More options for ", "").trim() : ""
  }

  const adapter = {
    id: "google-meet",
    name: "Google Meet",
    matches: (loc) => loc.hostname === "meet.google.com",
    captionContainer: '[role="region"][aria-label="Captions"]',

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

    /** true = muted, false = live, undefined = can't tell */
    selfMuted() {
      if (document.querySelector('button[aria-label^="Turn on microphone"]')) return true
      if (document.querySelector('button[aria-label^="Turn off microphone"]')) return false
      const b = document.querySelector("button[data-is-muted]")
      return b ? b.getAttribute("data-is-muted") === "true" : undefined
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
