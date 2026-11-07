// End-to-end: who owns the in-page recorder.
//  1. Settings changed mid-call (lifecycle F1 / runtime C1): audio on -> off -> hang up -> on ->
//     second call in the same tab. The first call's audio must stop growing once it ended, and
//     the second call must record into its own session.
//  2. Extension reloaded mid-call (runtime I1 / lifecycle F7), in a hidden tab: the orphaned
//     content script stops the MAIN-world recorder and render keepalive, shows the reload
//     warning in the pill, and never throws "Extension context invalidated".
// Usage: node test/e2e/recorder.mjs
import { spawn, execFileSync } from "node:child_process"
import fs from "node:fs"
import https from "node:https"
import os from "node:os"
import path from "node:path"

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..")
const chrome = process.env.CHROME || path.join(os.homedir(), ".hermes/tools/chromium-1208/chrome-linux64/chrome")
const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "callscribe-recorder-"))
const downloads = path.join(work, "downloads")
fs.mkdirSync(downloads)
const ORPHAN_TEXT = "CallScribe was updated. Reload this tab to keep recording"

execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=app.slack.com",
  "-keyout", path.join(work, "key.pem"), "-out", path.join(work, "cert.pem")], { stdio: "ignore" })
const fixture = fs.readFileSync(path.join(root, "test/e2e/slack-fixture.html"), "utf8")
const server = https.createServer({ key: fs.readFileSync(path.join(work, "key.pem")), cert: fs.readFileSync(path.join(work, "cert.pem")) },
  (req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fixture) })
await new Promise((r) => server.listen(0, "127.0.0.1", r))
fs.mkdirSync(path.join(work, "profile/Default"), { recursive: true })
fs.writeFileSync(path.join(work, "profile/Default/Preferences"), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true } }))

const proc = spawn(chrome, ["--headless=new", `--user-data-dir=${path.join(work, "profile")}`, "--no-first-run", "--no-default-browser-check",
  `--disable-extensions-except=${root}`, `--load-extension=${root}`,
  `--host-resolver-rules=MAP app.slack.com 127.0.0.1:${server.address().port}`, "--ignore-certificate-errors",
  "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required",
  "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] })
const wsUrl = await new Promise((res, rej) => { let b = ""; proc.stderr.on("data", (d) => { b += d; const m = b.match(/DevTools listening on (ws:\S+)/); if (m) res(m[1]) }); setTimeout(() => rej(new Error(b)), 20000) })
const ws = new WebSocket(wsUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
const events = []
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } else if (m.method) events.push(m) }
// Every command gets an answer, or {} after 15 s (a detached target never answers).
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const i = ++id
  const t = setTimeout(() => { pending.delete(i); console.log("  (no reply to " + method + ")"); res({}) }, 15000)
  pending.set(i, (m) => { clearTimeout(t); res(m) })
  ws.send(JSON.stringify({ id: i, method, params, sessionId }))
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ok = true
const check = (cond, label) => { console.log((cond ? "PASS " : "FAIL ") + label); ok = ok && cond }

async function swSession() {
  for (let i = 0; i < 40; i++) {
    const { result } = await send("Target.getTargets")
    const sw = result.targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/src/background/index.js"))
    if (sw) return (await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true })).result.sessionId
    await sleep(250)
  }
}
let sws = await swSession()
const swEval = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sws)).result?.result?.value
const setSetting = (patch) => swEval(`chrome.storage.local.get("settings").then((r) => chrome.storage.local.set({ settings: { ...(r.settings || {}), ...${JSON.stringify(patch)} } })).then(() => true)`)
const sessions = () => swEval(`new Promise((r) => { const q = indexedDB.open("callscribe"); q.onupgradeneeded = () => q.transaction.abort(); q.onsuccess = () => { const d = q.result; const g = d.transaction("sessions").objectStore("sessions").getAll(); g.onsuccess = () => { d.close(); r(g.result.sort((a, b) => a.startedAt - b.startedAt).map((s) => ({ id: s.id, ended: Boolean(s.endedAt), chunks: s.audio ? s.audio.chunks : 0 }))) } }; q.onerror = () => r([]) })`)

async function openTab(url, background) {
  const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank", background })
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true })
  await send("Runtime.enable", {}, sessionId)
  await send("Page.navigate", { url }, sessionId)
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)).result?.result?.value
  for (let i = 0; i < 40 && !((await ev("window.__log || []")) || []).includes("ready"); i++) await sleep(250)
  return { sessionId, ev }
}
async function waitFor(fn, ms, step = 500) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) { const v = await fn(); if (v) return v }
  return null
}

