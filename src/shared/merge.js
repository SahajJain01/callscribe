// Text merging and caption tracking shared by every platform adapter.
// Classic script (content scripts cannot import modules); also loadable from Node for tests.
(function (root) {
  "use strict"

  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim()

  /**
   * Merge the latest rendering of a caption row into what we already have for it.
   * Caption UIs grow a row as speech arrives, rewrite recent words as recognition
   * improves, and some trim the front of long rows. Keep the longest faithful text.
   */
  function mergeText(prev, next) {
    prev = norm(prev)
    next = norm(next)
    if (!prev) return next
    if (!next || next === prev) return prev

    // Same beginning: the row grew or recent words were refined. The newest rendering wins.
    const head = Math.min(20, prev.length, next.length)
    if (next.slice(0, head).toLowerCase() === prev.slice(0, head).toLowerCase()) return next

    // A stale, shorter rendering we already hold.
    if (prev.includes(next)) return prev

    // The front was trimmed: the end of prev overlaps the start of next.
    for (let k = Math.min(prev.length, next.length); k >= 12; k--) {
      if (prev.endsWith(next.slice(0, k))) return prev + next.slice(k)
    }

    // Trimmed and refined: anchor the first words of next inside prev.
    const words = next.split(" ")
    for (let n = Math.min(4, words.length); n >= 2; n--) {
      const anchor = words.slice(0, n).join(" ").toLowerCase()
      const i = prev.toLowerCase().lastIndexOf(anchor)
      if (i > 0) return prev.slice(0, i) + next
    }

    return prev + " " + next
  }

  const sameStart = (a, b) => {
    const head = Math.min(20, a.length, b.length)
    return head > 0 && a.slice(0, head).toLowerCase() === b.slice(0, head).toLowerCase()
  }

  /**
   * Turns repeated snapshots of visible caption rows into a list of utterances.
   * rows: [{ key, speaker, text }] where key identifies one on-screen row (usually its element).
   */
  class CaptionTracker {
    constructor(now = () => Date.now()) {
      this.now = now
      this.entries = []
      this.live = new Map()
      this.dirty = false
    }

    update(rows) {
      const t = this.now()
      const seen = new Set(rows.filter((r) => norm(r.text)).map((r) => r.key))
      for (const key of [...this.live.keys()]) if (!seen.has(key)) this.live.delete(key)
      for (const row of rows) {
        const text = norm(row.text)
        if (!text) continue
        const speaker = norm(row.speaker) || "Unknown"
        let entry = this.live.get(row.key)
        if (entry && speaker !== "Unknown" && entry.speaker !== speaker && entry.speaker !== "Unknown") {
          entry = undefined // the UI reused this row for someone else
        }
        if (!entry) {
          entry = this._reattach(speaker, text, t)
          if (!entry) {
            entry = { speaker, text: "", start: t, end: t }
            this.entries.push(entry)
          }
          this.live.set(row.key, entry)
        }
        if (entry.speaker === "Unknown" && speaker !== "Unknown") {
          entry.speaker = speaker
          this.dirty = true
        }
        const merged = mergeText(entry.text, text)
        if (merged !== entry.text) {
          entry.text = merged
          entry.end = t
          this.dirty = true
        }
      }
    }

    // A row re-rendered in a fresh element continues a recent entry instead of duplicating it.
    _reattach(speaker, text, t) {
      const live = new Set(this.live.values())
      for (let i = this.entries.length - 1; i >= 0 && i >= this.entries.length - 6; i--) {
        const e = this.entries[i]
        if (live.has(e) || e.speaker !== speaker || t - e.end > 15000) continue
        if (sameStart(e.text, text) || e.text.includes(text)) return e
      }
      return undefined
    }

    snapshot() {
      this.dirty = false
      return this.entries.filter((e) => e.text).map((e) => ({ ...e }))
    }
  }

  const api = { mergeText, CaptionTracker, norm }
  root.CallScribe = Object.assign(root.CallScribe || {}, api)
  if (typeof module !== "undefined" && module.exports) module.exports = api
})(typeof globalThis !== "undefined" ? globalThis : this)
