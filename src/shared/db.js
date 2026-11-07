// IndexedDB storage for sessions and audio chunks (extension origin; shared by
// the service worker, the offscreen document and the popup).
//
// v2: sessions are indexed by "todo" (live, or export still to do) and "exportDoneAt" (for
// retention), so recovery and retention query them directly instead of scanning the newest
// N rows. "tombstones" holds ids of deleted sessions so late writes for them are refused.

import { migrateV1Row } from "./lifecycle.js"

const DB_NAME = "callscribe"
const VERSION = 2
let dbp = null

export function db() {
  if (dbp) return dbp
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = (ev) => {
      const d = req.result
      const tx = req.transaction
      if (ev.oldVersion < 1) {
        d.createObjectStore("sessions", { keyPath: "id" }).createIndex("startedAt", "startedAt")
        d.createObjectStore("chunks", { keyPath: ["session", "seq"] }).createIndex("session", "session")
      }
      if (ev.oldVersion < 2) {
        const sessions = tx.objectStore("sessions")
        sessions.createIndex("todo", "todo")
        sessions.createIndex("exportDoneAt", "exportDoneAt")
        d.createObjectStore("tombstones", { keyPath: "id" })
        // Rows from v1 (migrateV1Row): unfinished calls, and ended calls the old version never
        // exported, become sweep work. Ones it marked `exported` stay manual-only; that flag
        // never confirmed a download, so they are never auto-deleted.
        sessions.openCursor().onsuccess = (e) => {
          const c = e.target.result
          if (!c) return
          const before = JSON.stringify([c.value.todo, c.value.legacy])
          const row = migrateV1Row({ ...c.value })
          if (JSON.stringify([row.todo, row.legacy]) !== before) c.update(row)
          c.continue()
        }
      }
    }
    req.onsuccess = () => {
      const d = req.result
      d.onversionchange = () => { d.close(); dbp = null }
      resolve(d)
    }
    req.onerror = () => { dbp = null; reject(req.error) }
  })
  return dbp
}

const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error) })
const val = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error) })

export async function getSession(id) {
  return val((await db()).transaction("sessions").objectStore("sessions").get(id))
}

/** Create a session unless the id exists or was deleted: { result: "created" | "exists" | "deleted", session }. */
export async function createSession(s) {
  const tx = (await db()).transaction(["sessions", "tombstones"], "readwrite")
  const [cur, dead] = await Promise.all([val(tx.objectStore("sessions").get(s.id)), val(tx.objectStore("tombstones").get(s.id))])
  let result = "created"
  if (dead) result = "deleted"
  else if (cur) result = "exists"
  else tx.objectStore("sessions").put(s)
  await done(tx)
  return { result, session: cur || s }
}

export async function putSession(s) {
  const tx = (await db()).transaction("sessions", "readwrite")
  tx.objectStore("sessions").put(s)
  return done(tx)
}

/** Read-modify-write in one transaction so concurrent messages don't clobber each other.
 * fn may return false to leave the row as it is. */
export async function updateSession(id, fn) {
  const tx = (await db()).transaction("sessions", "readwrite")
  const store = tx.objectStore("sessions")
  const cur = await val(store.get(id))
  if (!cur) return undefined
  const next = fn(cur)
  if (next !== false) store.put(next || cur)
  await done(tx)
  return next === false ? cur : next || cur
}

/** One page of sessions, newest first: { sessions, total }. map() runs on each row in the cursor. */
export async function listSessions({ offset = 0, limit = 50, map = (s) => s } = {}) {
  const store = (await db()).transaction("sessions").objectStore("sessions")
  const total = await val(store.count())
  const out = []
  await new Promise((res, rej) => {
    let skipped = offset <= 0
    const req = store.index("startedAt").openCursor(null, "prev")
    req.onerror = () => rej(req.error)
    req.onsuccess = () => {
      const c = req.result
      if (!c || out.length >= limit) return res()
      if (!skipped) {
        skipped = true
        return c.advance(offset)
      }
      out.push(map(c.value))
      c.continue()
    }
  })
  return { sessions: out, total }
}

