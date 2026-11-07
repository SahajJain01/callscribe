import { getChunks } from "../shared/db.js"

// Only the service worker talks to this page: nothing from a tab (content scripts), nothing
// from another extension.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.target !== "offscreen" || sender.tab || sender.id !== chrome.runtime.id) return false
  if (msg.type === "make-url") {
    getChunks(msg.id)
      .then((rows) => {
        if (!rows.length) return reply({ error: "no chunks" })
        const mime = (rows[0].mime || "audio/webm").split(";")[0]
        const blob = new Blob(rows.map((r) => r.bytes), { type: mime })
        reply({ url: URL.createObjectURL(blob), mime, size: blob.size })
      })
      .catch((e) => reply({ error: String(e) }))
    return true
  }
  if (msg.type === "revoke") {
    URL.revokeObjectURL(msg.url)
    reply({ ok: true })
  }
  return false
})
