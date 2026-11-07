// The capture -> export state machine, as pure functions over a session row (the service
// worker does the I/O). ES module (background, tests).
//
// A session row goes:   live (todo=1)  ->  ended + export job  ->  done | failed | off
//
// session.export = {
//   state: "pending" | "running" | "done" | "failed" | "off",   off = auto-download was off
//   folder, base,          pinned when the call ended: Downloads/<folder>/<base>.<ext>
//   owner, claimedAt,      the worker instance running it (a dead worker's claim is taken over)
//   attempts, nextAttemptAt,
//   files: { audio?, transcript? }  each { state: "starting"|"in_progress"|"complete"|"interrupted",
//                                         downloadId, name (asked for), filename (written), error }
//   log: [{ t, attempt, error }]   last errors, kept after success
// }
// session.todo = 1 while the sweep has work (live, or export pending/running): indexed, so
// recovery queries it directly instead of scanning the newest N rows.
// session.exportDoneAt: set when every file reached chrome.downloads state "complete";
// the row (and its audio) is deleted RETENTION_MS later. Nothing else is ever auto-deleted.

export const STALE_MS = 2 * 60 * 1000
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const RETRY_DELAYS = [15 * 1000, 60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000] // after attempt 1, 2, 3, 4
export const MAX_ATTEMPTS = RETRY_DELAYS.length + 1
export const MAX_CHUNK_BYTES = 2 * 1024 * 1024
// 48 kbps is 6 KB/s; allow ten times that plus slack before calling it a disk-fill attempt.
const CHUNK_BUDGET_BASE = 4 * 1024 * 1024
const CHUNK_BUDGET_PER_S = 64 * 1024
const AUDIO_MIME = /^audio\/(webm|ogg)(;|$)/

// When a session ended. A normal end (left, page closed, tab closed) is when it happened
// (eventAt, reported by the tab or recorded when the tab closed), not when finalize got to it.
// A stale one (Chrome or the tab crashed and nothing said goodbye) ends at its last saved
// update: we can't know how long Chrome was down. The end is never before the start, whatever
// the clock did, and never after now.
export function endTime(session, reason, now, eventAt) {
  const start = session.startedAt || 0
  const last = Math.max(session.updatedAt || start, start)
  if (reason === "stale") return last
  if (Number.isFinite(eventAt)) return Math.max(start, Math.min(eventAt, Math.max(now, start)))
  return Math.max(last, now)
}

export function needsWork(s) {
  if (!s.endedAt) return true
  const st = s.export && s.export.state
  return st === "pending" || st === "running"
}

function setTodo(s) {
  if (needsWork(s)) s.todo = 1
  else delete s.todo
}

function newJob(folder, base) {
  return { state: "pending", folder, base, attempts: 0, nextAttemptAt: 0, files: {}, log: [] }
}

/** End a live session once; later calls (a second finalizer) change nothing. */
export function markEnded(s, { reason, at, now, autoDownload, folder, base }) {
  if (s.endedAt) return s
  s.endedAt = endTime(s, reason, now, at)
  s.endReason = reason
  s.export = autoDownload ? newJob(folder, base) : { state: "off" }
  setTodo(s)
  return s
}

/** Manual "save again": a fresh job (new attempt count), same file names unless given. */
export function resetExport(s, { folder, base }) {
  const prev = s.export || {}
  s.export = newJob(prev.folder || folder, prev.base || base)
  s.export.log = (prev.log || []).slice(-10)
  delete s.exportDoneAt
  setTodo(s)
  return s
}

/**
 * Take the export job for this worker instance. Allowed when it's pending and due, or when
 * it's running under another instance (that worker died mid-export: resume the same attempt,
 * keeping the files it already saved). Returns whether the caller now owns it.
 */
export function claimExport(s, owner, now) {
  const job = s && s.endedAt && s.export
  if (!job) return false
  if (job.state === "pending" && now >= (job.nextAttemptAt || 0)) {
    job.attempts = (job.attempts || 0) + 1
  } else if (!(job.state === "running" && job.owner !== owner)) {
    return false
  }
  job.state = "running"
  job.owner = owner
  job.claimedAt = now
  job.files = job.files || {}
  setTodo(s)
  return true
}

const baseName = (p) => String(p || "").split(/[\\/]/).pop()

/** What a chrome.downloads item says about one output file. */
export function downloadOutcome(item) {
  if (!item) return { state: "missing" }
  if (item.state === "complete") return { state: "complete", filename: baseName(item.filename) }
  if (item.state === "interrupted") return { state: "interrupted", error: item.error || "INTERRUPTED" }
  return { state: "in_progress" }
}

/** Audio first: the transcript names the audio file that was actually written. */
export function outputsFor(s) {
  return s.audio && s.audio.chunks > 0 ? ["audio", "transcript"] : ["transcript"]
}

/** keep: already saved. check: a download is under way. find: the worker died between asking
 * for a download and recording its id, so look for it before starting another. start: (again). */
