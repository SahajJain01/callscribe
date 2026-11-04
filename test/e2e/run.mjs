// End-to-end: load the unpacked extension in Chromium, serve a fake Slack huddle at
// https://app.slack.com (host-resolver + self-signed cert), let it run, then check the
// transcript and audio files the extension saved.
// Usage: CHROME=/path/to/chromium node test/e2e/run.mjs
import { spawn, execFileSync } from "node:child_process"
import fs from "node:fs"
import https from "node:https"
import os from "node:os"
import path from "node:path"

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..")
const chrome = process.env.CHROME || path.join(os.homedir(), ".hermes/tools/chromium-1208/chrome-linux64/chrome")
const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "callscribe-e2e-"))
const downloads = path.join(work, "downloads")
fs.mkdirSync(downloads)

execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=app.slack.com",
  "-keyout", path.join(work, "key.pem"), "-out", path.join(work, "cert.pem")], { stdio: "ignore" })
const fixture = fs.readFileSync(path.join(root, "test/e2e/slack-fixture.html"))
const server = https.createServer({ key: fs.readFileSync(path.join(work, "key.pem")), cert: fs.readFileSync(path.join(work, "cert.pem")) },
  (req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(fixture) })
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const port = server.address().port

// Preferences: download straight into our folder without prompting.
fs.mkdirSync(path.join(work, "profile/Default"), { recursive: true })
fs.writeFileSync(path.join(work, "profile/Default/Preferences"), JSON.stringify({
  download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true },
}))

const proc = spawn(chrome, [
  "--headless=new", `--user-data-dir=${path.join(work, "profile")}`, "--no-first-run", "--no-default-browser-check",
  `--disable-extensions-except=${root}`, `--load-extension=${root}`,
  `--host-resolver-rules=MAP app.slack.com 127.0.0.1:${port}`, "--ignore-certificate-errors",
  "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required",
  "--remote-debugging-port=0", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] })
const wsUrl = await new Promise((resolve, reject) => {
  let buf = ""
  proc.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\S+)/); if (m) resolve(m[1]) })
  setTimeout(() => reject(new Error("chrome did not start:\n" + buf)), 20000)
})

const ws = new WebSocket(wsUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ok = true
const check = (cond, label) => { console.log((cond ? "PASS " : "FAIL ") + label); ok = ok && cond }

// SCENARIO=muted-alone: no remote audio and you stay muted, so the recording must be silence.
const alone = process.env.SCENARIO === "muted-alone"
console.log("scenario:", alone ? "muted-alone" : "muted-with-remote")
const { result: { targetId } } = await send("Target.createTarget", { url: "https://app.slack.com/client/T000/C000" + (alone ? "?noremote" : "") })
const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true })
const evalPage = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result?.result?.value

// The fixture joins, captions for ~10 s, then leaves; the extension needs a few seconds to finalize.
let fixtureLog = []
let captionRight
for (let i = 0; i < 40; i++) {
  await sleep(1000)
  fixtureLog = (await evalPage("window.__log || []")) || []
  if (fixtureLog.includes("left")) break
  const box = await evalPage(`(()=>{const e=document.querySelector('.p-huddle_closed_captions'); if(!e||!e.textContent) return null; const r=e.getBoundingClientRect(); return r.right})()`)
  if (box !== null && box !== undefined) captionRight = box
}
check(captionRight !== undefined && captionRight < 0, "caption box hidden off-screen (right edge " + captionRight + ")")
console.log("fixture:", fixtureLog.join(" | "))

