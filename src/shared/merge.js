// Text merging and caption tracking shared by every platform adapter.
// Classic script (content scripts cannot import modules); also loadable from Node for tests.
(function (root) {
  "use strict"

  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim()
  // Scripts written without spaces between words: each character (with its marks) is a token.
  const NO_SPACE = "\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{sc=Thai}\\p{sc=Lao}\\p{sc=Khmer}\\p{sc=Myanmar}"
  const TOKEN = new RegExp(`[${NO_SPACE}]\\p{M}*|[^\\s${NO_SPACE}]+`, "gu")
  const NO_SPACE_CHAR = new RegExp(`[${NO_SPACE}]`, "u")
  const key = (w) => w.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^\p{L}\p{M}\p{N}']+/gu, "")
  // Letters and digits only: compares renderings that differ in spacing, punctuation, case, hyphens.
  const ck = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, "")
  // Tokens with a non-empty key, and where each starts in s (to cut s without re-joining tokens).
  function toks(s) {
    const out = []
    for (const m of s.matchAll(TOKEN)) {
      const k = key(m[0])
      if (k) out.push({ k, i: m.index })
    }
    return out
  }
  const keys = (s) => toks(norm(s)).map((t) => t.k)
  // Joining two pieces of text: no space between characters of scripts written without spaces.
  const join = (a, b) => (NO_SPACE_CHAR.test(a.slice(-1)) || NO_SPACE_CHAR.test(b[0]) ? a + b : a + " " + b)

  // How many of b's first n tokens line up with a starting at i (case/punctuation-insensitive).
  function matchAt(a, i, b, n) {
    let hits = 0
    for (let j = 0; j < n; j++) if (i + j < a.length && a[i + j] === b[j]) hits++
    return hits
  }

  // Smallest edit distance between a and any prefix of b (b may run on past a).
  function prefixDistance(a, b) {
    a = a.slice(0, 200)
    b = b.slice(0, a.length * 2 + 20)
    let row = Array.from({ length: b.length + 1 }, (_, j) => j)
    for (let i = 1; i <= a.length; i++) {
      const next = [i]
      for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      row = next
    }
    return Math.min(...row)
  }

  /**
   * No anchor between prev and next. Is next still a re-rendering of the same speech (numbers
   * written as digits, a filler or hyphen removed, the first word corrected)? A caption UI that
   * reuses a row for a new sentence shares none of this with it.
   */
  function reRendered(pk, nk, pc, nc) {
    // Mostly the same letters, allowing for a correction or two.
    if (pc.length >= 3 && 1 - prefixDistance(pc, nc) / pc.length >= 0.6) return true
    // The same opening letters (one word re-recognised: "I think" -> "I thought so").
    let common = 0
    while (common < pc.length && pc[common] === nc[common]) common++
    if (common >= 3 && common >= pc.length * 0.4) return true
    // prev's last two words appear early in next: the start was re-rendered, the rest carried on.
    if (pk.length >= 2) {
      const a = pk[pk.length - 2], b = pk[pk.length - 1]
      for (let j = 0; j + 1 < Math.min(nk.length, pk.length + 4); j++) if (nk[j] === a && nk[j + 1] === b) return true
    }
    return false
  }

  /**
   * Merge the latest rendering of a caption row into what we already hold for it.
   * Caption UIs grow a row as speech arrives, re-punctuate and fix earlier words as
   * recognition improves, and some trim the front of long rows. Find where the new
   * rendering starts inside the old one (fuzzy, token-level) and splice it in there.
   * Tokens are words, or single characters in scripts written without spaces (CJK, Thai).
   */
  function mergeText(prev, next) {
    return mergeRow(prev, next).text
  }

  // { text, appended }: appended = next was taken as new speech after prev, not a re-rendering of it.
  function mergeRow(prev, next) {
    prev = norm(prev)
    next = norm(next)
    if (!prev) return { text: next }
    if (!next || next === prev) return { text: prev }
    const pc = ck(prev), nc = ck(next)
    // The row grew, or was re-punctuated/re-spaced: newest wins. A shorter rendering is stale.
    if (nc.startsWith(pc)) return { text: next }
    if (pc.startsWith(nc)) return { text: prev }

    const pt = toks(prev), nt = toks(next)
    const pk = pt.map((t) => t.k), nk = nt.map((t) => t.k)
    if (!pk.length || !nk.length) return { text: join(prev, next), appended: true }
    const n = Math.min(6, nk.length)
    const need = n <= 2 ? n : n - 1 // allow one corrected token in the probe

    // A full re-rendering (same start, similar or greater length): newest wins. When next is
    // shorter it must line up with prev all along, or it would drop prev's later text.
    const m0 = Math.min(n, pk.length)
    if (matchAt(pk, 0, nk, m0) >= (m0 <= 2 ? m0 : m0 - 1) && nk.length >= pk.length * 0.6) {
      if (nk.length >= pk.length || matchAt(pk, 0, nk, nk.length) >= nk.length - Math.max(1, Math.floor(nk.length / 5))) return { text: next }
    }

    // Find where next begins inside prev; prefer the latest match (front-trimmed rows).
    let at = -1
    for (let i = pk.length - 1; i >= 1; i--) {
      const w = Math.min(n, pk.length - i)
      if (w < Math.min(3, n)) {
        // Only the last two words of prev are left to overlap: accept an exact two-word overlap.
        if (w === 2 && n >= 2 && pk[i].length > 1 && pk[i + 1].length > 1 && matchAt(pk, i, nk, 2) === 2) {
          at = i
          break
        }
        continue
      }
      // Near the end of prev only a short overlap is visible: require it exactly.
      if (matchAt(pk, i, nk, w) >= (w < n ? w : need)) {
        at = i
        break
      }
    }
    if (at > 0) {
      // Entirely inside prev already (stale fragment)?
      const covered = at + nk.length <= pk.length && matchAt(pk, at, nk, nk.length) >= nk.length - Math.floor(nk.length / 6)
      if (covered) return { text: prev }
      // A short row that lost its first word or two was re-rendered (a filler dropped); only
      // long rows get front-trimmed.
      if (at <= 2 && pk.length <= 6) return { text: next }
      return { text: prev.slice(0, pt[at].i) + next }
    }

    // No anchor: a re-rendering, or a genuinely different continuation.
    if (reRendered(pk, nk, pc, nc)) return { text: next }
    if (pc.includes(nc)) return { text: prev }
    return { text: join(prev, next), appended: true }
  }

  /**
   * One transcript from Meet's caption feed and the captions read from the page. Each source
   * may cover only part of the call (the feed starts late, or dies and CC takes over), so the
   * export is the union, and losing real speech is worse than a repeated fragment: when unsure,
   * both lines are kept.
   * - A page line is dropped only when the feed lines near it (within 3 s, same speaker) hold
   *   all of it, in order: the feed has better timing and speakers.
   * - Otherwise the page line is kept whole, and the feed lines it holds all of are dropped (the
   *   feed started late inside the row, or died mid-sentence).
   * "Holds all of" compares tokens in order (longest common subsequence) and counts only runs of
   * two or more tokens, so scattered shared words, or shared characters in scripts without
   * spaces (character pairs, in effect), don't make different speech the same. A long line may
   * differ in one token in ten inside it (a re-recognised word), never at its start or end.
   * "Unknown…" and "You" match any speaker, and so do "Bob" and "Bob (Acme)"; the kept line shows
   * the fuller name. Sorted by start; extra fields are kept; the inputs are not changed.
   */
  const NEAR_MS = 3000
  const anyone = (s) => !s || /^unknown/i.test(s) || s === "You"
  const unnamed = (s) => !s || /^unknown/i.test(s)
  // "Bob (Acme)" -> "Bob": a trailing "(…)" (organisation, pronouns, guest) only one source shows.
  const bare = (s) => String(s || "").replace(/\s*\([^()]*\)$/, "").trim()
  const sameName = (a, b) => a === b || (Boolean(a) && Boolean(b) && (bare(a) === b || a === bare(b)))
  const sameSpeaker = (a, b) => sameName(a.speaker, b.speaker) || anyone(a.speaker) || anyone(b.speaker)
  // The name for a line both sources hold: a real name over an unnamed one, the fuller over the bare one.
  function fuller(a, b) {
    if (unnamed(a) && !anyone(b)) return b
    if (a !== b && sameName(a, b) && String(b).length > String(a).length) return b
    return a
  }
  // Token keys of a line, remembered: the same finished lines are compared on every save.
  const keyCache = new Map()
  function lineKeys(text) {
    let k = keyCache.get(text)
    if (!k) {
      if (keyCache.size >= 8192) keyCache.clear()
      k = keys(text)
      keyCache.set(text, k)
    }
    return k
  }
  // Alignment cost cap (tokens x tokens). Beyond it nothing counts as held, so both lines are kept.
  const MAX_CELLS = 2000000
  /**
   * Which of a's tokens b holds, in order: a's index -> index into b, or -1. Only runs of at
   * least two tokens that run together in both count (one token when a line has only one).
   */
  function align(a, b) {
    const n = a.length, m = b.length
    const at = new Int32Array(n).fill(-1)
    if (!n || !m || n * m > MAX_CELLS) return at
    const w = m + 1
    const dp = new Uint32Array((n + 1) * w)
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        dp[i * w + j] = a[i - 1] === b[j - 1] ? dp[(i - 1) * w + j - 1] + 1 : Math.max(dp[(i - 1) * w + j], dp[i * w + j - 1])
      }
    }
    const pairs = []
    for (let i = n, j = m; i > 0 && j > 0;) {
      if (a[i - 1] === b[j - 1] && dp[i * w + j] === dp[(i - 1) * w + j - 1] + 1) {
        pairs.push([i - 1, j - 1])
        i--
        j--
      } else if (dp[(i - 1) * w + j] >= dp[i * w + j - 1]) i--
      else j--
    }
    pairs.reverse()
    const minRun = Math.min(2, n, m)
    for (let s = 0; s < pairs.length;) {
      let e = s + 1
      while (e < pairs.length && pairs[e][0] === pairs[e - 1][0] + 1 && pairs[e][1] === pairs[e - 1][1] + 1) e++
      if (e - s >= minRun) for (let r = s; r < e; r++) at[pairs[r][0]] = pairs[r][1]
      s = e
    }
    return at
  }
  // Does b hold all of a? Up to one token in ten may differ inside a, never its first or last.
  // A line of one or two tokens is only held by one about as short ("No." is not inside a long line).
  function holds(at, bLength) {
    const n = at.length
    if (!n) return true
    if (n <= 2 && bLength > n + 2) return false
    if (at[0] < 0 || at[n - 1] < 0) return false
    let miss = 0
    for (let i = 0; i < n; i++) if (at[i] < 0) miss++
    return miss <= Math.floor(n / 10)
  }
  // Alignments remembered: the overlay and every save compare the same finished lines again.
  const alignCache = new Map()
  function alignTexts(aText, bTexts) {
    const id = aText + "\u0000" + bTexts.join("\u0001")
    let r = alignCache.get(id)
    if (!r) {
      if (alignCache.size >= 4096) alignCache.clear()
      const b = [].concat(...bTexts.map(lineKeys))
      r = { at: align(lineKeys(aText), b), length: b.length }
      alignCache.set(id, r)
    }
    return r
  }
  function mergeSources(feed, dom) {
    feed = feed || []
    dom = dom || []
    if (!dom.length) return feed.slice()
    if (!feed.length) return dom.slice()
    // Feed lines by start, so each page line only looks at the few near it (long calls).
    const fs = feed.slice().sort((x, y) => x.start - y.start)
    const longest = fs.reduce((m, f) => Math.max(m, f.end - f.start), 0)
    const dropped = new Set()
    const rename = new Map()
    const kept = []
    for (const d of dom) {
      // Last feed line starting by d.end + NEAR_MS, then back while one could still end near d.
      let lo = 0, hi = fs.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (fs[mid].start <= d.end + NEAR_MS) lo = mid + 1
        else hi = mid
      }
      const near = []
      for (let i = lo - 1; i >= 0 && fs[i].start >= d.start - NEAR_MS - longest; i--) {
        const f = fs[i]
        if (f.end >= d.start - NEAR_MS && sameSpeaker(f, d)) near.push(f)
      }
      if (!near.length) {
        kept.push(d)
        continue
      }
      near.reverse() // start order: the near feed lines read as one run of speech
      const { at, length } = alignTexts(d.text, near.map((f) => f.text))
      if (holds(at, length)) {
        // The feed has all of it. The feed lines holding it take the page's name if fuller.
        const owner = []
        near.forEach((f, x) => { for (let k = lineKeys(f.text).length; k > 0; k--) owner.push(x) })
        for (const j of at) if (j >= 0) {
          const f = near[owner[j]]
          const name = fuller(rename.has(f) ? rename.get(f) : f.speaker, d.speaker)
          if (name !== f.speaker) rename.set(f, name)
        }
        continue
      }
      // The page line has speech the feed lacks: keep it whole, drop the feed lines it holds.
      let speaker = d.speaker
      for (const f of near) {
        const r = alignTexts(f.text, [d.text])
        if (!holds(r.at, r.length)) continue
        dropped.add(f)
        speaker = fuller(speaker, f.speaker)
      }
      kept.push(speaker === d.speaker ? d : { ...d, speaker })
    }
    const out = []
    for (const f of feed) if (!dropped.has(f)) out.push(rename.has(f) ? { ...f, speaker: rename.get(f) } : f)
    // Array sort is stable: lines starting together keep feed-then-page order.
    return out.concat(kept).sort((a, b) => a.start - b.start)
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
  // Roughly how many words: characters of scripts without spaces count as half a word each.
  function wordCount(s) {
    let n = 0
    for (const t of toks(norm(s))) n += NO_SPACE_CHAR.test(t.k) ? 0.5 : 1
    return n
  }
  // A row re-rendered in a fresh element is joined to the entry it continues within this long.
  const REATTACH_MS = 15000
  // A short line (a word or three) is only joined when it is that recent: "Yes." said again is new.
  const REATTACH_SHORT_MS = 3000
  const SHORT_TOKENS = 3
  // Meet labels your own captions "You", and your name once it knows it.
  const SELF = "You"

  class CaptionTracker {
    constructor(now = () => Date.now()) {
      this.now = now
      this.startedAt = now() // lower bound for any backdated caption
      this.entries = []
      this.live = new Map()
      this.selfName = ""
      this.seen = new WeakMap() // entry -> { created, updated }: read times, never backdated
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
        let speaker = norm(row.speaker) || "Unknown"
        if (speaker === SELF && this.selfName) speaker = this.selfName
        let entry = this.live.get(row.key)
        if (entry && speaker !== "Unknown" && entry.speaker !== speaker && entry.speaker !== "Unknown") {
          // The UI reused this row for someone else, unless "You" just got your name and the
          // row carries on the same speech.
          const self = (entry.speaker === SELF) !== (speaker === SELF)
          if (self && !mergeRow(entry.text, text).appended) {
            if (speaker !== SELF) this._learnSelf(speaker)
          } else {
            entry = undefined
          }
        }
        if (!entry) {
          entry = this._reattach(speaker, text, t)
          if (!entry) {
            entry = { speaker, text: "", start: t, end: t }
            this.entries.push(entry)
            this.seen.set(entry, { created: t, updated: t })
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
          this.seen.get(entry).updated = t
          this.dirty = true
        }
      }
      this._backdate(this.entries.slice(firstNew), t, firstNew)
    }

    // "You" is this name: relabel what was captured as "You" so far.
    _learnSelf(name) {
      this.selfName = name
      for (const e of this.entries) if (e.speaker === SELF) e.speaker = name
      this.dirty = true
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
      const len = (e) => Math.max(MIN_TURN_MS, wordCount(e.text) * MS_PER_WORD)
      const isBatch = fresh.length >= 2 || wordCount(fresh[0].text) > LONG_FIRST_SIGHT_WORDS
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

    /**
     * A row re-rendered in a fresh element continues a recent entry instead of duplicating it.
     * Only an entry nobody else has spoken after (a row first read after its last update)
     * qualifies, and a short line only when it is very recent: the same short answer said
     * again ("Yes.", "OK.") is a new line.
     */
    _reattach(speaker, text, t) {
      const live = new Set(this.live.values())
      const tk = keys(text)
      const short = tk.length <= SHORT_TOKENS
      for (let i = this.entries.length - 1; i >= 0 && i >= this.entries.length - 6; i--) {
        const e = this.entries[i]
        if (e.speaker !== speaker) continue
        const updated = this.seen.get(e).updated
        if (live.has(e) || t - updated > (short ? REATTACH_SHORT_MS : REATTACH_MS)) continue
        if (this.entries.slice(i + 1).some((o) => o.speaker !== speaker && this.seen.get(o).created > updated)) break
        const ek = keys(e.text)
        const n = Math.min(4, tk.length, ek.length)
        if (n && matchAt(ek, 0, tk, n) >= n - (n > 2 ? 1 : 0)) return e
        if (!short && ck(e.text).includes(ck(text))) return e
      }
      return undefined
    }

    snapshot() {
      this.dirty = false
      return this.entries.filter((e) => e.text).map((e) => ({ ...e }))
    }

    // Same entries as snapshot(), for display: leaves dirty alone so autosave still fires.
    view() {
      const live = new Set(this.live.values())
      return this.entries
        .filter((e) => e.text)
        .map((e) => ({ speaker: e.speaker, text: e.text, start: e.start, end: e.end, live: live.has(e) }))
    }
  }

  // Common leading letters of two strings.
  function commonPrefix(a, b) {
    let i = 0
    while (i < a.length && a[i] === b[i]) i++
    return i
  }
  // A non-final utterance cut off by a stream restart is continued by the new stream within this long.
  const RESTART_CONTINUE_MS = 15000

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
      this.unnamed = new Map() // device -> number in first-seen order, for "Unknown speaker N"
      this.dirty = false
    }

    add(u, t = this.now()) {
      const text = norm(u.text)
      const epoch = u.epoch || 0
      const key = `${epoch}|${u.device}|${u.id}`
      const e = this.byKey.get(key)
      if (e) {
        if (u.version < e.version) {
          // Ids restarted under us (a resubscription we didn't see): a much lower version with
          // unrelated text is a new utterance, not a late copy of this one.
          if (!(e.version - u.version > 1 && text && commonPrefix(ck(text), ck(e.text)) < 2)) return
          this.byKey.delete(key)
          return this.add(u, t)
        }
        // A re-delivery of the same version never turns a final line live again.
        e.final = u.version === e.version ? e.final || !!u.final : !!u.final
        e.version = u.version
        if (text && text !== e.text) {
          e.text = text
          e.end = t
          this.dirty = true
        }
        return
      }
      if (!text) return
      // The stream restarted mid-utterance: the new stream carries on the old, unfinished one.
      const cont = this._continued(u.device, epoch, text, t)
      if (cont) {
        this.byKey.set(key, cont)
        cont.epoch = epoch
        cont.version = u.version
        cont.final = !!u.final
        if (ck(text).length >= ck(cont.text).length) cont.text = text
        cont.end = t
        this.dirty = true
        return
      }
      if (!this.unnamed.has(u.device)) this.unnamed.set(u.device, this.unnamed.size + 1)
      const entry = { device: u.device, epoch, text, start: t, end: t, version: u.version, final: !!u.final }
      this.byKey.set(key, entry)
      this.entries.push(entry)
      this.dirty = true
    }

    // The device's latest utterance, if it is from an earlier stream, unfinished, recent, and
    // the new text starts the same way.
    _continued(device, epoch, text, t) {
      for (let i = this.entries.length - 1; i >= 0; i--) {
        const e = this.entries[i]
        if (e.device !== device) continue
        if (e.epoch === epoch || e.final || t - e.end > RESTART_CONTINUE_MS) return undefined
        const a = ck(e.text), b = ck(text)
        return Math.min(a.length, b.length) >= 2 && (b.startsWith(a) || a.startsWith(b)) ? e : undefined
      }
      return undefined
    }

    setName(device, name) {
      name = norm(name)
      if (!device || !name || this.names.get(device) === name) return
      this.names.set(device, name)
      if (this.entries.some((e) => e.device === device)) this.dirty = true
    }

    // A device nobody has named is "Unknown speaker N", numbered in the order they first spoke,
    // so two unnamed people are never read as one.
    speaker(device) {
      return this.names.get(device) || `Unknown speaker ${this.unnamed.get(device) || 1}`
    }

    snapshot() {
      this.dirty = false
      return this.entries
        .filter((e) => e.text)
        .map((e) => ({ speaker: this.speaker(e.device), device: e.device, text: e.text, start: e.start, end: e.end }))
    }

    // Same entries as snapshot(), for display: leaves dirty alone so autosave still fires.
    view() {
      return this.entries
        .filter((e) => e.text)
        .map((e) => ({ speaker: this.speaker(e.device), device: e.device, text: e.text, start: e.start, end: e.end, live: !e.final }))
    }
  }

  const api = { mergeText, mergeSources, CaptionTracker, UtteranceTracker, norm }
  root.CallScribe = Object.assign(root.CallScribe || {}, api)
  if (typeof module !== "undefined" && module.exports) module.exports = api
})(typeof globalThis !== "undefined" ? globalThis : this)
