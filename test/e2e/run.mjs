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
// The fixture's first <head> script is a hostile page script (attacker.js): it tries to get at
// CallScribe's private page<->extension channel and forges every kind of message on it.
const attacker = fs.readFileSync(path.join(root, "test/e2e/attacker.js"), "utf8")
const fixture = fs.readFileSync(path.join(root, "test/e2e/slack-fixture.html"), "utf8").replace("<!--ATTACKER-->", () => `<script>${attacker}</script>`)
const server = https.createServer({ key: fs.readFileSync(path.join(work, "key.pem")), cert: fs.readFileSync(path.join(work, "cert.pem")) },
  (req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fixture) })
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
const events = []
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } else if (m.method) events.push(m) }
const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ok = true
const check = (cond, label) => { console.log((cond ? "PASS " : "FAIL ") + label); ok = ok && cond }

// SCENARIO=muted-alone: no remote audio and you stay muted, so the recording must be silence.
// It also runs with Spanish UI labels: mute detection must not depend on English text.
const alone = process.env.SCENARIO === "muted-alone"
console.log("scenario:", alone ? "muted-alone" : "muted-with-remote")
const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank" })
const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true })
const evalPage = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result?.result?.value
const viewW = await evalPage("innerWidth")

// Settings are changed the way the popup does it: chrome.storage.local in the service worker.
async function swSession() {
  for (let i = 0; i < 20; i++) {
    const { result } = await send("Target.getTargets")
    const sw = result.targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/src/background/index.js"))
    if (sw) return (await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true })).result.sessionId
    await sleep(250)
  }
}
const sws = await swSession()
const swEval = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sws)).result?.result?.value
// The user parked the pill at the top-right while it was narrow: it must stay on screen as
// captions widen it, and expanding must not overwrite the saved spot.
const parkedPos = { x: viewW - 80, y: 8 }
const storedPos = () => swEval(`chrome.storage.local.get("overlayPos").then((r) => JSON.stringify(r.overlayPos))`)
// The worker can still be starting up; retry until the write is visible.
for (let i = 0; i < 20 && (await storedPos()) !== JSON.stringify(parkedPos); i++) {
  await swEval(`chrome.storage.local.set({ overlayPos: ${JSON.stringify(parkedPos)} }).then(() => true)`)
  await sleep(100)
}
check((await storedPos()) === JSON.stringify(parkedPos), `overlayPos parked near the right edge before the call (${JSON.stringify(parkedPos)})`)
await send("Runtime.enable", {}, sessionId)
await send("Page.navigate", { url: "https://app.slack.com/client/T000/C000" + (alone ? "?noremote&locale=es" : "") }, sessionId)
// CallScribe's content-script world in the tab (where the adapter lives).
const isolatedCtx = () => events.filter((e) => e.method === "Runtime.executionContextCreated" && e.sessionId === sessionId &&
  e.params.context.auxData?.type === "isolated" && /CallScribe/.test(e.params.context.name)).map((e) => e.params.context.id).at(-1)
const evalIsolated = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, contextId: isolatedCtx() }, sessionId)).result?.result?.value
// The live session id, as the popup would ask for it.
const liveSessionId = () => swEval(`chrome.tabs.query({ url: "https://app.slack.com/*" }).then((ts) => Promise.all(ts.map((t) => chrome.tabs.sendMessage(t.id, { type: "tab-status" }).catch(() => null)))).then((r) => (r.find((x) => x && x.session) || {}).session?.id || null)`)
const dbRead = (fn) => swEval(`new Promise((r) => { const q = indexedDB.open("callscribe"); q.onupgradeneeded = () => q.transaction.abort(); q.onsuccess = () => { const d = q.result; (${fn})(d, (v) => { d.close(); r(v) }) }; q.onerror = () => r(null) })`)
const chunkRows = (sid) => dbRead(`(d, done) => { const q = d.transaction("chunks").objectStore("chunks").index("session").getAll(${JSON.stringify(sid)}); q.onsuccess = () => done(q.result.map((c) => ({ seq: c.seq, size: c.bytes.byteLength || c.bytes.length, head: Array.from(new Uint8Array(c.bytes.buffer || c.bytes).slice(0, 4)) }))) }`)
const sessionRow = (sid) => dbRead(`(d, done) => { const q = d.transaction("sessions").objectStore("sessions").get(${JSON.stringify(sid)}); q.onsuccess = () => done(q.result ? { audio: q.result.audio, audioLog: q.result.audioLog, endedAt: q.result.endedAt } : null) }`)
const hostRect = () => evalPage(`(()=>{const h=document.getElementById('callscribe-overlay'); if(!h) return null; const r=h.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: innerWidth, vh: innerHeight }})()`)
const setShowOverlay = (on) => send("Runtime.evaluate", { expression: `chrome.storage.local.get("settings").then((r) => chrome.storage.local.set({ settings: { ...(r.settings || {}), showOverlay: ${on} } }))`, awaitPromise: true }, sws)
// The overlay's host element exposes its state as attributes (its shadow root is closed).
const overlayInfo = () => evalPage(`(()=>{const h=document.getElementById('callscribe-overlay'); return h ? { state: h.getAttribute('data-state'), latest: h.getAttribute('data-latest'), cc: h.getAttribute('data-cc') } : null})()`)
// Real mouse click on an element inside the overlay's closed shadow root, found by class via a piercing DOM walk.
async function clickShadow(cls) {
  const { result } = await send("DOM.getDocument", { depth: -1, pierce: true }, sessionId)
  const find = (n) => {
    const a = n.attributes || []
    for (let i = 0; i < a.length; i += 2) if (a[i] === "class" && a[i + 1].split(" ").includes(cls)) return n
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) { const f = find(c); if (f) return f }
    return null
  }
  const node = find(result.root)
  if (!node) return false
  const { result: { model } } = await send("DOM.getBoxModel", { nodeId: node.nodeId }, sessionId)
  const q = model.content
  const x = (q[0] + q[2]) / 2, y = (q[1] + q[5]) / 2
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 }, sessionId)
  }
  return true
}
async function waitOverlay(present, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (Boolean(await overlayInfo()) === present) return true
  return false
}

