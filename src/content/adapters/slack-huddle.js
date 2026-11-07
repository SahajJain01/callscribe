// Slack huddle adapter (Slack web client, app.slack.com).
// Caption hooks come from OpenClaw's slack-huddles plugin (MIT, verified 2026-09-26):
// https://github.com/openclaw/openclaw/blob/main/extensions/slack-huddles/src/transports/slack-huddles-selectors.ts
// Slack only shows captions when you turn them on in the huddle (or enable
// Preferences > Audio & video > "Turn on captions by default when joining huddles").
;(function () {
  "use strict"
  const CS = (globalThis.CallScribe = globalThis.CallScribe || {})
  const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "")
  const first = (sels, root = document) => {
    for (const s of sels) {
      const el = root.querySelector(s)
      if (el) return el
    }
    return null
  }

  const SEL = {
    inCall: [
      '[data-qa="huddle_toolbar__leave_button"]',
      '[data-qa="huddle_mini_player_leave_button"]',
      '[data-qa="huddle_sidebar_footer"]',
      '[data-qa="huddle_toolbar_buttons_center"]',
    ],
    title: ['[data-qa="huddle_window_titlebar_title"]', '[data-qa="huddle_details_title"]', '[data-qa="huddle_mini_player_title"]'],
    captions: [".p-huddle_closed_captions", '[data-qa="huddle_transcribe_event"]', ".p-huddle_closed_caption_event__event_text"],
    row: '.p-huddle_closed_caption_event__wrapper, [data-qa="huddle_transcribe_event"]',
    rowFallback: ":has(> .p-huddle_closed_caption_event__member_name):has(> .p-huddle_closed_caption_event__event_text)",
    author: ".p-huddle_closed_caption_event__member_name",
    text: ['.p-huddle_closed_caption_event__event_text span[data-qa="huddle_closed_caption_event"]', ".p-huddle_closed_caption_event__event_text"],
    captionsButton: ['[data-qa="huddle_toolbar_captions_button"]', 'button[aria-label="Turn on captions"]', 'button[aria-label="Show captions"]'],
    micSwitch: ['button[role="switch"][aria-describedby="microphone-info"]', 'button[role="switch"][aria-label="Microphone"]'],
    muteButton: ['[data-qa="huddle_sidebar_footer_mute_button"]', '[data-qa="segmented-mute-button-main"]', 'button[aria-describedby="microphone-info"]'],
  }

  const adapter = {
    id: "slack-huddle",
    name: "Slack huddle",
    matches: (loc) => /(^|\.)slack\.com$/.test(loc.hostname),
    captionContainer: ".p-huddle_closed_captions",

    inCall() {
      return Boolean(first(SEL.inCall))
    },

    title() {
      const t = text(first(SEL.title))
      // "Huddle in #general" -> "#general"; "Huddle with Alice" stays as it is.
      if (t) return t.replace(/^Huddle in\s+/i, "") || t
      const ch = text(document.querySelector('[data-qa="channel_name_button"]'))
      return ch ? `Huddle in ${ch}` : ""
    },

    /**
     * true = muted, false = live, undefined = can't tell (the mic is then not recorded).
     * Language-independent signals first: the mic switch is the one described by
     * #microphone-info, and its aria-checked is the state; the mic icons carry data-qa.
     * The English label is only a last resort.
     */
    selfMuted() {
      const sw = first(SEL.micSwitch)
      const checked = sw && sw.getAttribute("aria-checked")
      if (checked === "true" || checked === "false") return checked !== "true"
      if (document.querySelector('[data-qa="huddle_mic_icon_mute"]')) return true
      if (document.querySelector('[data-qa="huddle_mic_icon_unmute"]')) return false
      const b = first(SEL.muteButton)
      const label = b && (b.getAttribute("aria-label") || "")
      if (/^unmute/i.test(label)) return true
      if (/^mute/i.test(label)) return false
      return undefined
    },

    /** The control that mutes/unmutes you (a press on it closes the mic gate at once). */
    micToggle() {
      return first([...SEL.micSwitch, ...SEL.muteButton])
    },

    captionsOn() {
      return Boolean(first(SEL.captions))
    },

    enableCaptions() {
      first(SEL.captionsButton)?.click()
    },

    captionRows() {
      let rows = [...document.querySelectorAll(SEL.row)]
      if (!rows.length) {
        try {
          rows = [...document.querySelectorAll(SEL.rowFallback)]
        } catch {
          rows = []
        }
      }
      // Slack groups consecutive captions from one person under one name label: a row without
      // one takes the nearest label before it. Each element is looked at once per read.
      const speakers = new Map()
      const speakerOf = (row) => {
        const walked = []
        let found = ""
        for (let el = row; el; el = el.previousElementSibling) {
          if (speakers.has(el)) {
            found = speakers.get(el)
            break
          }
          walked.push(el)
          found = text(el.querySelector(SEL.author))
          if (found) break
        }
        for (const el of walked) speakers.set(el, found)
        return found
      }
      const out = []
      for (const row of rows) {
        const said = text(first(SEL.text, row)) || (row.matches('[data-qa="huddle_transcribe_event"]') ? text(row) : "")
        if (!said) continue
        out.push({ key: row, speaker: speakerOf(row), text: said })
      }
      return out
    },

    hints: {
      captionsOff: "Turn on captions in the huddle (CC button), or enable Slack Preferences > Audio & video > captions by default.",
    },
  }

  CS.adapters = CS.adapters || []
  CS.adapters.push(adapter)
})()
