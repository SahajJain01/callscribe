// Service worker: stores sessions as they stream in, and saves the transcript and audio
// backup to Downloads/CallScribe/ when a call ends (or its tab disappears).
//
// Export is a durable job on the session row (see src/shared/lifecycle.js): the call is marked
// ended once, a worker instance claims the job, every download id is stored before it's waited
// on, and only chrome.downloads state "complete" counts. A job left by a worker that died is
// resumed (downloads it had started are found and adopted, not repeated); failed or canceled
// downloads are retried by the sweep with backoff. The sweep (alarm, startup, install) finds
// work through the "todo" index, not the newest N rows, and also applies retention (30 days
// after a confirmed export) and collects orphan chunk rows.
//
// Who may send what: session messages only from the tab that started the session; library
// calls (list/get/delete/export) only from the popup page.
import * as db from "../shared/db.js"
import { formatTranscript, fileBase } from "../shared/format.js"
import * as L from "../shared/lifecycle.js"

const DEFAULTS = { recordAudio: true, includeMic: true, autoCaptions: true, hideCaptions: true, showOverlay: true, autoDownload: true, folder: "CallScribe" }
const INSTANCE = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const PROBE_MS = 3000 // a tab that doesn't answer tab-status in this time counts as not answering
const TAB_CLOSE_WAIT_MS = 7000 // let the tab's own session-end land first
const DOWNLOAD_WAIT_MS = 60 * 1000
const TOMBSTONE_KEEP_MS = 7 * 24 * 60 * 60 * 1000
const ORIGIN = chrome.runtime.getURL("")
const SESSION_ID = /^[\w-]{1,120}$/

async function settings() {
  const r = await chrome.storage.local.get("settings")
  return { ...DEFAULTS, ...(r.settings || {}) }
}

chrome.runtime.onInstalled.addListener(async () => {
  const r = await chrome.storage.local.get("settings")
  await chrome.storage.local.set({ settings: { ...DEFAULTS, ...(r.settings || {}) } })
  sweep()
})

function b64ToBytes(b64) {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

function utf8DataUrl(text, mime) {
  const bytes = new TextEncoder().encode(text)
  let s = ""
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return `data:${mime};charset=utf-8;base64,${btoa(s)}`
}

// Writes for one session run one after another; finalize and the export claim queue behind
// them, so a chunk that arrived before session-end is stored before the export reads chunks.
const chains = new Map()
function serial(id, fn) {
  const p = (chains.get(id) || Promise.resolve()).then(fn, fn)
  const tail = p.catch(() => {})
  chains.set(id, tail)
  tail.then(() => { if (chains.get(id) === tail) chains.delete(id) })
  return p
}

// ---- offscreen document turns stored chunks into a blob: URL Chrome can download
let creatingOffscreen = null
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) return
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({ url: "src/offscreen/offscreen.html", reasons: ["BLOBS"], justification: "Build audio files from recorded chunks for download" })
      .catch((e) => { if (!/single offscreen/i.test(String(e))) throw e })
      .finally(() => { creatingOffscreen = null })
  }
  await creatingOffscreen
}

async function audioUrl(id) {
  await ensureOffscreen()
  const r = await chrome.runtime.sendMessage({ target: "offscreen", type: "make-url", id })
  if (!r || !r.url) throw new Error(r && r.error ? r.error : "could not build audio file")
  return { url: r.url, ext: /ogg/.test(r.mime) ? "ogg" : "webm", revoke: () => chrome.runtime.sendMessage({ target: "offscreen", type: "revoke", url: r.url }).catch(() => {}) }
}

const searchId = (id) => chrome.downloads.search({ id }).then((a) => a[0], () => undefined)