// ---------- 1. settings toggled mid-call, then a second call in the same tab
{
  console.log("-- settings toggle across calls")
  await setSetting({ recordAudio: true, includeMic: true })
  const tab = await openTab("https://app.slack.com/client/T000/C000?manual")
  console.log("  fixture:", await tab.ev("JSON.stringify(window.__log)"), "settings:", await swEval(`chrome.storage.local.get("settings").then((r) => JSON.stringify(r.settings))`))
  await tab.ev("window.__join()")
  const first = await waitFor(async () => (await sessions()).find((s) => s.chunks >= 1), 15000)
  check(Boolean(first), "first call is recording")
  await setSetting({ recordAudio: false })
  await sleep(1500)
  await tab.ev("window.__leave()")
  const ended = await waitFor(async () => (await sessions()).find((s) => s.id === first.id && s.ended), 20000)
  check(Boolean(ended), "first call ended")
  await sleep(3000) // the final chunk is flushed at stop
  const c1 = (await sessions()).find((s) => s.id === first.id).chunks
  await sleep(7000) // longer than the 5 s chunk interval
  const c2 = (await sessions()).find((s) => s.id === first.id).chunks
  check(c2 === c1, `ended call's audio stopped growing with audio off (chunks ${c1} -> ${c2})`)
  await setSetting({ recordAudio: true })
  await sleep(500)
  await tab.ev("window.__join()")
  const second = await waitFor(async () => (await sessions()).find((s) => s.id !== first.id && s.chunks >= 1), 16000)
  check(Boolean(second), "second call records into its own session")
  const c3 = (await sessions()).find((s) => s.id === first.id).chunks
  check(c3 === c1, `nothing of the second call went into the first one (chunks ${c1} -> ${c3})`)
  await tab.ev("window.__leave()")
  await sleep(8000)
}

// ---------- 2. extension reloaded mid-call in a hidden tab
{
  console.log("-- extension reload mid-call (hidden tab)")
  const tab = await openTab("https://app.slack.com/client/T000/C000?manual", true)
  check((await tab.ev("document.visibilityState")) === "hidden", "tab is hidden (rAF only runs from the keepalive)")
  await tab.ev("window.__join()")
  const before = (await sessions()).map((s) => s.id)
  const live = await waitFor(async () => (await sessions()).find((s) => !before.includes(s.id) || (!s.ended && s.chunks >= 1)), 15000)
  await waitFor(async () => ((await sessions()).find((s) => live && s.id === live.id) || {}).chunks >= 1, 12000)
  const framesIn = async (ms) => { const a = await tab.ev("window.__frames"); await sleep(ms); return (await tab.ev("window.__frames")) - a }
  const inCallFrames = await framesIn(3000)
  check(inCallFrames > 0, `control: keepalive runs the page's frames in the hidden tab during the call (${inCallFrames} in 3 s)`)

  const recorderStates = async () => {
    const proto = (await send("Runtime.evaluate", { expression: "MediaRecorder.prototype" }, tab.sessionId)).result.result.objectId
    const { result } = await send("Runtime.queryObjects", { prototypeObjectId: proto }, tab.sessionId)
    const r = await send("Runtime.callFunctionOn", { objectId: result.objects.objectId, functionDeclaration: "function () { return this.map((r) => r.state) }", returnByValue: true }, tab.sessionId)
    await send("Runtime.releaseObjectGroup", { objectGroup: "" }, tab.sessionId).catch(() => {})
    return r.result.result.value
  }
  check((await recorderStates()).includes("recording"), "control: the MAIN-world recorder is recording before the reload")

  const exBefore = events.filter((e) => e.method === "Runtime.exceptionThrown").length
  await send("Runtime.evaluate", { expression: "chrome.runtime.reload()" }, sws).catch(() => {})
  await sleep(4000)

  const states = await recorderStates()
  check(states.length > 0 && states.every((s) => s === "inactive"), `orphaned content script stopped the recorder (${JSON.stringify(states)})`)
  const orphanFrames = await framesIn(3000)
  check(orphanFrames === 0, `render keepalive stopped after the reload (${orphanFrames} frames in 3 s)`)

  // The pill now carries the warning: read the closed shadow root through a piercing DOM walk.
  const pillText = async () => {
    const { result } = await send("DOM.getDocument", { depth: -1, pierce: true }, tab.sessionId)
    let host = null
    const texts = []
    const walk = (n, inHost) => {
      const a = n.attributes || []
      let here = inHost
      for (let i = 0; i < a.length; i += 2) if (a[i] === "id" && a[i + 1] === "callscribe-overlay") { host = n; here = true }
      if (here && n.nodeType === 3 && n.nodeValue.trim() && n.nodeValue.length < 200) texts.push(n.nodeValue.trim()) // skip the stylesheet
      for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c, here)
    }
    walk(result.root, false)
    const attrs = host ? host.attributes : []
    const state = attrs[attrs.indexOf("data-state") + 1]
    return { present: Boolean(host), state, texts }
  }
  const pill = await pillText()
  check(pill.present && pill.texts.includes(ORPHAN_TEXT), `pill shows "${ORPHAN_TEXT}" (${JSON.stringify(pill.texts.slice(0, 6))})`)
  check(pill.state === "orphaned", `overlay host marked orphaned (${pill.state})`)

  await tab.ev("window.__leave()")
  await sleep(4000)
  check(!(await pillText()).present, "warning pill goes when the call is left")
  const leftFrames = await framesIn(2000)
  check(leftFrames === 0, `no keepalive frames after leaving either (${leftFrames})`)
  const thrown = events.filter((e) => e.method === "Runtime.exceptionThrown").slice(exBefore)
  const texts = thrown.map((e) => (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text || "").split("\n")[0])
  check(thrown.length === 0, `no uncaught errors in the tab after the reload (${thrown.length}: ${JSON.stringify(texts.slice(0, 3))})`)
}

await send("Browser.close").catch(() => {})
proc.kill()
server.close()
console.log(ok ? "\nRECORDER E2E PASS" : "\nRECORDER E2E FAIL", "(work dir " + work + ")")
process.exit(ok ? 0 : 1)
