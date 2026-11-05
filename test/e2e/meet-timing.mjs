// End-to-end regression for caption timestamps in a tab that isn't being drawn.
// Loads the unpacked extension in headless Chromium, opens a Meet-like fixture (captions are
// applied only in requestAnimationFrame, like Meet) at https://meet.google.com in a
// BACKGROUND tab (hidden, rAF stalled), lets it run a scripted call, then checks the exported
// Markdown: every turn present, each stamped within a few seconds of when it really arrived,
// none marked as an estimate, including the line that arrives just before leaving.
//
//   node test/e2e/meet-timing.mjs                 # current extension: must PASS
//   WITHOUT_KEEPALIVE=1 node test/e2e/meet-timing.mjs   # extension minus the fix: must FAIL
import { spawn, execFileSync } from "node:child_process"
import fs from "node:fs"
import https from "node:https"
import os from "node:os"
import path from "node:path"

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..")
const chrome = process.env.CHROME || path.join(os.homedir(), ".hermes/tools/chromium-1208/chrome-linux64/chrome")
const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "callscribe-timing-"))
const downloads = path.join(work, "downloads")
fs.mkdirSync(downloads)

// Optionally build a copy of the extension without the render keepalive, to prove the test catches the bug.
let ext = repo
if (process.env.WITHOUT_KEEPALIVE) {
  ext = path.join(work, "ext")
  fs.cpSync(repo, ext, { recursive: true, filter: (p) => !/\/(\.git|test|store|node_modules)(\/|$)/.test(p.slice(repo.length)) })
  const m = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"))
  for (const cs of m.content_scripts) cs.js = cs.js.filter((j) => !j.includes("render-keepalive"))
  fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(m, null, 2))
  console.log("variant: WITHOUT render keepalive")
}

execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=meet.google.com",
  "-keyout", path.join(work, "key.pem"), "-out", path.join(work, "cert.pem")], { stdio: "ignore" })
const fixture = fs.readFileSync(path.join(repo, "test/e2e/meet-fixture.html"))
const server = https.createServer({ key: fs.readFileSync(path.join(work, "key.pem")), cert: fs.readFileSync(path.join(work, "cert.pem")) },
  (req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(fixture) })
await new Promise((r) => server.listen(0, "127.0.0.1", r))
fs.mkdirSync(path.join(work, "profile/Default"), { recursive: true })
fs.writeFileSync(path.join(work, "profile/Default/Preferences"), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }))

const proc = spawn(chrome, ["--headless=new", `--user-data-dir=${path.join(work, "profile")}`, "--no-first-run",
  `--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
  `--host-resolver-rules=MAP meet.google.com 127.0.0.1:${server.address().port}`, "--ignore-certificate-errors",
  "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--remote-debugging-port=0", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] })
const wsUrl = await new Promise((res, rej) => { let b = ""; proc.stderr.on("data", (d) => { b += d; const m = b.match(/DevTools listening on (ws:\S+)/); if (m) res(m[1]) }); setTimeout(() => rej(new Error(b)), 20000) })
const ws = new WebSocket(wsUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0; const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ok = true
const check = (cond, label) => { console.log((cond ? "PASS " : "FAIL ") + label); ok = ok && cond }

await sleep(1500) // let the extension's service worker start
// background: true -> the tab is hidden and Chrome runs no animation frames for it.
const { result: { targetId } } = await send("Target.createTarget", { url: "https://meet.google.com/fix-ture-tst", background: true })
const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true })
const evalPage = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)).result?.result?.value

const vis = await evalPage(`new Promise(r=>{let n=0;const f=()=>{n++;requestAnimationFrame(f)};const raf=Object.getPrototypeOf(window)&&window.requestAnimationFrame; void raf; setTimeout(()=>r(document.visibilityState),1500)})`)
console.log("fixture tab visibility:", vis)
check(vis === "hidden", "fixture runs in a hidden tab (rAF stalled)")

let log = []
for (let i = 0; i < 45; i++) { await sleep(1000); log = (await evalPage("window.__log")) || []; if (log.includes("left")) break }
const truth = (await evalPage("window.__truth")) || []
console.log("fixture:", log.join(" | "), "| turns:", truth.length)

let files = []
for (let i = 0; i < 30; i++) {
  const dir = path.join(downloads, "CallScribe")
  files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")) : []
  if (files.length) break
  await sleep(1000)
}
check(files.length === 1, "transcript exported")
if (files.length) {
  const md = fs.readFileSync(path.join(downloads, "CallScribe", files[0]), "utf8")
  console.log("----\n" + md.split("---\n").pop().trim() + "\n----")
  const turns = [...md.matchAll(/\*\*(.+?)\*\* `(~?)(\d\d):(\d\d):(\d\d)`\n(.+)/g)].map((m) => ({
    speaker: m[1], estimated: m[2] === "~", sec: Number(m[3]) * 3600 + Number(m[4]) * 60 + Number(m[5]), text: m[6] }))
  check(turns.length === truth.length, `all ${truth.length} turns exported (got ${turns.length})`)
  check(new Set(turns.map((t) => t.sec)).size === turns.length, "timestamps are distinct (no collapse onto one time)")
  check(turns.every((t) => !t.estimated), "no timestamp had to be estimated (captions arrived live)")
  // Session start is when the extension noticed the call (heartbeat, <= ~1.5 s after the fixture joined).
  // So exported offset ~= true offset minus that lag. Compare gaps between turns, which cancel the lag,
  // and each absolute offset with a loose bound.
  for (let i = 0; i < Math.min(turns.length, truth.length); i++) {
    const want = truth[i].offsetMs / 1000
    const got = turns[i].sec
    check(turns[i].text.startsWith(truth[i].firstWords) && Math.abs(got - want) <= 3,
      `turn ${i + 1} "${truth[i].firstWords}..." at ${got}s, really arrived at ${want.toFixed(1)}s`)
  }
  if (turns.length === truth.length) {
    const last = turns[turns.length - 1]
    check(last.text.includes("bye everyone"), "final caption (arrived just before leaving) flushed in full")
  }
}

await send("Browser.close").catch(() => {})
proc.kill(); server.close()
console.log(ok ? "\nTIMING E2E PASS" : "\nTIMING E2E FAIL", "(work dir " + work + ")")
process.exit(ok ? 0 : 1)
