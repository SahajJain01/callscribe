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
  }

  const adapter = {
    id: "slack-huddle",
    name: "Slack huddle",
    matches: (loc) => /(^|\.)slack\.com$/.test(loc.hostname),

    inCall() {
      return Boolean(first(SEL.inCall))
    },

    title() {
      const t = text(first(SEL.title))
      if (t) return t.replace(/^Huddle( in)?\s*/i, "") || t
      const ch = text(document.querySelector('[data-qa="channel_name_button"]'))
      return ch ? `Huddle in ${ch}` : ""
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
      const out = []
      for (const row of rows) {
        const said = text(first(SEL.text, row)) || (row.matches('[data-qa="huddle_transcribe_event"]') ? text(row) : "")
        if (!said) continue
        // Slack groups consecutive captions from one person under one name label.
        let speaker = text(row.querySelector(SEL.author))
        if (!speaker) {
          let prev = row.previousElementSibling
          while (prev && !speaker) {
            speaker = text(prev.querySelector(SEL.author))
            prev = prev.previousElementSibling
          }
        }
        out.push({ key: row, speaker, text: said })
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