/** Wait until a download is complete or interrupted (or ms pass): its outcome. */
function waitDownload(id, ms = DOWNLOAD_WAIT_MS) {
  return new Promise((resolve) => {
    let timer = 0
    let settled = false
    const finish = (item) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      chrome.downloads.onChanged.removeListener(onChanged)
      resolve(L.downloadOutcome(item))
    }
    const check = () => searchId(id).then((item) => { if (!item || item.state !== "in_progress") finish(item) })
    const onChanged = (d) => { if (d.id === id && d.state) check() }
    chrome.downloads.onChanged.addListener(onChanged)
    timer = setTimeout(() => searchId(id).then(finish), ms)
    check()
  })
}

/** The download this job asked for (file.name, possibly uniquified), started after it asked: the newest one. */
async function findDownload(file) {
  const want = file.name.split("/").pop()
  const stem = want.slice(0, want.lastIndexOf("."))
  const items = await chrome.downloads.search({ query: [stem] }).catch(() => [])
  const mine = items.filter((d) => L.adoptable(d, file, chrome.runtime.id))
  return mine.sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)))[0]
}

// ---- the export job
async function saveFile(id, kind, rec) {
  await db.updateSession(id, (cur) => {
    if (!cur.export || cur.export.owner !== INSTANCE) return false
    cur.export.files = { ...(cur.export.files || {}), [kind]: rec }
  })
  return rec
}

async function ensureOutput(s, kind) {
  const job = s.export
  let f = job.files[kind]
  const act = L.outputAction(f)
  if (act === "keep" || act === "skip") return f
  if (act === "find") {
    const item = await findDownload(f)
    f = item ? await saveFile(s.id, kind, { ...f, state: "in_progress", downloadId: item.id }) : undefined
  }
  if (f && f.state === "in_progress" && f.downloadId != null) {
    const out = await waitDownload(f.downloadId)
    if (out.state !== "missing") return saveFile(s.id, kind, { ...f, ...out })
  }
  // Start (again). The name is pinned on the job, so a retry writes the same file name.
  let src
  try {
    src = kind === "audio"
      ? await audioUrl(s.id)
      : { url: utf8DataUrl(formatTranscript(s, { audioFile: L.transcriptAudioRef(s) }), "text/markdown"), ext: "md", revoke: () => {} }
  } catch (e) {
    return saveFile(s.id, kind, { state: "interrupted", error: String((e && e.message) || e) })
  }
  const name = `${job.folder}/${job.base}.${src.ext}`
  // requestedAt: on resume, only a download that started after this may be adopted (review I-3).
  await saveFile(s.id, kind, { state: "starting", name, requestedAt: Date.now() })
  let downloadId
  try {
    downloadId = await chrome.downloads.download({ url: src.url, filename: name, conflictAction: "uniquify", saveAs: false })
  } catch (e) {
    src.revoke()
    return saveFile(s.id, kind, { state: "interrupted", name, error: String((e && e.message) || e) })
  }
  await saveFile(s.id, kind, { state: "in_progress", name, downloadId })
  const out = await waitDownload(downloadId)
  if (out.state !== "in_progress") src.revoke()
  else setTimeout(src.revoke, 10 * 60 * 1000)
  return saveFile(s.id, kind, { state: out.state === "missing" ? "interrupted" : out.state, name, downloadId, ...(out.filename ? { filename: out.filename } : {}), ...(out.error ? { error: out.error } : {}) })
}

// One run per session at a time (two finalizers, a sweep and a download event share it);
// the durable claim keeps a second worker instance out and lets a later one resume.
const runExport = L.singleFlight(async (id) => {
  let claimed = false
  let s = await serial(id, () => db.updateSession(id, (cur) => ((claimed = L.claimExport(cur, INSTANCE, Date.now())) ? cur : false)))
  if (!claimed) return
  try {
    // Audio first so the transcript can name the file; the transcript is written whatever
    // happened to the audio (then its header says the audio backup was not saved).
    for (const kind of L.outputsFor(s)) {
      const rec = await ensureOutput(s, kind)
      s = { ...s, export: { ...s.export, files: { ...s.export.files, [kind]: rec } } }
    }
  } catch (e) {
    console.warn("[CallScribe] export failed", id, e)
  }
  await db.updateSession(id, (cur) => {
    if (!cur.export || cur.export.owner !== INSTANCE) return false
    L.settleExport(cur, Date.now())
  })
})

