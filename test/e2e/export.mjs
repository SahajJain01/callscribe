// End-to-end: the capture -> export state machine in a real browser (lifecycle F2 F3 F4 F5
// F6 F9 M1 M5, security I2 I4 M5, retention). Messages are sent the way the content script
// sends them (from its isolated world in a Slack tab, so they carry sender.tab), library calls
// from the popup page, and crash leftovers are written straight into IndexedDB. Sweeps are
// triggered by firing the "sweep" alarm early.
//  1. A canceled download (USER_CANCELED) is recorded as canceled and not retried; the popup
//     shows it as not saved, and Save again saves it once.
// 1b. Canceled audio: the transcript is still written at once and says the audio was not saved.
//  2. Two session-ends plus a sweep at once: exactly one transcript and one audio file.
//  3. The last chunk is still being stored when session-end arrives: it is in the audio file.
//  4. 22 unfinished calls older than 21 finished ones are all recovered, under distinct names.
//  5. An export job left "running" by a worker that died is resumed; a download it had already
//     started is adopted, not saved twice.
// 5b. ...but a manual mid-call export of the same file name, made before, is never adopted.
//  6. Deleting a live call stops it taking chunks; chunks for unknown ids are refused and
//     orphan chunk rows are collected; content scripts can't use library calls or another
//     tab's session.
//  7. Retention: only a call exported more than 30 days ago is deleted.
//  8. The popup lists every stored call (Show more) and can delete the oldest; afterwards it
//     still shows all of them (more than 200).
//  9. A normal end stores the time the tab reported, not when the worker got to it.
// 10. Restarting the worker doesn't push the sweep alarm back.
// Usage: node test/e2e/export.mjs   (CALLSCRIBE_EXT=<dir> loads the extension from elsewhere)
import { spawn, execFileSync } from "node:child_process"
import fs from "node:fs"
import https from "node:https"
import os from "node:os"
import path from "node:path"

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..")
const ext = process.env.CALLSCRIBE_EXT ? path.resolve(process.env.CALLSCRIBE_EXT) : root
if (ext !== root) console.log("extension loaded from", ext)
const chrome = process.env.CHROME || path.join(os.homedir(), ".hermes/tools/chromium-1208/chrome-linux64/chrome")
const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "callscribe-export-"))
const downloads = path.join(work, "downloads")
const outDir = path.join(downloads, "CallScribe")
fs.mkdirSync(downloads)

execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=app.slack.com",
  "-keyout", path.join(work, "key.pem"), "-out", path.join(work, "cert.pem")], { stdio: "ignore" })
const fixture = fs.readFileSync(path.join(root, "test/e2e/slack-fixture.html"), "utf8")
const server = https.createServer({ key: fs.readFileSync(path.join(work, "key.pem")), cert: fs.readFileSync(path.join(work, "cert.pem")) },
  (req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fixture) })
await new Promise((r) => server.listen(0, "127.0.0.1", r))
fs.mkdirSync(path.join(work, "profile/Default"), { recursive: true })
fs.writeFileSync(path.join(work, "profile/Default/Preferences"), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true } }))