const deadline = Date.now() + 30000
let files = []
while (Date.now() < deadline) {
  files = fs.existsSync(path.join(downloads, "CallScribe")) ? fs.readdirSync(path.join(downloads, "CallScribe")).filter((f) => !f.endsWith(".crdownload")) : []
  if (files.some((f) => f.endsWith(".md")) && files.some((f) => f.endsWith(".webm"))) break
  await sleep(1000)
}
console.log("files:", files)
if (!files.length || process.env.DEBUG) {
  const { result } = await send("Target.getTargets")
  console.log("targets:", result.targetInfos.map((t) => t.type + " " + t.url).join("\n  "))
  const sw = result.targetInfos.find((t) => t.type === "service_worker" && t.url.includes("background"))
  if (sw) {
    const { result: { sessionId: s2 } } = await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true })
    const r = await send("Runtime.evaluate", { expression: `new Promise(r=>{const q=indexedDB.open('callscribe');q.onsuccess=()=>{const tx=q.result.transaction('sessions');tx.objectStore('sessions').getAll().onsuccess=e=>r(JSON.stringify(e.target.result.map(s=>({...s,utterances:s.utterances.length}))))};q.onerror=()=>r('no db')})`, awaitPromise: true, returnByValue: true }, s2)
    console.log("sessions in SW:", r.result?.result?.value || JSON.stringify(r.result))
    const d = await send("Runtime.evaluate", { expression: `chrome.downloads.search({}).then(a=>JSON.stringify(a.map(x=>({f:x.filename,s:x.state,e:x.error,u:x.url.slice(0,40)}))))`, awaitPromise: true, returnByValue: true }, s2)
    console.log("downloads:", d.result?.result?.value || JSON.stringify(d.result))
  }
  console.log("page CS globals:", await evalPage("JSON.stringify({hook: !!window.__callscribeAudioHook})"))
}

const md = files.find((f) => f.endsWith(".md"))
const audio = files.find((f) => f.endsWith(".webm"))
check(Boolean(md), "transcript saved")
check(Boolean(audio), "audio saved")
if (md) {
  const text = fs.readFileSync(path.join(downloads, "CallScribe", md), "utf8")
  console.log("----\n" + text + "----")
  check(/^# #design-team/m.test(text), "title from huddle header")
  check(text.includes("Morning everyone, let us look at the new landing page"), "first caption complete")
  check(text.includes("Sure, I pushed the hero changes last night"), "second speaker")
  check(text.includes("Great, ship it on Friday"), "caption after trimmed row")
  check((text.match(/Morning everyone/g) || []).length === 1, "no duplicate lines")
  check(/\*\*Alice Nguyen\*\*/.test(text) && /\*\*Sahaj Jain\*\*/.test(text), "speaker names")
}
if (audio) {
  const f = path.join(downloads, "CallScribe", audio)
  const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim() || 0)
  // ffprobe may not know webm duration without a full decode; decode to measure.
  const stats = execFileSync("sh", ["-c", `ffmpeg -hide_banner -i "${f}" -af volumedetect -f null - 2>&1 | grep -E "mean_volume|max_volume|time="| tail -3`]).toString()
  console.log("audio:", fs.statSync(f).size, "bytes;", "ffprobe duration", dur, "\n" + stats)
  const mean = Number((stats.match(/mean_volume: (-?[\d.]+)/) || [])[1])
  check(fs.statSync(f).size > (alone ? 1000 : 20000), "audio has data")
  if (alone) check(Number.isFinite(mean) && mean < -60, "muted mic is gated out: recording is silent (mean " + mean + " dB)")
  else check(Number.isFinite(mean) && mean > -50, "remote audio recorded while you are muted (mean " + mean + " dB)")
}

// Render the popup (as a tab) so its call list can be eyeballed: <work>/popup.png
{
  const { result } = await send("Target.getTargets")
  const sw = result.targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/src/background/index.js"))
  if (sw) {
    const base = sw.url.split("/src/")[0]
    const { result: { targetId: pt } } = await send("Target.createTarget", { url: base + "/src/popup/popup.html" })
    const { result: { sessionId: ps } } = await send("Target.attachToTarget", { targetId: pt, flatten: true })
    await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 420, deviceScaleFactor: 2, mobile: false }, ps)
    await sleep(1500)
    const shot = await send("Page.captureScreenshot", { format: "png" }, ps)
    fs.writeFileSync(path.join(work, "popup.png"), Buffer.from(shot.result.data, "base64"))
    console.log("popup screenshot:", path.join(work, "popup.png"))
  }
}

await send("Browser.close").catch(() => {})
proc.kill()
server.close()
console.log(ok ? "\nE2E PASS" : "\nE2E FAIL", "(work dir " + work + ")")
process.exit(ok ? 0 : 1)