async function finalize(id, reason, at) {
  const st = await settings()
  const s = await serial(id, () => db.updateSession(id, (cur) => {
    if (cur.endedAt) return false
    L.markEnded(cur, { reason, at, now: Date.now(), autoDownload: st.autoDownload, folder: st.folder, base: L.exportBase(fileBase(cur), cur.id) })
  }))
  if (!s) return
  if (s.tabId) badge(null, s.tabId)
  if (L.needsWork(s)) await runExport(id)
}

// One-off exports from the popup's Transcript / Audio buttons (not part of the job).
async function manualBase(s) {
  const st = await settings()
  return { folder: (s.export && s.export.folder) || st.folder, base: (s.export && s.export.base) || L.exportBase(fileBase(s), s.id) }
}
async function exportTranscriptNow(id) {
  const s = await db.getSession(id)
  if (!s) throw new Error("no such session")
  const { folder, base } = await manualBase(s)
  let audioFile = L.transcriptAudioRef(s)
  if (audioFile === null) audioFile = `${base}.${/ogg/.test((s.audio && s.audio.mime) || "") ? "ogg" : "webm"}`
  return chrome.downloads.download({ url: utf8DataUrl(formatTranscript(s, { audioFile }), "text/markdown"), filename: `${folder}/${base}.md`, conflictAction: "uniquify", saveAs: false })
}
async function exportAudioNow(id) {
  const s = await db.getSession(id)
  if (!s || !s.audio || !s.audio.chunks) throw new Error("no audio recorded")
  const { folder, base } = await manualBase(s)
  const src = await audioUrl(id)
  const downloadId = await chrome.downloads.download({ url: src.url, filename: `${folder}/${base}.${src.ext}`, conflictAction: "uniquify", saveAs: false })
  waitDownload(downloadId, 10 * 60 * 1000).then(src.revoke)
  return downloadId
}
async function saveAgain(id) {
  const st = await settings()
  const s = await serial(id, () => db.updateSession(id, (cur) => {
    if (!cur.endedAt) throw new Error("the call is still going")
    if (cur.export && cur.export.state === "running") return false
    L.resetExport(cur, { folder: st.folder, base: L.exportBase(fileBase(cur), cur.id) })
  }))
  if (!s) throw new Error("no such session")
  await runExport(id)
}

function badge(text, tabId) {
  chrome.action.setBadgeBackgroundColor({ color: "#d93025" })
  chrome.action.setBadgeText({ text: text || "", ...(tabId ? { tabId } : {}) })
}

const NOT_YOURS = { error: "not this tab's session", fatal: true }
const CLOSED = (st) => st === "running" || st === "done" || st === "failed" || st === "canceled"
const LIBRARY = new Set(["list", "get", "delete", "export", "export-transcript", "export-audio", "chunks-for"])

/** Session-row write from the tab that owns it. fn(cur) as for updateSession. */
async function ownWrite(id, sender, fn) {
  let verdict = { ok: true }
  const s = await serial(id, () => db.updateSession(id, (cur) => {
    if (!L.ownsSession(cur, sender)) return ((verdict = NOT_YOURS), false)
    if (cur.export && CLOSED(cur.export.state)) return ((verdict = { error: "session closed", fatal: true }), false)
    return fn(cur)
  }))
  return s ? verdict : { error: "no such session", fatal: true }
}