const proc = spawn(chrome, ["--headless=new", `--user-data-dir=${path.join(work, "profile")}`, "--no-first-run", "--no-default-browser-check",
  `--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
  `--host-resolver-rules=MAP app.slack.com 127.0.0.1:${server.address().port}`, "--ignore-certificate-errors",
  "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required",
  "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] })
const wsUrl = await new Promise((res, rej) => { let b = ""; proc.stderr.on("data", (d) => { b += d; const m = b.match(/DevTools listening on (ws:\S+)/); if (m) res(m[1]) }); setTimeout(() => rej(new Error(b)), 20000) })
const ws = new WebSocket(wsUrl)
await new Promise((r) => (ws.onopen = r))
let msgId = 0
const pending = new Map()
const events = []
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } else if (m.method) events.push(m) }
// Every command gets an answer, or {} after 20 s: a hang fails a check instead of blocking the run.
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const i = ++msgId
  const t = setTimeout(() => { pending.delete(i); console.log("  (no reply to " + method + ")"); res({}) }, 20000)
  pending.set(i, (m) => { clearTimeout(t); res(m) })
  ws.send(JSON.stringify({ id: i, method, params, sessionId }))
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ok = true
const check = (cond, label) => { console.log((cond ? "PASS " : "FAIL ") + label); ok = ok && Boolean(cond) }
async function waitFor(fn, ms, step = 500) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) { const v = await fn(); if (v) return v }
  return null
}
const files = () => (fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => !f.endsWith(".crdownload")) : [])
const filesFor = (tag) => files().filter((f) => f.includes(tag))

async function swSession() {
  for (let i = 0; i < 40; i++) {
    const { result } = await send("Target.getTargets")
    const sw = result && result.targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/src/background/index.js"))
    if (sw) return { sid: (await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true })).result.sessionId, base: sw.url.split("/src/")[0] }
    await sleep(250)
  }
  throw new Error("no service worker")
}
const sw = await swSession()
const swEval = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sw.sid)).result?.result?.value
await swEval(`chrome.storage.local.get("settings").then((r) => chrome.storage.local.set({ settings: { ...(r.settings || {}), autoDownload: true } })).then(() => true)`)
const db = (body) => swEval(`new Promise((done) => { const q = indexedDB.open("callscribe"); q.onupgradeneeded = () => q.transaction.abort(); q.onsuccess = () => { const d = q.result; const fin = (v) => { d.close(); done(v) }; try { (${body})(d, fin) } catch (e) { fin("ERR " + e) } }; q.onerror = () => done(null) })`)
const row = (id) => db(`(d, fin) => { const g = d.transaction("sessions").objectStore("sessions").get(${JSON.stringify(id)}); g.onsuccess = () => { const s = g.result; if (s) s.utterances = (s.utterances || []).length; fin(s || null) } }`)
const chunkCount = (id) => db(`(d, fin) => { const g = d.transaction("chunks").objectStore("chunks").index("session").count(${JSON.stringify(id)}); g.onsuccess = () => fin(g.result) }`)
const putRows = (rows) => db(`(d, fin) => { const tx = d.transaction("sessions", "readwrite"); for (const r of ${JSON.stringify(rows)}) tx.objectStore("sessions").put(r); tx.oncomplete = () => fin(true); tx.onerror = () => fin("ERR " + tx.error) }`)
const putChunkRow = (id, seq, n) => db(`(d, fin) => { const tx = d.transaction("chunks", "readwrite"); tx.objectStore("chunks").put({ session: ${JSON.stringify(id)}, seq: ${seq}, bytes: new Uint8Array(${n}), mime: "audio/webm" }); tx.oncomplete = () => fin(true) }`)
const countRows = () => db(`(d, fin) => { const g = d.transaction("sessions").objectStore("sessions").count(); g.onsuccess = () => fin(g.result) }`)
// Fire the periodic sweep now (as an overdue alarm would).
const kickSweep = () => swEval(`chrome.alarms.create("sweep", { when: Date.now() + 50 }).then(() => true, () => true)`)

// A Slack tab whose content script is loaded but not in a call; its isolated world sends as CallScribe does.
async function openTab() {
  const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank" })
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true })
  await send("Runtime.enable", {}, sessionId)
  await send("Page.navigate", { url: "https://app.slack.com/client/T000/C000?manual" }, sessionId)
  const ev = async (expression, contextId) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, contextId }, sessionId)).result?.result?.value
  for (let i = 0; i < 40 && !((await ev("window.__log || []")) || []).includes("ready"); i++) await sleep(250)
  const ctx = () => events.filter((e) => e.method === "Runtime.executionContextCreated" && e.sessionId === sessionId &&
    e.params.context.auxData?.type === "isolated" && /CallScribe/.test(e.params.context.name)).map((e) => e.params.context.id).at(-1)
  return {
    sessionId,
    ask: (msg) => ev(`chrome.runtime.sendMessage(${JSON.stringify(msg)}).catch((e) => ({ rejected: String(e) }))`, ctx()),
    run: (expr) => ev(expr, ctx()),
  }
}
const tab = await openTab()
const tabB = await openTab()

// The popup page (opened as a tab): the extension page library calls come from.
const { result: { targetId: popupTarget } } = await send("Target.createTarget", { url: sw.base + "/src/popup/popup.html" })
const { result: { sessionId: popupSid } } = await send("Target.attachToTarget", { targetId: popupTarget, flatten: true })
const popupEval = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, popupSid)).result?.result?.value
await sleep(1000)
const popupAsk = (msg) => popupEval(`chrome.runtime.sendMessage(${JSON.stringify(msg)})`)

const now = () => Date.now()
const chunkB64 = (n, fill) => Buffer.alloc(n, fill).toString("base64")
const start = (id, title, startedAt = now()) => tab.ask({ type: "session-start", session: { id, platform: "slack-huddle", platformName: "Slack huddle", title, url: "https://app.slack.com/client/T000/C000", startedAt } })
const update = (id, title, rev = 1, t = tab) => t.ask({ type: "session-update", id, rev, title, captionsOn: true, utterances: [{ speaker: "Alice", text: `hello from ${title}`, start: now() - 2000, end: now() - 1000 }] })
const chunk = (id, seq, n = 3000, fill = 7) => tab.ask({ type: "audio-chunk", id, seq, mime: "audio/webm;codecs=opus", b64: chunkB64(n, fill) })
const end = (id, at) => tab.ask({ type: "session-end", id, reason: "left", at })

// ---------- 9. end time (M1)
{
  console.log("-- end time")
  const id = "slack-huddle-e2e-endtm"
  await start(id, "endtime", now() - 60000)
  await update(id, "endtime")
  const at = now() - 3000
  await end(id, at)
  const r = await waitFor(async () => { const s = await row(id); return s && s.endedAt && s }, 10000)
  check(r && r.endedAt === at, `ended at the reported time (${r && r.endedAt - at} ms off)`)
}

// The popup's entry for a call: its status text and button labels.
const popupEntry = async (id) => {
  await send("Page.reload", {}, popupSid)
  await sleep(1200)
  return popupEval(`(() => { const li = document.querySelector('#list li[data-id=${JSON.stringify(id)}]'); return li ? { text: li.textContent.replace(/\\s+/g, " "), buttons: [...li.querySelectorAll("button")].map((b) => b.dataset.a + ":" + b.textContent) } : null })()`)
}
const cancelNextDownload = () => swEval(`(() => { globalThis.__cancelNext = 1; if (!globalThis.__cancelHooked) { globalThis.__cancelHooked = true; chrome.downloads.onCreated.addListener((d) => { if (globalThis.__cancelNext > 0) { globalThis.__cancelNext--; chrome.downloads.cancel(d.id) } }) } return true })()`)

// ---------- 1. canceled download: recorded as canceled, not retried, Save again works (F3, review I-2a)
{
  console.log("-- canceled download")
  const id = "slack-huddle-e2e-cnc01"
  await cancelNextDownload()
  await start(id, "cancelme")
  await update(id, "cancelme")
  await end(id)
  const failed = await waitFor(async () => { const s = await row(id); return s && (s.exportErrors || []).some((e) => /USER_CANCELED/.test(e)) && s }, 15000)
  const s1 = failed || (await row(id))
  console.log("  after cancel:", JSON.stringify({ export: s1 && s1.export && { state: s1.export.state, attempts: s1.export.attempts }, exported: s1 && s1.exported, errors: s1 && s1.exportErrors }))
  check(Boolean(failed), "USER_CANCELED recorded as an export error")
  check(failed && failed.export && failed.export.state === "canceled" && !failed.exportDoneAt && !failed.todo, `recorded as canceled, not done, not sweep work (${failed && failed.export && failed.export.state})`)
  await sleep(16000) // a retry would be due 15 s after a failed attempt
  await kickSweep()
  await sleep(4000)
  const s2 = await row(id)
  check(filesFor("cancelme").length === 0 && s2 && s2.export && s2.export.state === "canceled" && s2.export.attempts === 1, `not retried automatically (${JSON.stringify(filesFor("cancelme"))}, ${s2 && s2.export && s2.export.state})`)
  const entry = await popupEntry(id)
  check(entry && /Not saved/.test(entry.text) && entry.buttons.includes("export:Save again"), `popup shows Not saved with Save again (${JSON.stringify(entry)})`)
  await popupEval(`(() => { document.querySelector('#list li[data-id=${JSON.stringify(id)}] button[data-a="export"]').click(); return true })()`)
  const done = await waitFor(async () => { const s = await row(id); return s && s.export && s.export.state === "done" && s }, 20000)
  check(Boolean(done), "Save again saved it")
  const fs1 = filesFor("cancelme")
  check(fs1.length === 1 && fs1[0].endsWith(".md") && !fs1[0].includes("("), `one transcript, no duplicate (${JSON.stringify(fs1)})`)
}

// ---------- 1b. canceled audio: the transcript is still written at once, saying audio was not saved (review I-2b)
{
  console.log("-- canceled audio download")
  const id = "slack-huddle-e2e-cna01"
  await start(id, "cancelaudio")
  await update(id, "cancelaudio")
  await chunk(id, 0, 4000)
  await cancelNextDownload() // the audio goes first
  await end(id)
  const md = await waitFor(async () => filesFor("cancelaudio").find((f) => f.endsWith(".md")), 12000)
  check(Boolean(md), `transcript written right after the audio was canceled (${JSON.stringify(filesFor("cancelaudio"))})`)
  if (md) {
    const text = fs.readFileSync(path.join(outDir, md), "utf8")
    check(text.includes("- Audio backup: not saved") && !/\.webm/.test(text), "its header says the audio backup was not saved")
  }
  const s = await waitFor(async () => { const r = await row(id); return r && r.export && r.export.state === "canceled" && r }, 10000)
  check(s && !s.todo && !s.exportDoneAt && filesFor("cancelaudio").filter((f) => f.endsWith(".webm")).length === 0, `audio recorded as canceled, not retried, never due for retention (${s && s.export && s.export.state})`)
  const entry = await popupEntry(id)
  check(entry && /Not saved/.test(entry.text) && entry.buttons.includes("export:Save again"), "popup shows Not saved with Save again")
}

// ---------- 2. two finalizers and a sweep at once (F4)
{
  console.log("-- racing finalizers")
  const id = "slack-huddle-e2e-race1"
  await start(id, "racer")
  await update(id, "racer")
  await chunk(id, 0, 4000)
  await tab.run(`(() => { const m = { type: "session-end", id: ${JSON.stringify(id)}, reason: "left" }; chrome.runtime.sendMessage(m); chrome.runtime.sendMessage(m); return true })()`)
  await kickSweep()
  await waitFor(async () => filesFor("racer").length >= 2, 15000)
  await sleep(4000) // time for any duplicate to land
  const fr = filesFor("racer")
  check(fr.filter((f) => f.endsWith(".md")).length === 1 && fr.filter((f) => f.endsWith(".webm")).length === 1, `exactly one transcript and one audio file (${JSON.stringify(fr)})`)
  const md = fr.find((f) => f.endsWith(".md"))
  const audio = fr.find((f) => f.endsWith(".webm"))
  if (md && audio) check(fs.readFileSync(path.join(outDir, md), "utf8").includes(`- Audio backup: ${audio} `), "transcript names the audio file that was written (F9)")
}

// ---------- 3. last chunk still being stored at session-end (F5)
{
  console.log("-- last chunk during finalize")
  const id = "slack-huddle-e2e-tail1"
  await start(id, "tailend")
  await update(id, "tailend")
  // Hold the chunks store busy from another connection, as a slow disk would.
  await swEval(`new Promise((ready) => { const q = indexedDB.open("callscribe"); q.onsuccess = () => { const d = q.result; const tx = d.transaction("chunks", "readwrite"); const st = tx.objectStore("chunks"); globalThis.__hold = true; const spin = () => { if (globalThis.__hold) st.count().onsuccess = spin }; spin(); tx.oncomplete = () => d.close(); ready(true) } })`)
  await tab.run(`(() => { chrome.runtime.sendMessage({ type: "audio-chunk", id: ${JSON.stringify(id)}, seq: 0, mime: "audio/webm;codecs=opus", b64: ${JSON.stringify(chunkB64(5000, 9))} }); setTimeout(() => chrome.runtime.sendMessage({ type: "session-end", id: ${JSON.stringify(id)}, reason: "left" }), 300); return true })()`)
  await sleep(2500)
  await swEval(`(globalThis.__hold = false, true)`)
  await waitFor(async () => filesFor("tailend").length >= 2, 15000)
  await sleep(1500)
  const ft = filesFor("tailend")
  const audio = ft.find((f) => f.endsWith(".webm"))
  check(Boolean(audio) && fs.statSync(path.join(outDir, audio)).size === 5000, `the last chunk is in the exported audio (${JSON.stringify(ft)})`)
  const s = await row(id)
  check(s && s.audio && s.audio.chunks === 1 && (await chunkCount(id)) === 1, "session counts match the stored chunk")
}

// ---------- 4. more than 20 unfinished calls behind newer finished ones (F6)
{
  console.log("-- recovery is not limited to the newest 20")
  const t0 = now() - 3 * 3600 * 1000
  const finished = Array.from({ length: 21 }, (_, i) => ({ id: `slack-huddle-new-n${i}x`, platform: "slack-huddle", platformName: "Slack huddle", title: "newer", startedAt: t0 + 3600000 + i * 1000, updatedAt: t0 + 3600000 + i * 1000, endedAt: t0 + 3600000 + i * 1000 + 500, utterances: [], audio: { chunks: 0, bytes: 0 }, export: { state: "off" } }))
  const unfinished = Array.from({ length: 22 }, (_, i) => ({ id: `slack-huddle-bulk-b${String(i).padStart(2, "0")}q`, platform: "slack-huddle", platformName: "Slack huddle", title: "bulkcall", url: "https://app.slack.com/client", startedAt: t0 + i, updatedAt: t0 + 60000, tabId: 999999, utterances: [{ speaker: "A", text: "bulk line " + i, start: t0 + 1000, end: t0 + 2000 }], audio: { chunks: 0, bytes: 0 }, todo: 1 }))
  check((await putRows([...finished, ...unfinished])) === true, "wrote 21 finished and 22 older unfinished calls")
  await kickSweep()
  const all = await waitFor(async () => {
    const rows = await Promise.all(unfinished.map((u) => row(u.id)))
    return rows.every((r) => r && r.export && r.export.state === "done") && rows
  }, 90000, 1000)
  const rows = all || (await Promise.all(unfinished.map((u) => row(u.id))))
  check(rows.filter((r) => r && r.endedAt).length === 22, `all 22 unfinished calls ended (${rows.filter((r) => r && r.endedAt).length})`)
  check(Boolean(all), "and all 22 exported")
  const fb = filesFor("bulkcall")
  check(fb.length === 22 && new Set(fb).size === 22 && fb.every((f) => !f.includes("(")), `22 transcripts with distinct names, none uniquified with (n) (${fb.length}; ${fb.slice(0, 2).join(", ")})`)
  check(rows.every((r) => r && r.endedAt === t0 + 60000), "a crashed call ends at its last update")
}

// ---------- 5. an export left running by a dead worker is resumed; a started download is adopted (F2)
{
  console.log("-- resume after the worker died mid-export")
  const t0 = now() - 3600 * 1000
  const base = { platform: "slack-huddle", platformName: "Slack huddle", startedAt: t0, updatedAt: t0 + 60000, endedAt: t0 + 60000, endReason: "left", tabId: 999999, utterances: [{ speaker: "A", text: "resumed", start: t0 + 1000, end: t0 + 2000 }], audio: { chunks: 0, bytes: 0 }, todo: 1 }
  // adopt: the old worker had asked Chrome for this download but died before recording its id.
  const requestedAt = now() - 50
  const pre = await swEval(`new Promise((r) => chrome.downloads.download({ url: "data:text/markdown;base64,${Buffer.from("already saved").toString("base64")}", filename: "CallScribe/adoptjob_aa1.md", conflictAction: "uniquify", saveAs: false }, (id) => r(id)))`)
  await waitFor(async () => filesFor("adoptjob").length === 1, 10000)
  check(await putRows([
    { ...base, id: "slack-huddle-rs-rsm01", title: "resumejob", export: { state: "running", owner: "dead-worker", attempts: 1, nextAttemptAt: 0, folder: "CallScribe", base: "resumejob_rsm01", files: {}, log: [] } },
    { ...base, id: "slack-huddle-rs-aa1", title: "adoptjob", export: { state: "running", owner: "dead-worker", attempts: 1, nextAttemptAt: 0, folder: "CallScribe", base: "adoptjob_aa1", files: { transcript: { state: "starting", name: "CallScribe/adoptjob_aa1.md", requestedAt } }, log: [] } },
  ]) === true, `wrote two interrupted export jobs (pre-started download ${pre})`)
  await kickSweep()
  const r1 = await waitFor(async () => { const s = await row("slack-huddle-rs-rsm01"); return s && s.export && s.export.state === "done" && s }, 20000)
  const r2 = await waitFor(async () => { const s = await row("slack-huddle-rs-aa1"); return s && s.export && s.export.state === "done" && s }, 20000)
  await sleep(2000)
  check(Boolean(r1) && filesFor("resumejob").length === 1, `interrupted export resumed once (${JSON.stringify(filesFor("resumejob"))})`)
  check(Boolean(r2) && filesFor("adoptjob").length === 1 && r2.export.files.transcript.downloadId === pre, `started download adopted, not saved twice (${JSON.stringify(filesFor("adoptjob"))})`)
}

// ---------- 5b. resume never adopts a manual mid-call export of the same name (review I-3)
{
  console.log("-- resume does not adopt a manual mid-call transcript")
  const id = "slack-huddle-e2e-man01"
  await start(id, "manualmid")
  await update(id, "manualmid")
  check((await popupAsk({ type: "export-transcript", id })) && (await waitFor(async () => filesFor("manualmid").length === 1, 10000)), "manual Transcript export during the call")
  const manual = await swEval(`chrome.downloads.search({ query: ["manualmid"] }).then((a) => a.map((d) => ({ id: d.id, filename: d.filename.split("/").pop(), state: d.state })))`)
  const m = manual && manual[0]
  const stem = m && m.filename.replace(/\.md$/, "")
  await tab.ask({ type: "session-update", id, rev: 2, title: "manualmid", captionsOn: true, utterances: [{ speaker: "Alice", text: "partial line", start: now() - 4000, end: now() - 3000 }, { speaker: "Bob", text: "FINAL LINE after the manual export", start: now() - 2000, end: now() - 1000 }] })
  await sleep(50)
  // The worker claimed the export, recorded the transcript as "starting" and died before Chrome got the request.
  const patched = await db(`(d, fin) => { const tx = d.transaction("sessions", "readwrite"); const st = tx.objectStore("sessions"); const g = st.get(${JSON.stringify(id)}); g.onsuccess = () => { const s = g.result; const t = Date.now(); Object.assign(s, { endedAt: t - 1000, endReason: "left", todo: 1, export: { state: "running", owner: "dead-worker", attempts: 1, nextAttemptAt: 0, folder: "CallScribe", base: ${JSON.stringify(stem)}, files: { transcript: { state: "starting", name: ${JSON.stringify("CallScribe/" + stem + ".md")}, requestedAt: t } }, log: [] } }); st.put(s) }; tx.oncomplete = () => fin(true) }`)
  check(patched === true && m && m.state === "complete", `wrote the interrupted job over the manual file's name (${JSON.stringify(manual)})`)
  await kickSweep()
  const s = await waitFor(async () => { const r = await row(id); return r && r.export && r.export.state !== "running" && r }, 20000)
  const t = s && s.export && s.export.files && s.export.files.transcript
  console.log("  job transcript:", JSON.stringify(t), "files:", JSON.stringify(filesFor("manualmid")))
  check(t && t.downloadId !== m.id, "the manual partial transcript was not adopted as the job's output")
  check(!(s && s.export.state === "done" && t && t.downloadId === m.id), "and the call was not marked done on it")
  const jobFile = t && t.filename
  check(jobFile && jobFile !== m.filename && fs.readFileSync(path.join(outDir, jobFile), "utf8").includes("FINAL LINE"), `the job wrote the full transcript itself (${jobFile})`)
  check(!fs.readFileSync(path.join(outDir, m.filename), "utf8").includes("FINAL LINE"), "control: the manual file is the partial one")
}

// ---------- 6. deleting a live call, orphan chunks, sender checks (M5, I2, security M5)
{
  console.log("-- tombstones, orphans, senders")
  const id = "slack-huddle-e2e-del01"
  await start(id, "deleteme")
  await chunk(id, 0)
  const del = await popupAsk({ type: "delete", id })
  check(del && del.ok, "popup deleted the live call")
  const late = await chunk(id, 1)
  check(late && late.error, `a chunk for the deleted call is refused (${JSON.stringify(late)})`)
  const restart = await start(id, "deleteme")
  check(restart && restart.error, `the deleted id can't be started again (${JSON.stringify(restart)})`)
  check((await chunkCount(id)) === 0, "no chunk rows for the deleted call")
  const ghost = await chunk("slack-huddle-ghost-zz9", 0)
  check(ghost && ghost.error && (await chunkCount("slack-huddle-ghost-zz9")) === 0, `chunks for a never-started id are refused (${JSON.stringify(ghost)})`)
  await putChunkRow("slack-huddle-orphan-yy1", 0, 2048)
  await putChunkRow("slack-huddle-orphan-yy1", 1, 2048)
  await kickSweep()
  check(await waitFor(async () => (await chunkCount("slack-huddle-orphan-yy1")) === 0, 15000), "orphan chunk rows collected by the sweep")
  // Content scripts can't use the library.
  const list = await tab.ask({ type: "list" })
  check(list && list.error && !list.sessions, `content script can't list calls (${JSON.stringify(list).slice(0, 80)})`)
  const get = await tab.ask({ type: "get", id: "slack-huddle-e2e-endtm" })
  check(get && get.error && !get.session, "content script can't read a call")
  const del2 = await tab.ask({ type: "delete", id: "slack-huddle-e2e-endtm" })
  check(del2 && del2.error && (await row("slack-huddle-e2e-endtm")), "content script can't delete a call")
  // Another tab can't write into this tab's session.
  const own = "slack-huddle-e2e-own01"
  await start(own, "owned")
  const forged = await update(own, "hijacked", 5, tabB)
  const r = await row(own)
  check(forged && forged.error && r && r.title === "owned", `another tab can't update this tab's session (${JSON.stringify(forged)})`)
  const forgedEnd = await tabB.ask({ type: "session-end", id: own, reason: "left" })
  check(forgedEnd && forgedEnd.error && !(await row(own)).endedAt, "another tab can't end it")
  const pl = await popupAsk({ type: "list" })
  check(pl && Array.isArray(pl.sessions) && pl.sessions.length > 0, "control: the popup can list calls")
}

// ---------- 7. retention
{
  console.log("-- retention")
  const day = 24 * 3600 * 1000
  const t = now()
  const b = { platform: "slack-huddle", platformName: "Slack huddle", title: "keep", utterances: [], audio: { chunks: 1, bytes: 10 } }
  await putRows([
    { ...b, id: "slack-huddle-ret-old01", startedAt: t - 40 * day, endedAt: t - 40 * day + 1000, export: { state: "done" }, exportDoneAt: t - 31 * day },
    { ...b, id: "slack-huddle-ret-new01", startedAt: t - 30 * day, endedAt: t - 30 * day + 1000, export: { state: "done" }, exportDoneAt: t - 29 * day },
    { ...b, id: "slack-huddle-ret-fail1", startedAt: t - 90 * day, endedAt: t - 90 * day + 1000, export: { state: "failed" } },
    { ...b, id: "slack-huddle-ret-off01", startedAt: t - 90 * day, endedAt: t - 90 * day + 1000, export: { state: "off" } },
    { ...b, id: "slack-huddle-ret-leg01", startedAt: t - 90 * day, endedAt: t - 90 * day + 1000, exported: t - 90 * day, exportErrors: [] },
  ])
  await putChunkRow("slack-huddle-ret-old01", 0, 10)
  await putChunkRow("slack-huddle-ret-new01", 0, 10)
  await kickSweep()
  await waitFor(async () => !(await row("slack-huddle-ret-old01")), 15000)
  check(!(await row("slack-huddle-ret-old01")) && (await chunkCount("slack-huddle-ret-old01")) === 0, "exported 31 days ago: deleted with its audio")
  check(Boolean(await row("slack-huddle-ret-new01")) && (await chunkCount("slack-huddle-ret-new01")) === 1, "exported 29 days ago: kept")
  check(Boolean(await row("slack-huddle-ret-fail1")), "never exported successfully: kept")
  check(Boolean(await row("slack-huddle-ret-off01")), "auto-download off: kept")
  check(Boolean(await row("slack-huddle-ret-leg01")), "older version's unconfirmed export: kept")
}

// ---------- 8. the popup lists every call and can delete the oldest (F6, security I4)
{
  console.log("-- popup lists and deletes all calls")
  const t0 = now() - 400 * 24 * 3600 * 1000
  await putRows(Array.from({ length: 215 }, (_, i) => ({ id: `slack-huddle-pop-p${i}z`, platform: "slack-huddle", platformName: "Slack huddle", title: "old call " + i, startedAt: t0 + i * 60000, updatedAt: t0 + i * 60000, endedAt: t0 + i * 60000 + 1000, utterances: [], audio: { chunks: 0, bytes: 0 }, export: { state: "off" } })))
  const total = await countRows()
  await send("Page.reload", {}, popupSid)
  await sleep(1500)
  for (let i = 0; i < 30; i++) {
    const more = await popupEval(`(() => { const b = document.querySelector("#more"); if (!b || b.hidden) return false; b.click(); return true })()`)
    if (!more) break
    await sleep(700)
  }
  const shown = await popupEval(`document.querySelectorAll("#list li[data-id]").length`)
  check(shown === total, `popup shows every stored call (${shown} of ${total})`)
  await popupEval(`(window.confirm = () => true, true)`)
  const clicked = await popupEval(`(() => { const li = document.querySelector('#list li[data-id="slack-huddle-pop-p0z"]'); if (!li) return false; li.querySelector('button[data-a="delete"]').click(); return true })()`)
  check(clicked, "the oldest call has a Delete button")
  check(await waitFor(async () => !(await row("slack-huddle-pop-p0z")), 5000), "and Delete removes it")
  // After the action the popup reloads every call it was showing, not only the first 200 (review M-3).
  const after = await waitFor(async () => { const n = await popupEval(`document.querySelectorAll("#list li[data-id]").length`); return n === total - 1 ? n : null }, 5000)
  const moreHidden = await popupEval(`document.querySelector("#more").hidden`)
  check(after === total - 1 && moreHidden, `after Delete it still shows all ${total - 1} calls (${await popupEval(`document.querySelectorAll("#list li[data-id]").length`)}, Show more hidden: ${moreHidden})`)
}

// ---------- 10. a worker restart keeps the sweep alarm's schedule (M4)
{
  console.log("-- sweep alarm survives a worker restart unchanged")
  const alarm = () => swEval(`chrome.alarms.get("sweep").then((a) => a ? a.scheduledTime : null)`)
  const before = await waitFor(alarm, 10000)
  await swEval(`(globalThis.__beforeRestart = true)`)
  await sleep(1500)
  await send("ServiceWorker.enable", {}, popupSid)
  await send("ServiceWorker.stopAllWorkers", {}, popupSid)
  await sleep(1500)
  await popupAsk({ type: "list" }) // wakes the worker: its top-level code runs again
  Object.assign(sw, await swSession())
  check((await swEval(`typeof globalThis.__beforeRestart`)) === "undefined", "control: the worker really restarted (its globals are gone)")
  const after = await alarm()
  check(before && after === before, `sweep alarm not rescheduled by the restart (${before} -> ${after})`)
}

await send("Browser.close").catch(() => {})
proc.kill()
server.close()
console.log(ok ? "\nEXPORT E2E PASS" : "\nEXPORT E2E FAIL", "(work dir " + work + ")")
process.exit(ok ? 0 : 1)
