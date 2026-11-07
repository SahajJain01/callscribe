// Text merging and caption tracking shared by every platform adapter.
// Classic script (content scripts cannot import modules); also loadable from Node for tests.
(function (root) {
  "use strict"

  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim()
  const key = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "")
  const words = (s) => norm(s).split(" ").filter(Boolean)

  // How many of b's first n words line up with a starting at i (case/punctuation-insensitive).
  function matchAt(a, i, b, n) {
    let hits = 0
    for (let j = 0; j < n; j++) if (i + j < a.length && a[i + j] === b[j]) hits++
    return hits
  }

  /**
   * Merge the latest rendering of a caption row into what we already hold for it.
   * Caption UIs grow a row as speech arrives, re-punctuate and fix earlier words as
   * recognition improves, and some trim the front of long rows. Find where the new
   * rendering starts inside the old one (fuzzy, word-level) and splice it in there.
   */
  function mergeText(prev, next) {
    prev = norm(prev)
    next = norm(next)
    if (!prev) return next
    if (!next || next === prev) return prev

    const pw = words(prev), nw = words(next)
    const pk = pw.map(key), nk = nw.map(key)
    const n = Math.min(6, nk.length)
    const need = n <= 2 ? n : n - 1 // allow one corrected word in the probe

    // A full re-rendering (same start, similar or greater length): newest wins.
    const m0 = Math.min(n, pk.length)
    if (matchAt(pk, 0, nk, m0) >= (m0 <= 2 ? m0 : m0 - 1) && nk.length >= pk.length * 0.6) return next

    // Find where next begins inside prev; prefer the latest match (front-trimmed rows).
    let at = -1
    for (let i = pk.length - 1; i >= 0; i--) {
      const w = Math.min(n, pk.length - i)
      if (w < Math.min(3, n)) continue
      // Near the end of prev only a short overlap is visible: require it exactly.
      if (matchAt(pk, i, nk, w) >= (w < n ? w : need)) {
        at = i
        break
      }
    }
    if (at === 0 && nk.length < pk.length * 0.6) {
      // Same start but much shorter: a stale or partial rendering.
      return prev
    }
    if (at > 0) {
      // Entirely inside prev already (stale fragment)?
      const covered = at + nk.length <= pk.length && matchAt(pk, at, nk, nk.length) >= nk.length - Math.floor(nk.length / 6)
      if (covered) return prev
      return pw.slice(0, at).concat(nw).join(" ")
    }
    if (at === 0) return next

    // No anchor at all: a genuinely different continuation.
    if (key(prev).includes(key(next))) return prev
    return prev + " " + next
  }

  /**
   * Turns repeated snapshots of visible caption rows into a list of utterances.
   * rows: [{ key, speaker, text }] where key identifies one on-screen row (usually its element).
   */
  // Speech is ~150 words a minute; used only to backdate captions that arrive in a batch.
  const MS_PER_WORD = 400
  const MIN_TURN_MS = 1000
  // A row that first shows up already this long was not seen while it was being spoken.
  const LONG_FIRST_SIGHT_WORDS = 12

  class CaptionTracker {
    constructor(now = () => Date.now()) {
      this.now = now
      this.startedAt = now() // lower bound for any backdated caption
      this.entries = []
      this.live = new Map()
      this.dirty = false
    }

    update(rows) {
      const t = this.now()
      const seen = new Set(rows.filter((r) => norm(r.text)).map((r) => r.key))
      for (const k of [...this.live.keys()]) if (!seen.has(k)) this.live.delete(k)
      const firstNew = this.entries.length
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
      this._backdate(this.entries.slice(firstNew), t, firstNew)
    }

    /**
     * Captions normally appear a few words at a time, so "first seen" is "when it was said".
     * When the page applies a backlog at once (tab not drawn, extension attached mid-call),
     * several turns, or one already-long turn, appear in a single read. Instead of stamping
     * them all with the read time, lay them out backwards from it by their length, never
     * before the last caption we saw live (or the session start), and flag them as estimates.
     */
    _backdate(fresh, t, firstNew) {
      if (!fresh.length) return
      const len = (e) => Math.max(MIN_TURN_MS, words(e.text).length * MS_PER_WORD)
      const isBatch = fresh.length >= 2 || words(fresh[0].text).length > LONG_FIRST_SIGHT_WORDS
      if (!isBatch) return
      const prev = this.entries[firstNew - 1]
      const floor = Math.max(this.startedAt, prev ? prev.end : -Infinity)
      const total = fresh.reduce((s, e) => s + len(e), 0)
      const span = Math.max(0, t - floor)
      const scale = total > span ? span / total : 1
      let cursor = t
      for (let i = fresh.length - 1; i >= 0; i--) {
        const e = fresh[i]
        const d = len(e) * scale
        e.end = Math.round(cursor)
        e.start = Math.round(cursor - d)
        cursor -= d
        if (t - e.start > 2000) e.estimated = true
      }
      // Keep starts strictly increasing even when squeezed into a tiny window.
      for (let i = 1; i < fresh.length; i++) if (fresh[i].start <= fresh[i - 1].start) fresh[i].start = fresh[i - 1].start + 1
      this.dirty = true
    }

    // A row re-rendered in a fresh element continues a recent entry instead of duplicating it.
    _reattach(speaker, text, t) {
      const live = new Set(this.live.values())
      const tk = words(text).map(key)
      for (let i = this.entries.length - 1; i >= 0 && i >= this.entries.length - 6; i--) {
        const e = this.entries[i]
        if (live.has(e) || e.speaker !== speaker || t - e.end > 15000) continue
        const ek = words(e.text).map(key)
        const n = Math.min(4, tk.length, ek.length)
        if (n && matchAt(ek, 0, tk, n) >= n - (n > 2 ? 1 : 0)) return e
        if (key(e.text).includes(key(text))) return e
      }
      return undefined
    }

    snapshot() {
      this.dirty = false
      return this.entries.filter((e) => e.text).map((e) => ({ ...e }))
    }
  }

  /**
   * Utterances from a structured caption stream (Meet's captions_v2 channel), where every update
   * carries an utterance's whole current text and a version. No text merging is needed: the
   * highest version wins. Timed by arrival; speakers are device ids, named at snapshot time.
   * u: { id, version, text, final, device, epoch } (epoch separates resubscriptions, which may
   * reuse ids).
   */
  class UtteranceTracker {
    constructor(now = () => Date.now()) {
      this.now = now
      this.entries = []
      this.byKey = new Map()
      this.names = new Map()
      this.dirty = false
    }

    add(u, t = this.now()) {
      const text = norm(u.text)
      const key = `${u.epoch || 0}|${u.device}|${u.id}`
      const e = this.byKey.get(key)
      if (e) {
        if (u.version < e.version) return
        e.version = u.version
        if (text && text !== e.text) {
          e.text = text
          e.end = t
          this.dirty = true
        }
        return
      }
      if (!text) return
      const entry = { device: u.device, text, start: t, end: t, version: u.version }
      this.byKey.set(key, entry)
      this.entries.push(entry)
      this.dirty = true
    }

    setName(device, name) {
      name = norm(name)
      if (!device || !name || this.names.get(device) === name) return
      this.names.set(device, name)
      if (this.entries.some((e) => e.device === device)) this.dirty = true
    }

    snapshot() {
      this.dirty = false
      return this.entries
        .filter((e) => e.text)
        .map((e) => ({ speaker: this.names.get(e.device) || "Unknown", text: e.text, start: e.start, end: e.end }))
    }
  }

  const api = { mergeText, CaptionTracker, UtteranceTracker, norm }
  root.CallScribe = Object.assign(root.CallScribe || {}, api)
  if (typeof module !== "undefined" && module.exports) module.exports = api
})(typeof globalThis !== "undefined" ? globalThis : this)