async function handle(msg, sender) {
  const tabId = sender.tab && sender.tab.id
  if (LIBRARY.has(msg.type)) {
    if (!L.isLibrarySender(sender, chrome.runtime.id, ORIGIN)) return { error: "not allowed" }
    switch (msg.type) {
      case "list": {
        const offset = Math.max(0, Number(msg.offset) || 0)
        const limit = Math.min(200, Math.max(1, Number(msg.limit) || 50))
        return db.listSessions({ offset, limit, map: summary })
      }
      case "get": return { session: await db.getSession(msg.id) }
      case "export-transcript": await exportTranscriptNow(msg.id); return { ok: true }
      case "export-audio": await exportAudioNow(msg.id); return { ok: true }
      case "export": await saveAgain(msg.id); return { ok: true }
      case "delete": {
        const s = await db.getSession(msg.id)
        await serial(msg.id, () => db.deleteSession(msg.id))
        if (s && s.tabId && !s.endedAt) badge(null, s.tabId)
        return { ok: true }
      }
      case "chunks-for": return { chunks: (await db.getChunks(msg.id)).length }
    }
  }
  // Everything else is a session message from a call tab.
  if (tabId == null || sender.id !== chrome.runtime.id) return { error: "not allowed", fatal: true }
  if (!SESSION_ID.test(String(msg.id || (msg.session && msg.session.id) || ""))) return { error: "bad session id", fatal: true }
  switch (msg.type) {
    case "session-start": {
      const m = msg.session
      const startedAt = L.clampStart(m.startedAt, Date.now())
      const row = {
        id: m.id, platform: String(m.platform || ""), platformName: String(m.platformName || ""), title: String(m.title || "").slice(0, 300),
        url: String(m.url || "").slice(0, 2000), startedAt, tabId, updatedAt: Date.now(), utterances: [], audio: { chunks: 0, bytes: 0 }, todo: 1,
      }
      const r = await serial(m.id, () => db.createSession(row))
      if (r.result === "deleted") return { error: "session deleted", fatal: true }
      if (r.result === "exists" && !L.ownsSession(r.session, sender)) return NOT_YOURS
      badge("REC", tabId)
      return { ok: true }
    }
    case "session-update":
      return ownWrite(msg.id, sender, (s) => {
        if (Number.isInteger(msg.rev) && Number.isInteger(s.rev) && msg.rev <= s.rev) return false // an older snapshot, retried late
        s.utterances = Array.isArray(msg.utterances) ? msg.utterances : s.utterances
        if (msg.title) s.title = String(msg.title).slice(0, 300)
        s.captionsOn = Boolean(msg.captionsOn)
        if (Number.isInteger(msg.rev)) s.rev = msg.rev
        s.updatedAt = Date.now()
      })
    case "audio-chunk": {
      if (typeof msg.b64 !== "string" || msg.b64.length > (L.MAX_CHUNK_BYTES * 4) / 3 + 8) return { error: "bad chunk size", fatal: true }
      if (!Number.isInteger(msg.seq) || msg.seq < 0) return { error: "bad seq", fatal: true }
      const bytes = b64ToBytes(msg.b64)
      const now = Date.now()
      return serial(msg.id, () => db.addChunk(msg.id, msg.seq, bytes, msg.mime, (s, deleted) =>
        L.acceptChunk(s, { tabId, seq: msg.seq, size: bytes.length, mime: msg.mime, now }, { tombstone: deleted })))
    }
    case "audio-started":
    case "audio-error":
    case "audio-log":
      return ownWrite(msg.id, sender, (s) => {
        const detail = {}
        for (const [k, v] of Object.entries(msg.detail || {})) if (k !== "__callscribe" && (typeof v === "string" || typeof v === "number")) detail[k] = String(v).slice(0, 300)
        s.audioLog = (s.audioLog || []).concat({ t: Date.now(), ...detail }).slice(-20)
      })
    case "session-end": {
      const s = await db.getSession(msg.id)
      if (!s) return { error: "no such session", fatal: true }
      if (!L.ownsSession(s, sender)) return NOT_YOURS
      badge(null, tabId)
      await finalize(msg.id, String(msg.reason || "ended"), Number(msg.at))
      return { ok: true }
    }
    default: return { error: "unknown message " + msg.type }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg !== "object" || msg.target === "offscreen") return false
  handle(msg, sender).then(reply, (e) => reply({ error: String((e && e.message) || e) }))
  return true
})

