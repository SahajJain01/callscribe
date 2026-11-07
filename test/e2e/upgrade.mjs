// End-to-end: upgrading from the previous version's database (DB v1) (review I-1).
// A stub extension at the same path (so the same extension id and IndexedDB) writes a v1
// database with the previous version's schema and rows, Chrome is closed, the real build is put
// in its place and Chrome is started again on the same profile, as an extension update would;
// then the periodic sweep runs (its alarm fired early).
//  on:  auto-download on: a call the old version ended but never exported is exported once;
//       one it marked exported stays manual-only (no files, no job).
//  off: auto-download off: the never-exported call is flagged not saved with a Save button
//       (and the button saves it); the exported one is untouched.
// Usage: node test/e2e/upgrade.mjs   (CALLSCRIBE_EXT=<dir> upgrades to a build from elsewhere)
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..")
const build = process.env.CALLSCRIBE_EXT ? path.resolve(process.env.CALLSCRIBE_EXT) : root
if (build !== root) console.log("upgrading to the build in", build)
const chromeBin = process.env.CHROME || path.join(os.homedir(), ".hermes/tools/chromium-1208/chrome-linux64/chrome")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ok = true
const check = (cond, label) => { console.log((cond ? "PASS " : "FAIL ") + label); ok = ok && Boolean(cond) }
async function waitFor(fn, ms, step = 500) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) { const v = await fn(); if (v) return v }
  return null
}

const STUB_SW = `chrome.runtime.onInstalled.addListener(() => {})`
const STUB_MANIFEST = { manifest_version: 3, name: "CallScribe (previous version stub)", version: "0.1.0", permissions: ["storage", "unlimitedStorage"], background: { service_worker: "sw.js" } }