// The fixture joins, captions for ~10 s, then leaves; the extension needs a few seconds to finalize.
let fixtureLog = []
let captionRight
let overlayShown = false
let overlayLatest = false
let toggled = false
let clicked = false
let reattached = false
let worstOverflow = 0
let pillChecks = 0
let attack = null // { id, chunksAt }
for (let i = 0; i < 40; i++) {
  await sleep(1000)
  fixtureLog = (await evalPage("window.__log || []")) || []
  if (fixtureLog.includes("left")) break
  const box = await evalPage(`(()=>{const e=document.querySelector('.p-huddle_closed_captions'); if(!e||!e.textContent) return null; const r=e.getBoundingClientRect(); return r.right})()`)
  if (box !== null && box !== undefined) captionRight = box
  // Mid-call: hand the hostile script the real session id (as if it had leaked) and let it forge
  // chunks, stop, mic on, keepalive off and captions with it.
  if (!attack && fixtureLog.includes("joined")) {
    const sid = await liveSessionId()
    const rows = sid ? await chunkRows(sid) : null
    if (sid && rows && rows.length) {
      attack = { id: sid, chunksAt: rows.filter((c) => c.size > 100).length, at: Date.now() }
      await evalPage(`window.__attack(${JSON.stringify(sid)})`)
      check((await evalIsolated("CallScribe.adapters[0].selfMuted()")) === true,
        `mute state read from a language-independent signal${alone ? " (Spanish labels)" : ""}: muted`)
    }
  }
  // Real recorder chunks only (the forged ones are 16 bytes).
  if (attack && !attack.later && Date.now() - attack.at > 6500) attack.later = (await chunkRows(attack.id)).filter((c) => c.size > 100).length
  const ov = await overlayInfo()
  if (ov) overlayShown = true
  if (ov && /Morning everyone|Sure, I pushed|Great, ship it/.test(ov.latest || "")) overlayLatest = true
  // Whenever the pill shows a caption, it must sit fully inside the viewport.
  if (ov && ov.state === "collapsed" && ov.latest) {
    const r = await hostRect()
    if (r) {
      pillChecks++
      worstOverflow = Math.max(worstOverflow, r.right - r.vw, -r.left, r.bottom - r.vh, -r.top)
    }
  }
  // Page code removing the host: the next update puts it back.
  if (overlayLatest && !reattached && !toggled) {
    await evalPage(`document.getElementById('callscribe-overlay').remove()`)
    check(await waitOverlay(true, 2500), "overlay host re-attached after page code removed it")
    reattached = true
  }
  // Mid-call toggle from the settings: the overlay goes and comes back without a new session.
  if (overlayLatest && !toggled) {
    toggled = true
    await setShowOverlay(false)
    check(await waitOverlay(false, 2000), "overlay hidden within 2 s when the setting is turned off")
    await setShowOverlay(true)
    check(await waitOverlay(true, 3000), "overlay returns when the setting is turned back on")
  }
  // Once the last line is in: clicking the pill must expand it without taking focus from the page.
  if (toggled && !clicked && ov && /Great, ship it/.test(ov.latest || "")) {
    clicked = true
    await evalPage(`(()=>{const i=document.createElement('input'); i.id='cs-focus-probe'; i.placeholder='page input (focus probe)'; document.body.appendChild(i); i.focus(); return document.activeElement===i})()`)
    const r = await evalPage(`(()=>{const b=document.getElementById('callscribe-overlay').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }})()`)
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 }, sessionId)
    }
    await sleep(300)
    check(await evalPage(`document.activeElement && document.activeElement.id === 'cs-focus-probe'`), "overlay click keeps page focus")
    check((await overlayInfo())?.state === "expanded", "overlay expands on click")
    const cr = await hostRect()
    check(cr && cr.right <= cr.vw && cr.left >= 0, `expanded card inside the viewport (right ${cr && cr.right} <= ${cr && cr.vw})`)
    check((await storedPos()) === JSON.stringify(parkedPos), "expanding does not overwrite the saved overlayPos")
    // Render the tab with the overlay expanded so it can be eyeballed: <work>/overlay.png
    await sleep(500)
    const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId)
    fs.writeFileSync(path.join(work, "overlay.png"), Buffer.from(shot.result.data, "base64"))
    console.log("overlay screenshot:", path.join(work, "overlay.png"))
    // CC mode: the card's Hide/Show button flips the "Hide captions on screen" setting in place.
    const ccShown = () => evalPage(`document.querySelector('.p-huddle_closed_captions').getBoundingClientRect().right > 0`)
    const hideSetting = () => swEval(`chrome.storage.local.get("settings").then((r) => r.settings.hideCaptions)`)
    check((await overlayInfo())?.cc === "hidden" && !(await ccShown()), "CC mode: card offers the captions button; captions start hidden")
    await clickShadow("cc")
    await sleep(600)
    check((await overlayInfo())?.cc === "shown" && (await ccShown()) && (await hideSetting()) === false,
      "captions button shows the captions on the page and turns the setting off")
    await clickShadow("cc")
    await sleep(600)
    check((await overlayInfo())?.cc === "hidden" && !(await ccShown()) && (await hideSetting()) === true,
      "captions button hides them again and turns the setting back on")
    check(await evalPage(`document.activeElement && document.activeElement.id === 'cs-focus-probe'`), "captions button keeps page focus")
    // Collapse via the card header: the pill goes back to the saved spot (clamped to the right edge),
    // not to where the wider card had to be pushed.
    const hr = await hostRect()
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x: (hr.left + hr.right) / 2, y: hr.top + 12, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 }, sessionId)
    }
    await sleep(300)
    const pr = await hostRect()
    check((await overlayInfo())?.state === "collapsed", "overlay collapses on header click")
    check(pr && Math.abs(pr.right - (pr.vw - 4)) <= 1, `collapsed pill returns to the saved right-edge spot (right ${pr && pr.right}, viewport ${pr && pr.vw})`)
    check((await storedPos()) === JSON.stringify(parkedPos), "collapsing does not overwrite the saved overlayPos")
  }
}
check(captionRight !== undefined && captionRight < 0, "caption box hidden off-screen (right edge " + captionRight + ")")
check(overlayShown, "overlay shown during the call")
check(overlayLatest, "overlay shows the latest caption")
check(toggled, "overlay toggle ran during the call")
check(clicked, "overlay click ran during the call")
check(reattached, "overlay re-attach check ran during the call")
check(pillChecks > 0 && worstOverflow <= 0, `pill parked at the right edge stays on screen as captions widen it (${pillChecks} checks, worst overflow ${worstOverflow} px)`)
console.log("fixture:", fixtureLog.join(" | "))
check(await waitOverlay(false, 6000), "overlay removed after the call")