export function outputAction(file) {
  if (!file) return "start"
  if (file.state === "complete") return "keep"
  if (file.state === "in_progress" && file.downloadId != null) return "check"
  if (file.state === "starting") return "find"
  return "start"
}

/** The audio file name for the transcript header: a name, null (audio not saved) or undefined (no audio). */
export function transcriptAudioRef(s) {
  if (!(s.audio && s.audio.chunks > 0)) return undefined
  const a = s.export && s.export.files && s.export.files.audio
  return a && a.state === "complete" && a.filename ? a.filename : null
}

/** The transcript waits for its audio file, so its header can name it; the last attempt writes it regardless. */
export function mayWriteTranscript(s) {
  if (transcriptAudioRef(s) !== null) return true
  return ((s.export && s.export.attempts) || 0) >= MAX_ATTEMPTS
}

/** After an attempt: done if every output is complete, else retry later or give up. */
export function settleExport(s, now) {
  const job = s.export
  const files = job.files || {}
  const errors = []
  for (const k of outputsFor(s)) {
    const f = files[k]
    if (!f || f.state !== "complete") errors.push(`${k}: ${(f && f.error) || (f && f.state === "in_progress" ? "still downloading" : "not saved")}`)
  }
  delete job.owner
  if (!errors.length) {
    job.state = "done"
    job.doneAt = now
    s.exportDoneAt = now
    s.exportErrors = []
  } else {
    job.log = (job.log || []).concat(errors.map((error) => ({ t: now, attempt: job.attempts, error }))).slice(-10)
    s.exportErrors = errors
    if ((job.attempts || 0) >= MAX_ATTEMPTS) {
      job.state = "failed"
    } else {
      job.state = "pending"
      job.nextAttemptAt = now + RETRY_DELAYS[Math.max(0, (job.attempts || 1) - 1)]
    }
  }
  setTodo(s)
  return s
}

/** Retention (user decision): 30 days after a confirmed export. Never for failed, off or legacy rows. */
export function retentionDue(s, now) {
  return Boolean(s && s.export && s.export.state === "done" && s.exportDoneAt && now - s.exportDoneAt >= RETENTION_MS)
}

/** A live session is over if its tab is gone, or if it hasn't answered for the stale window. */
export function isStale(s, { alive, tabExists, now }) {
  if (s.endedAt || alive) return false
  if (!tabExists) return true
  return now - (s.updatedAt || s.startedAt) > STALE_MS
}

/** p, or fallback if it rejects or takes longer than ms. */
export function withTimeout(p, ms, fallback) {
  let timer
  const t = new Promise((r) => { timer = setTimeout(() => r(fallback), ms) })
  return Promise.race([Promise.resolve(p).catch(() => fallback), t]).finally(() => clearTimeout(timer))
}

/** One run at a time per key: callers that overlap share it. */
export function singleFlight(fn) {
  const running = new Map()
  return (key) => {
    if (!running.has(key)) running.set(key, Promise.resolve().then(() => fn(key)).finally(() => running.delete(key)))
    return running.get(key)
  }
}

/** Whether to store an audio chunk. { ok } or { error, fatal } (fatal: the tab must not retry). */
export function acceptChunk(s, { tabId, seq, size, mime, now }, { tombstone } = {}) {
  const no = (error) => ({ error, fatal: true })
  if (tombstone) return no("session deleted")
  if (!s) return no("no such session")
  if (s.tabId !== tabId) return no("session belongs to another tab")
  const st = s.export && s.export.state
  if (st === "running" || st === "done" || st === "failed") return no("session closed")
  if (!Number.isInteger(seq) || seq < 0 || seq > 1e7) return no("bad seq")
  if (!Number.isInteger(size) || size <= 0 || size > MAX_CHUNK_BYTES) return no("bad chunk size")
  if (typeof mime !== "string" || !AUDIO_MIME.test(mime)) return no("bad mime")
  const budget = CHUNK_BUDGET_BASE + (Math.max(0, now - s.startedAt) / 1000) * CHUNK_BUDGET_PER_S
  if (((s.audio && s.audio.bytes) || 0) + size > budget) return no("audio over budget")
  return { ok: true }
}

/** list/get/delete/export-*: only the extension's own popup page (also when opened in a tab). */
export function isLibrarySender(sender, extId, origin) {
  return Boolean(sender && sender.id === extId && typeof sender.url === "string" && sender.url.startsWith(origin + "src/popup/"))
}

/** Session messages: only from the tab that started the session. */
export function ownsSession(s, sender) {
  return Boolean(s && sender && sender.tab && sender.tab.id != null && s.tabId === sender.tab.id)
}

/** The random tail of a session id, safe for a file name. */
export function shortId(id) {
  return String(id || "").split("-").pop().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6)
}

/** Readable name plus a short session id: two calls never share a file name (F9). */
export function exportBase(readable, id) {
  const sid = shortId(id)
  return sid ? `${readable}_${sid}` : readable
}
