// Live check against real Google Meet in an existing Chrome (CDP on 127.0.0.1:9222), without
// installing the extension: injects the extension's scripts with a stand-in for chrome.* APIs.
//   node test/live/meet-live.mjs <targetId> <outDir> [speechSeconds]
// Starts a new meeting in that tab, turns the camera off, lets CallScribe run while you play
// speech into the mic, leaves, then writes transcript.md / audio.webm / messages.json to outDir.
import fs from "node:fs"
import path from "node:path"
import { formatTranscript } from "../../src/shared/format.js"

const [targetId, outDir, speechSecs = "40"] = process.argv.slice(2)
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..")
const read = (p) => fs.readFileSync(path.join(root, p), "utf8")
fs.mkdirSync(outDir, { recursive: true })

const shim = `{
  runtime: { sendMessage(m) { (window.__csMsgs = window.__csMsgs || []).push(m); return Promise.resolve({ ok: true }) }, onMessage: { addListener() {} } },
  storage: { local: { get: () => Promise.resolve({ settings: { recordAudio: true, includeMic: true, autoCaptions: true, hideCaptions: true } }) }, onChanged: { addListener() {} } },
}`
const isolated = `(function (chrome) {\n${read("src/shared/merge.js")}\n${read("src/shared/meet-proto.js")}\n${read("src/content/adapters/google-meet.js")}\n${read("src/content/main.js")}\n})(${shim})`

const ws = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${targetId}`)
let id = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === "Page.screencastFrame") send("Page.screencastFrameAck", { sessionId: m.params.sessionId })
}
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800))
  return r.result?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function click(label) {
  const box = await ev(`(()=>{const e=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}); if(!e) return null; const r=e.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`)
  if (!box) return false
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await send("Input.dispatchMouseEvent", { type, x: box[0], y: box[1], button: "left", clickCount: type === "mouseMoved" ? 0 : 1 })
  return true
}

await new Promise((r) => (ws.onopen = r))
await send("Page.enable")
await send("Emulation.setFocusEmulationEnabled", { enabled: true })
await send("Page.startScreencast", { format: "jpeg", quality: 10, maxWidth: 320, maxHeight: 200 })
const { result: { identifier } } = await send("Page.addScriptToEvaluateOnNewDocument", { source: read("src/page/audio-hook.js") + "\n" + read("src/page/meet-channels.js") })
await send("Page.navigate", { url: "https://meet.google.com/new" })
for (let i = 0; i < 30; i++) {
  await sleep(1000)
  if (await ev(`!!document.querySelector('button[aria-label="Leave call"]')`).catch(() => false)) break
}
await sleep(1500)
await click("Close")
await click("Turn off camera")
console.log("meeting:", await ev("location.href"), "hook:", await ev("!!window.__callscribeAudioHook"))
fs.writeFileSync(path.join(outDir, "URL"), await ev("location.href"))
if (process.env.MUTE_SELF) { await click("Turn off microphone"); console.log("muted self") }
if (process.env.WAIT_SECS) {
  // Admit anyone knocking while we wait for other participants.
  for (let i = 0; i < Number(process.env.WAIT_SECS); i++) {
    await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>/^(Admit|Admit all)$/.test(b.innerText.trim())); if(b) b.click(); return !!b})()`)
    await sleep(1000)
  }
  console.log("waited for others")
}
await ev(isolated + "; 'injected'")
// Keep every distinct raw caption snapshot for debugging merges.
await ev(`(()=>{const a=window.CallScribe.adapters[0]; const orig=a.captionRows.bind(a); window.__rawRows=[]; let last=''; a.captionRows=()=>{const r=orig(); const s=JSON.stringify(r.map(x=>[x.speaker,x.text])); if(s!==last){last=s; window.__rawRows.push(s)} return r}; return 'wrapped'})()`)
fs.writeFileSync(path.join(outDir, "READY"), "")
console.log("injected; play speech now for", speechSecs, "s")
await sleep(Number(speechSecs) * 1000 * 0.6)
const shot = await send("Page.captureScreenshot", { format: "png" })
fs.writeFileSync(path.join(outDir, "during.png"), Buffer.from(shot.result.data, "base64"))
console.log("caption box:", await ev(`(()=>{const e=document.querySelector('[role=region][aria-label=Captions]'); if(!e) return 'none'; const r=e.getBoundingClientRect(); return JSON.stringify({right:r.right, chars:e.textContent.length})})()`))
await sleep(Number(speechSecs) * 1000 * 0.4)

// Snapshot before leaving: Meet may replace the page after you leave.
await sleep(3000)
fs.writeFileSync(path.join(outDir, "raw-rows.json"), await ev("JSON.stringify(window.__rawRows||[])"))
let msgs = await ev("JSON.stringify(window.__csMsgs || [])").then(JSON.parse)
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 300, y: 300 })
await sleep(500)
await click("Leave call")
await sleep(1200)
await click("Just leave the call")
for (let i = 0; i < 12; i++) {
  await sleep(1000)
  const m = await ev("JSON.stringify(window.__csMsgs || [])").then(JSON.parse).catch(() => null)
  if (!m) break
  msgs = m
  if (msgs.some((x) => x.type === "session-end")) break
}
await send("Page.stopScreencast").catch(() => {})
await send("Page.removeScriptToEvaluateOnNewDocument", { identifier }).catch(() => {})

const start = msgs.find((m) => m.type === "session-start")
const updates = msgs.filter((m) => m.type === "session-update")
const last = updates[updates.length - 1]
const chunks = msgs.filter((m) => m.type === "audio-chunk").sort((a, b) => a.seq - b.seq)
fs.writeFileSync(path.join(outDir, "messages.json"), JSON.stringify(msgs.map((m) => (m.b64 ? { ...m, b64: m.b64.length } : m)), null, 1))
if (chunks.length) fs.writeFileSync(path.join(outDir, "audio.webm"), Buffer.concat(chunks.map((c) => Buffer.from(c.b64, "base64"))))
if (start && last) {
  const session = { ...start.session, title: last.title, utterances: last.utterances, endedAt: Date.now(), audio: { chunks: chunks.length } }
  fs.writeFileSync(path.join(outDir, "transcript.md"), formatTranscript(session))
}
console.log(JSON.stringify({
  started: Boolean(start), ended: msgs.some((m) => m.type === "session-end"), updates: updates.length,
  lines: last ? last.utterances.length : 0, chunks: chunks.length, audioLog: msgs.filter((m) => m.type.startsWith("audio-") && m.type !== "audio-chunk").map((m) => m.detail),
}))
ws.close()
process.exit(0)