// The hostile page script: nothing of the private channel reached it, and its forgeries changed nothing.
const atk = await evalPage("window.__atk")
console.log("attacker:", JSON.stringify(atk))
check(Boolean(attack), "attack ran mid-call with the real session id")
check(atk && atk.forged > 3, "attacker forged messages repeatedly during the call")
check(atk && atk.ports === 0 && atk.nodes === 0 && atk.nodeEvents === 0, "attacker could not obtain the private channel (no port, no endpoint, its own endpoint got nothing)")
check(atk && atk.audioBytes === 0 && atk.messages === 0 && atk.detailReads === 0 && atk.protoHits === 0 && atk.blobReads === 0, "attacker read no CallScribe traffic or audio")
check(atk && atk.sessionIds.length === 0, "attacker saw no session id")
if (attack) {
  check(attack.later > attack.chunksAt, `recording kept going after forged stops (chunks ${attack.chunksAt} -> ${attack.later})`)
  const rows = await chunkRows(attack.id)
  const row = await sessionRow(attack.id)
  check(rows.length > 0 && rows.every((c, i) => c.seq === i), "stored chunks are the recorder's own sequence (no forged seq)")
  check(rows.length > 0 && rows[0].head.join(",") === "26,69,223,163", "first stored chunk is a real WebM header, not forged bytes")
  check(rows.every((c) => c.size !== 16), "no forged 16-byte chunk stored")
  check(row && row.audio && row.audio.chunks === rows.length, `session chunk count matches stored rows (${row && row.audio && row.audio.chunks} / ${rows.length})`)
  check(row && !JSON.stringify(row.audioLog || []).includes("spoofed"), "no forged log entry")
}

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
  let dur = NaN
  let readable = true
  try {
    dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim() || 0)
  } catch {
    readable = false
  }
  check(readable, "audio file is readable (ffprobe)")
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