async function launch(work, ext) {
  const downloads = path.join(work, "downloads")
  const proc = spawn(chromeBin, ["--headless=new", `--user-data-dir=${path.join(work, "profile")}`, "--no-first-run", "--no-default-browser-check",
    `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] })
  const wsUrl = await new Promise((res, rej) => { let b = ""; proc.stderr.on("data", (d) => { b += d; const m = b.match(/DevTools listening on (ws:\S+)/); if (m) res(m[1]) }); setTimeout(() => rej(new Error(b)), 20000) })
  const ws = new WebSocket(wsUrl)
  await new Promise((r) => (ws.onopen = r))
  let msgId = 0
  const pending = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params = {}, sessionId) => new Promise((res) => {
    const i = ++msgId
    const t = setTimeout(() => { pending.delete(i); console.log("  (no reply to " + method + ")"); res({}) }, 20000)
    pending.set(i, (m) => { clearTimeout(t); res(m) })
    ws.send(JSON.stringify({ id: i, method, params, sessionId }))
  })
  const attach = async (suffix) => {
    for (let i = 0; i < 60; i++) {
      const { result } = await send("Target.getTargets")
      const t = result && result.targetInfos.find((x) => x.type === "service_worker" && x.url.endsWith(suffix))
      if (t) return { sid: (await send("Target.attachToTarget", { targetId: t.targetId, flatten: true })).result.sessionId, base: t.url.split("/").slice(0, 3).join("/") }
      await sleep(250)
    }
    throw new Error("no service worker " + suffix)
  }
  const evalIn = async (sid, expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sid)).result?.result?.value
  const close = async () => {
    await send("Browser.close")
    await Promise.race([new Promise((r) => proc.once("exit", r)), sleep(10000)])
    proc.kill()
  }
  return { send, attach, evalIn, close, downloads }
}

function copyBuild(from, to) {
  fs.rmSync(to, { recursive: true, force: true })
  fs.mkdirSync(to, { recursive: true })
  for (const p of ["manifest.json", "src", "icons"]) fs.cpSync(path.join(from, p), path.join(to, p), { recursive: true })
}

const day = 24 * 3600 * 1000
const t0 = Date.now() - 2 * day
const v1Rows = [
  // Ended, never exported: the old export died (lifecycle F2).
  { id: "slack-huddle-v1-unsav1", platform: "slack-huddle", platformName: "Slack huddle", title: "v1unsaved", url: "https://app.slack.com/client/T/C", startedAt: t0, updatedAt: t0 + 60000, endedAt: t0 + 60000,
    utterances: [{ speaker: "Alice", text: "a line from the old version", start: t0 + 1000, end: t0 + 2000 }], audio: { chunks: 1, bytes: 3000, mime: "audio/webm;codecs=opus" } },
  // Exported by the old version (unconfirmed): manual-only.
  { id: "slack-huddle-v1-exprt1", platform: "slack-huddle", platformName: "Slack huddle", title: "v1exported", url: "https://app.slack.com/client/T/C", startedAt: t0 + 100000, updatedAt: t0 + 160000, endedAt: t0 + 160000,
    utterances: [{ speaker: "Bob", text: "exported long ago", start: t0 + 101000, end: t0 + 102000 }], audio: { chunks: 0, bytes: 0 }, exported: t0 + 161000, exportErrors: [] },
]

async function scenario(mode) {
  console.log(`-- upgrade with auto-download ${mode}`)
  const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), `callscribe-upgrade-${mode}-`))
  const ext = path.join(work, "ext")
  const downloads = path.join(work, "downloads")
  const outDir = path.join(downloads, "CallScribe")
  fs.mkdirSync(downloads)
  fs.mkdirSync(path.join(work, "profile/Default"), { recursive: true })
  fs.writeFileSync(path.join(work, "profile/Default/Preferences"), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true } }))
  const files = (tag) => (fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => !f.endsWith(".crdownload") && f.includes(tag)) : [])

  // 1. The previous version's database, written by a stub at the extension's path.
  fs.mkdirSync(ext)
  fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(STUB_MANIFEST))
  fs.writeFileSync(path.join(ext, "sw.js"), STUB_SW)
  let b = await launch(work, ext)
  let sw = await b.attach("/sw.js")
  const seeded = await b.evalIn(sw.sid, `new Promise((done) => {
    const q = indexedDB.open("callscribe", 1)
    q.onupgradeneeded = () => {
      const d = q.result
      d.createObjectStore("sessions", { keyPath: "id" }).createIndex("startedAt", "startedAt")
      d.createObjectStore("chunks", { keyPath: ["session", "seq"] }).createIndex("session", "session")
    }
    q.onsuccess = () => {
      const d = q.result
      const tx = d.transaction(["sessions", "chunks"], "readwrite")
      for (const r of ${JSON.stringify(v1Rows)}) tx.objectStore("sessions").put(r)
      tx.objectStore("chunks").put({ session: "slack-huddle-v1-unsav1", seq: 0, bytes: new Uint8Array(3000).fill(5), mime: "audio/webm;codecs=opus" })
      tx.oncomplete = () => { d.close(); chrome.storage.local.set({ settings: { recordAudio: true, includeMic: true, autoCaptions: true, hideCaptions: true, showOverlay: true, autoDownload: ${mode === "on"}, folder: "CallScribe" } }).then(() => done(d.version)) }
      tx.onerror = () => done("ERR " + tx.error)
    }
    q.onerror = () => done("ERR " + q.error)
  })`)
  check(seeded === 1, `wrote a v1 database (version ${seeded})`)
  const stubBase = sw.base
  await b.close()

  // 2. The update: the real build at the same path, same profile.
  copyBuild(build, ext)
  b = await launch(work, ext)
  sw = await b.attach("/src/background/index.js")
  check(sw.base === stubBase, "control: same extension id after the update")
  // A store update fires onInstalled ("update"), which sweeps; a flag-loaded unpacked build
  // started on an existing profile gets neither onInstalled nor onStartup, only the periodic
  // sweep alarm (at most 2 minutes). Fire that alarm now, as export.mjs does.
  await b.evalIn(sw.sid, `chrome.alarms.create("sweep", { when: Date.now() + 50 }).then(() => true, () => true)`)
  const row = (id) => b.evalIn(sw.sid, `new Promise((done) => { const q = indexedDB.open("callscribe"); q.onupgradeneeded = () => q.transaction.abort(); q.onsuccess = () => { const d = q.result; const g = d.transaction("sessions").objectStore("sessions").get(${JSON.stringify(id)}); g.onsuccess = () => { d.close(); done(g.result ? { ...g.result, utterances: g.result.utterances.length, version: d.version } : null) } }; q.onerror = () => done(null) })`)
  const exportedRow = async () => { const r = await row("slack-huddle-v1-exprt1"); return r }

  if (mode === "on") {
    const r = await waitFor(async () => { const s = await row("slack-huddle-v1-unsav1"); return s && s.export && s.export.state === "done" && s }, 30000)
    const s = r || (await row("slack-huddle-v1-unsav1"))
    console.log("  never-exported v1 call:", JSON.stringify(s && { version: s.version, export: s.export && s.export.state, todo: s.todo, legacy: s.legacy }), JSON.stringify(files("v1unsaved")))
    check(Boolean(r), "the call the old version ended but never exported was exported automatically")
    const fu = files("v1unsaved")
    const md = fu.find((f) => f.endsWith(".md"))
    const webm = fu.find((f) => f.endsWith(".webm"))
    check(fu.length === 2 && md && webm && !fu.some((f) => f.includes("(")), `exactly one transcript and one audio file (${JSON.stringify(fu)})`)
    if (md && webm) check(fs.readFileSync(path.join(outDir, md), "utf8").includes(`- Audio backup: ${webm} `) && fs.statSync(path.join(outDir, webm)).size === 3000, "with its stored audio, named in the transcript")
  } else {
    const r = await waitFor(async () => { const s = await row("slack-huddle-v1-unsav1"); return s && s.export && s.export.state === "off" && s }, 20000)
    const s = r || (await row("slack-huddle-v1-unsav1"))
    console.log("  never-exported v1 call:", JSON.stringify(s && { version: s.version, export: s.export && s.export.state, todo: s.todo, legacy: s.legacy }))
    check(Boolean(r) && !r.todo, "auto-download off: flagged, not exported")
    check(files("v1unsaved").length === 0, "no files written")
    const { result: { targetId } } = await b.send("Target.createTarget", { url: sw.base + "/src/popup/popup.html" })
    const { result: { sessionId: popup } } = await b.send("Target.attachToTarget", { targetId, flatten: true })
    await sleep(1500)
    const entry = await b.evalIn(popup, `(() => { const li = document.querySelector('#list li[data-id="slack-huddle-v1-unsav1"]'); return li ? { text: li.textContent.replace(/\\s+/g, " "), buttons: [...li.querySelectorAll("button")].map((x) => x.dataset.a + ":" + x.textContent) } : null })()`)
    check(entry && /Not saved/.test(entry.text) && entry.buttons.includes("export:Save to Downloads"), `popup shows it as not saved with a Save button (${JSON.stringify(entry)})`)
    await b.evalIn(popup, `(() => { document.querySelector('#list li[data-id="slack-huddle-v1-unsav1"] button[data-a="export"]').click(); return true })()`)
    check(await waitFor(async () => { const x = await row("slack-huddle-v1-unsav1"); return x && x.export && x.export.state === "done" }, 20000) && files("v1unsaved").length === 2, `and the button saves it (${JSON.stringify(files("v1unsaved"))})`)
  }
  await sleep(2000)
  const e = await exportedRow()
  check(e && e.version === 2 && !e.export && !e.todo && e.exported && files("v1exported").length === 0, `the call the old version exported stays manual-only (${JSON.stringify(e && { export: e.export, todo: e.todo, files: files("v1exported") })})`)
  await b.close()
  console.log("  (work dir " + work + ")")
}

await scenario("on")
await scenario("off")
console.log(ok ? "\nUPGRADE E2E PASS" : "\nUPGRADE E2E FAIL")
process.exit(ok ? 0 : 1)