/** Sessions the sweep has work for (live, or export pending/running). */
export async function todoSessions() {
  return val((await db()).transaction("sessions").objectStore("sessions").index("todo").getAll(1))
}

/** Ids of sessions whose export completed at or before `before`. */
export async function exportedBefore(before) {
  return val((await db()).transaction("sessions").objectStore("sessions").index("exportDoneAt").getAllKeys(IDBKeyRange.upperBound(before)))
}

/**
 * Store one audio chunk and count it on its session, in one transaction across both stores.
 * check(session, deleted) decides: { ok } or { error, fatal }. A chunk already stored under
 * that seq (a retry) is replaced without being counted twice.
 */
export async function addChunk(id, seq, bytes, mime, check) {
  const tx = (await db()).transaction(["sessions", "chunks", "tombstones"], "readwrite")
  const sessions = tx.objectStore("sessions")
  const chunks = tx.objectStore("chunks")
  const [s, dead, old] = await Promise.all([val(sessions.get(id)), val(tx.objectStore("tombstones").get(id)), val(chunks.get([id, seq]))])
  const verdict = check(s, Boolean(dead))
  if (!verdict.ok) {
    tx.abort()
    await done(tx).catch(() => {})
    return verdict
  }
  chunks.put({ session: id, seq, bytes, mime })
  s.audio = s.audio || { chunks: 0, bytes: 0 }
  if (old) {
    s.audio.bytes += bytes.length - (old.bytes.length || old.bytes.byteLength || 0)
  } else {
    s.audio.chunks++
    s.audio.bytes += bytes.length
  }
  s.audio.mime = mime
  s.updatedAt = Date.now()
  sessions.put(s)
  await done(tx)
  return { ok: true }
}

export async function getChunks(session) {
  const rows = await val((await db()).transaction("chunks").objectStore("chunks").index("session").getAll(session))
  return rows.sort((a, b) => a.seq - b.seq)
}

/** Delete a session and its chunks. The tombstone makes later writes for the id fail. */
export async function deleteSession(id, { tombstone = true } = {}) {
  const tx = (await db()).transaction(["sessions", "chunks", "tombstones"], "readwrite")
  tx.objectStore("sessions").delete(id)
  if (tombstone) tx.objectStore("tombstones").put({ id, at: Date.now() })
  const keys = await val(tx.objectStore("chunks").index("session").getAllKeys(id))
  for (const k of keys) tx.objectStore("chunks").delete(k)
  return done(tx)
}

/** Delete chunk rows whose session row doesn't exist (deleted mid-call, never started). */
export async function collectOrphanChunks() {
  const tx = (await db()).transaction(["sessions", "chunks"], "readwrite")
  const sessions = tx.objectStore("sessions")
  const chunks = tx.objectStore("chunks")
  const orphans = []
  await new Promise((res, rej) => {
    const req = chunks.index("session").openKeyCursor(null, "nextunique")
    req.onerror = () => rej(req.error)
    req.onsuccess = () => {
      const c = req.result
      if (!c) return res()
      const id = c.key
      sessions.getKey(id).onsuccess = (e) => {
        if (e.target.result !== undefined) return
        orphans.push(id)
        chunks.delete(IDBKeyRange.bound([id, -Infinity], [id, Infinity]))
      }
      c.continue()
    }
  })
  await done(tx)
  return orphans
}

/** Forget tombstones written before `before` (the tab that could still write is long gone). */
export async function pruneTombstones(before) {
  const tx = (await db()).transaction("tombstones", "readwrite")
  const store = tx.objectStore("tombstones")
  for (const t of await val(store.getAll())) if (t.at < before) store.delete(t.id)
  return done(tx)
}