function summary(s) {
  const job = s.export || {}
  return {
    id: s.id, platformName: s.platformName, title: s.title, startedAt: s.startedAt, endedAt: s.endedAt,
    lines: (s.utterances || []).length, audioBytes: s.audio ? s.audio.bytes : 0,
    exportState: job.state || (s.legacy === "unsaved" ? "unsaved" : s.exported ? "legacy" : undefined), exportDoneAt: s.exportDoneAt, exportErrors: s.exportErrors,
    deleteAt: s.exportDoneAt ? s.exportDoneAt + L.RETENTION_MS : undefined,
  }
}

// A closed tab never sends session-end; finalize from here, ending at the close.
chrome.tabs.onRemoved.addListener((tabId) => {
  const at = Date.now()
  setTimeout(async () => {
    for (const s of await db.todoSessions()) if (s.tabId === tabId && !s.endedAt) await finalize(s.id, "tab-closed", at)
  }, TAB_CLOSE_WAIT_MS)
})

// A download finishing while no export waits for it (worker restarted): pick the job up.
chrome.downloads.onChanged.addListener(async (d) => {
  if (!d.state || d.state.current === "in_progress") return
  for (const s of await db.todoSessions()) {
    const files = (s.export && s.export.files) || {}
    if (Object.values(files).some((f) => f && f.downloadId === d.id)) runExport(s.id)
  }
})

const alive = (s) => (s.tabId == null ? false : L.withTimeout(chrome.tabs.sendMessage(s.tabId, { type: "tab-status" }).then((st) => Boolean(st && st.session && st.session.id === s.id)), PROBE_MS, false))
const tabExists = (s) => (s.tabId == null ? Promise.resolve(false) : chrome.tabs.get(s.tabId).then(() => true, () => false))

// Overlapping triggers (startup plus an overdue alarm) share one sweep.
const sweepOnce = L.singleFlight(async () => {
  const now = Date.now()
  const todo = await db.todoSessions()
  // Live calls: probe every tab at once, each probe bounded.
  const live = todo.filter((s) => !s.endedAt)
  const verdicts = await Promise.all(live.map(async (s) => L.isStale(s, { alive: await alive(s), tabExists: await tabExists(s), now: Date.now() })))
  for (let i = 0; i < live.length; i++) if (verdicts[i]) await finalize(live[i].id, "stale")
  // Calls the previous version ended but never exported (marked by the v1 -> v2 upgrade):
  // a job with the current settings, or "not saved" with a Save button (review I-1).
  const legacy = todo.filter((s) => s.endedAt && s.legacy === "unsaved" && !s.export)
  if (legacy.length) {
    const st = await settings()
    for (const s of legacy) {
      await serial(s.id, () => db.updateSession(s.id, (cur) => {
        L.adoptLegacy(cur, { autoDownload: st.autoDownload, folder: st.folder, base: L.exportBase(fileBase(cur), cur.id) })
      }))
    }
  }
  // Ended calls with an export still to do (claimExport decides whether a retry is due).
  for (const s of await db.todoSessions()) if (s.endedAt) await runExport(s.id)
  for (const id of await db.exportedBefore(now - L.RETENTION_MS)) {
    if (L.retentionDue(await db.getSession(id), now)) await db.deleteSession(id, { tombstone: false })
  }
  await db.collectOrphanChunks()
  await db.pruneTombstones(now - TOMBSTONE_KEEP_MS)
})
async function sweep() {
  try {
    await sweepOnce("sweep")
  } catch (e) {
    console.warn("[CallScribe] sweep failed", e)
  }
  await ensureAlarm()
}

// Keep the existing schedule: recreating the alarm on every worker start would push it back.
async function ensureAlarm() {
  try {
    if (!(await chrome.alarms.get("sweep"))) await chrome.alarms.create("sweep", { periodInMinutes: 2 })
  } catch (e) {
    console.warn("[CallScribe] alarm", e)
  }
}
chrome.runtime.onStartup.addListener(sweep)
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "sweep") sweep() })
ensureAlarm()
