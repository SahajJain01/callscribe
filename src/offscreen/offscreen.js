import { getChunks } from "../shared/db.js"

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.target !== "offscreen") return false
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
