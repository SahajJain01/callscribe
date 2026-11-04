// IndexedDB storage for sessions and audio chunks (extension origin; shared by
// the service worker, the offscreen document and the popup).

const DB_NAME = "callscribe"
let dbp = null

export function db() {
  if (dbp) return dbp
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const d = req.result
      d.createObjectStore("sessions", { keyPath: "id" }).createIndex("startedAt", "startedAt")
      d.createObjectStore("chunks", { keyPath: ["session", "seq"] }).createIndex("session", "session")
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbp
}

const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error) })
const val = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error) })

export async function getSession(id) {
  return val((await db()).transaction("sessions").objectStore("sessions").get(id))
}

export async function putSession(s) {
  const tx = (await db()).transaction("sessions", "readwrite")
  tx.objectStore("sessions").put(s)
  return done(tx)
}

/** Read-modify-write in one transaction so concurrent messages don't clobber each other. */
export async function updateSession(id, fn) {
  const tx = (await db()).transaction("sessions", "readwrite")
  const store = tx.objectStore("sessions")
  const cur = await val(store.get(id))
  if (!cur) return undefined
  const next = fn(cur) || cur
  store.put(next)
  await done(tx)
  return next
}

export async function listSessions(limit = 50) {
  const all = await val((await db()).transaction("sessions").objectStore("sessions").getAll())
  return all.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
}

export async function putChunk(session, seq, bytes, mime) {
  const tx = (await db()).transaction("chunks", "readwrite")
  tx.objectStore("chunks").put({ session, seq, bytes, mime })
  return done(tx)
}

export async function getChunks(session) {
  const rows = await val((await db()).transaction("chunks").objectStore("chunks").index("session").getAll(session))
  return rows.sort((a, b) => a.seq - b.seq)
}

export async function deleteSession(id) {
  const d = await db()
  const tx = d.transaction(["sessions", "chunks"], "readwrite")
  tx.objectStore("sessions").delete(id)
  const idx = tx.objectStore("chunks").index("session")
  const keys = await val(idx.getAllKeys(id))
  for (const k of keys) tx.objectStore("chunks").delete(k)
  return done(tx)
}
