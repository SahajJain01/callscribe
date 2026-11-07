// End-to-end: Chrome crashes mid-call. Loads the unpacked extension in headless Chromium,
// joins the fake Slack huddle (?stay: it never leaves), lets captions and audio stream, then
// SIGKILLs the whole browser. Nothing gets to say goodbye. After DOWN_MS (longer than the
// 2-minute stale window) it starts Chromium again on the same profile and checks that the
// call was recovered: transcript and audio saved to Downloads/CallScribe, and the transcript's
// duration is the call's real length, not stretched by the time Chrome was down.
// Usage: node test/e2e/crash.mjs   (takes ~4 minutes)
import { spawn, execFileSync } from "node:child_process"
import fs from "node:fs"
import https from "node:https"
import os from "node:os"
import path from "node:path"

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..")
const chrome = process.env.CHROME || path.join(os.homedir(), ".hermes/tools/chromium-1208/chrome-linux64/chrome")
const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "callscribe-crash-"))
const downloads = path.join(work, "downloads")
const outDir = path.join(downloads, "CallScribe")
fs.mkdirSync(downloads)
const DOWN_MS = Number(process.env.DOWN_MS || 200000)

execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=app.slack.com",
  "-keyout", path.join(work, "key.pem"), "-out", path.join(work, "cert.pem")], { stdio: "ignore" })
const fixture = fs.readFileSync(path.join(root, "test/e2e/slack-fixture.html"))
const server = https.createServer({ key: fs.readFileSync(path.join(work, "key.pem")), cert: fs.readFileSync(path.join(work, "cert.pem")) },
  (req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(fixture) })
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const port = server.address().port

fs.mkdirSync(path.join(work, "profile/Default"), { recursive: true })
fs.writeFileSync(path.join(work, "profile/Default/Preferences"), JSON.stringify({
  download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true },
}))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ok = true
const check = (cond, label) => { console.log((cond ? "PASS " : "FAIL ") + label); ok = ok && cond }
const outFiles = () => (fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => !f.endsWith(".crdownload")) : [])

// One browser run. detached: its own process group, so a crash can kill every Chrome process at once.
async function launch(url) {
  const proc = spawn(chrome, [
    "--headless=new", `--user-data-dir=${path.join(work, "profile")}`, "--no-first-run", "--no-default-browser-check",
    `--disable-extensions-except=${root}`, `--load-extension=${root}`,
    `--host-resolver-rules=MAP app.slack.com 127.0.0.1:${port}`, "--ignore-certificate-errors",
    "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required",
    "--remote-debugging-port=0", url,
  ], { stdio: ["ignore", "ignore", "pipe"], detached: true })
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
  return { proc, ws, send }
}

// ---- Run 1: join, stream, crash.
const b1 = await launch("about:blank")
const { result: { targetId } } = await b1.send("Target.createTarget", { url: "https://app.slack.com/client/T000/C000?stay" })
const { result: { sessionId } } = await b1.send("Target.attachToTarget", { targetId, flatten: true })
const evalPage = async (expression) => (await b1.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result?.result?.value
let joinedAt = 0
for (let i = 0; i < 40; i++) {
  await sleep(1000)
  const log = (await evalPage("window.__log || []")) || []
  if (!joinedAt && log.includes("joined")) joinedAt = Date.now()
  if (log.includes("staying")) break
}
check(joinedAt > 0, "fixture joined the huddle")
await sleep(8000) // a few more saves and audio chunks after the last caption
const crashAt = Date.now()
const callMs = crashAt - joinedAt
b1.ws.close()
process.kill(-b1.proc.pid, "SIGKILL")
await new Promise((r) => (b1.proc.exitCode !== null || b1.proc.signalCode ? r() : b1.proc.once("exit", r)))
console.log(`crashed ${Math.round(callMs / 1000)} s into the call; Chrome down for ${DOWN_MS / 1000} s`)
check(outFiles().length === 0, "nothing exported before the crash (the call never ended)")

// ---- Chrome stays down longer than the stale window, then comes back.
await sleep(DOWN_MS)
const b2 = await launch("about:blank")
const deadline = Date.now() + 180000 // startup sweep, or the 2-minute alarm at worst
let files = []
while (Date.now() < deadline) {
  files = outFiles()
  if (files.some((f) => f.endsWith(".md")) && files.some((f) => f.endsWith(".webm") || f.endsWith(".ogg"))) break
  await sleep(2000)
}
console.log("files:", files, `(${Math.round((Date.now() - crashAt - DOWN_MS) / 1000)} s after restart)`)
const md = files.find((f) => f.endsWith(".md"))
const audio = files.find((f) => f.endsWith(".webm") || f.endsWith(".ogg"))
check(Boolean(md), "transcript recovered after the crash")
await sleep(5000) // a second sweep (startup and an overdue alarm) would add a duplicate by now
files = outFiles()
check(files.filter((f) => f.endsWith(".md")).length === 1 && files.filter((f) => f.endsWith(".webm") || f.endsWith(".ogg")).length === 1,
  `exactly one transcript and one audio file, no duplicates (lifecycle F4): ${JSON.stringify(files)}`)
check(Boolean(audio), "audio recovered after the crash")
if (md) {
  const text = fs.readFileSync(path.join(outDir, md), "utf8")
  console.log("----\n" + text + "----")
  check(text.includes("Morning everyone, let us look at the new landing page"), "captions from before the crash are in the transcript")
  check(text.includes("Great, ship it on Friday"), "the last caption before the crash is in the transcript")
  const m = text.match(/^- Duration: (\d+):(\d+):(\d+)/m)
  const dur = m ? (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 : NaN
  check(Number.isFinite(dur) && dur <= callMs + 10000,
    `duration is the call's real length (${dur / 1000} s, call ran ${Math.round(callMs / 1000)} s), not stretched by the ${DOWN_MS / 1000} s Chrome was down`)
}
if (audio) check(fs.statSync(path.join(outDir, audio)).size > 20000, "recovered audio has data")

b2.ws.close()
try { process.kill(-b2.proc.pid, "SIGKILL") } catch {}
server.close()
console.log(ok ? "\nCRASH E2E PASS" : "\nCRASH E2E FAIL", "(work dir " + work + ")")
process.exit(ok ? 0 : 1)
