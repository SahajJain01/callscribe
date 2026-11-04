// Service worker: stores sessions as they stream in, and saves the transcript and
// audio backup to Downloads/CallScribe/ when a call ends (or its tab disappears).
import { getSession, putSession, updateSession, listSessions, putChunk, getChunks, deleteSession } from "../shared/db.js"
import { formatTranscript, fileBase } from "../shared/format.js"

const DEFAULTS = { recordAudio: true, includeMic: true, autoCaptions: true, autoDownload: true, folder: "CallScribe" }
const STALE_MS = 2 * 60 * 1000

async function settings() {
  const r = await chrome.storage.local.get("settings")
  return { ...DEFAULTS, ...(r.settings || {}) }
}

chrome.runtime.onInstalled.addListener(async () => {
  const r = await chrome.storage.local.get("settings")
  await chrome.storage.local.set({ settings: { ...DEFAULTS, ...(r.settings || {}) } })
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

async function download(url, filename) {
  const s = await settings()
  return chrome.downloads.download({ url, filename: `${s.folder}/${filename}`, conflictAction: "uniquify", saveAs: false })
}

export async function exportTranscript(id) {
  const s = await getSession(id)
  if (!s) throw new Error("no such session")
  return download(utf8DataUrl(formatTranscript(s), "text/markdown"), `${fileBase(s)}.md`)
}

export async function exportAudio(id) {
  const s = await getSession(id)
  if (!s || !s.audio || !s.audio.chunks) throw new Error("no audio recorded")
  await ensureOffscreen()
  const r = await chrome.runtime.sendMessage({ target: "offscreen", type: "make-url", id })
  if (!r || !r.url) throw new Error(r && r.error ? r.error : "could not build audio file")
  const ext = /ogg/.test(r.mime) ? "ogg" : "webm"
  const dl = await download(r.url, `${fileBase(s)}.${ext}`)
  setTimeout(() => chrome.runtime.sendMessage({ target: "offscreen", type: "revoke", url: r.url }).catch(() => {}), 120000)
  return dl
}

async function finalize(id, reason) {
  const s = await updateSession(id, (cur) => {
    if (cur.endedAt) return cur
    cur.endedAt = Math.max(cur.updatedAt || cur.startedAt, Date.now() - (reason === "stale" ? STALE_MS : 0))
    cur.endReason = reason
    return cur
  })
  if (!s || s.exported) return
  const st = await settings()
  if (!st.autoDownload) return
  const errors = []
  try { await exportTranscript(id) } catch (e) { errors.push("transcript: " + e.message) }
  if (s.audio && s.audio.chunks) {
    try { await exportAudio(id) } catch (e) { errors.push("audio: " + e.message) }
  }
  await updateSession(id, (cur) => { cur.exported = Date.now(); cur.exportErrors = errors })
  badge(null)
}

function badge(text, tabId) {
  chrome.action.setBadgeBackgroundColor({ color: "#d93025" })
  chrome.action.setBadgeText({ text: text || "", ...(tabId ? { tabId } : {}) })
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target === "offscreen") return false
  const tabId = sender.tab && sender.tab.id
  const run = async () => {
    switch (msg.type) {
      case "session-start": {
        await putSession({ ...msg.session, tabId, updatedAt: Date.now(), utterances: [], audio: { chunks: 0, bytes: 0 } })
        badge("REC", tabId)
        return { ok: true }
      }
      case "session-update": {
        await updateSession(msg.id, (s) => {
          s.utterances = msg.utterances
          if (msg.title) s.title = msg.title
          s.captionsOn = msg.captionsOn
          s.updatedAt = Date.now()
        })
        return { ok: true }
      }
      case "audio-chunk": {
        const bytes = b64ToBytes(msg.b64)
        await putChunk(msg.id, msg.seq, bytes, msg.mime)
        await updateSession(msg.id, (s) => {
          s.audio = s.audio || { chunks: 0, bytes: 0 }
          s.audio.chunks++
          s.audio.bytes += bytes.length
          s.audio.mime = msg.mime
          s.updatedAt = Date.now()
        })
        return { ok: true }
      }
      case "audio-started":
      case "audio-error":
      case "audio-log": {
        await updateSession(msg.id, (s) => {
          const { __callscribe, ...detail } = msg.detail || {}
          s.audioLog = (s.audioLog || []).concat({ t: Date.now(), ...detail }).slice(-20)
        })
        return { ok: true }
      }
      case "session-end": {
        if (tabId) badge(null, tabId)
        await finalize(msg.id, msg.reason || "ended")
        return { ok: true }
      }
      case "list": return { sessions: (await listSessions()).map(summary) }
      case "get": return { session: await getSession(msg.id) }
      case "export-transcript": await exportTranscript(msg.id); return { ok: true }
      case "export-audio": await exportAudio(msg.id); return { ok: true }
      case "delete": await deleteSession(msg.id); return { ok: true }
      case "chunks-for": return { chunks: (await getChunks(msg.id)).length }
      default: return { error: "unknown message " + msg.type }
    }
  }
  run().then(reply, (e) => reply({ error: String(e && e.message || e) }))
  return true
})

function summary(s) {
  return {
    id: s.id, platformName: s.platformName, title: s.title, startedAt: s.startedAt, endedAt: s.endedAt,
    lines: (s.utterances || []).length, audioBytes: s.audio ? s.audio.bytes : 0, exported: s.exported, exportErrors: s.exportErrors,
  }
}

// A closed tab or crashed page never sends session-end; finalize from here.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  setTimeout(async () => {
    for (const s of await listSessions(20)) if (s.tabId === tabId && !s.endedAt) await finalize(s.id, "tab-closed")
  }, 7000)
})

async function sweepStale() {
  for (const s of await listSessions(20)) {
    if (s.endedAt) continue
    let alive = false
    if (s.tabId) {
      try {
        const st = await chrome.tabs.sendMessage(s.tabId, { type: "tab-status" })
        alive = Boolean(st && st.session && st.session.id === s.id)
      } catch {}
    }
    if (!alive && Date.now() - (s.updatedAt || s.startedAt) > STALE_MS) await finalize(s.id, "stale")
  }
}
chrome.runtime.onStartup.addListener(sweepStale)
chrome.alarms.create("sweep", { periodInMinutes: 2 })
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "sweep") sweepStale() })
