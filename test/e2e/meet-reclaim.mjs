// runtime I5: hiding Meet's caption band scales the video tiles into the freed space, and must
// do it on top of any transform Meet itself put on a tile, never instead of it.
// Real layout is needed (offset*, getBoundingClientRect, computed transforms), so this runs the
// real adapter in headless Chromium on a static Meet-like grid. No extension, no network.
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..")
const chrome = process.env.CHROME || path.join(os.homedir(), ".hermes/tools/chromium-1208/chrome-linux64/chrome")
const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "callscribe-reclaim-"))
const HOST = "matrix(0.999391, 0.0348995, -0.0348995, 0.999391, 30, 40)"
const page = path.join(work, "grid.html")
fs.writeFileSync(page, `<!doctype html><meta charset="utf-8">
<body style="margin:0">
<div id="grid" style="position: absolute; inset: 0px 0px 200px 0px">
  <div id="t1" data-participant-id="spaces/s/devices/1" style="position:absolute; left:100px; top:0; width:400px; height:300px; transform: ${HOST}"><span class="notranslate">Alice</span></div>
  <div id="t2" data-participant-id="spaces/s/devices/2" style="position:absolute; left:500px; top:0; width:400px; height:300px"><span class="notranslate">Bob</span></div>
</div>
<div id="grid2" style="position: absolute; inset: 0px 0px 200px 0px; pointer-events: none">
  <div id="t3" data-participant-id="spaces/s/devices/3" style="position:absolute; left:0; top:400px; width:100px; height:100px; translate: 10px 5px"><span class="notranslate">Carol</span></div>
</div>
<div style="position:absolute; left:0; right:0; bottom:0; height:200px"><div role="region" aria-label="Captions"><div>caption</div></div></div>
<script src="file://${repo}/src/shared/meet-proto.js"></script>
<script src="file://${repo}/src/content/adapters/google-meet.js"></script>
`)

const proc = spawn(chrome, ["--headless=new", `--user-data-dir=${path.join(work, "profile")}`, "--no-first-run", "--window-size=1000,800",
  "--allow-file-access-from-files", "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] })
let ok = true
const check = (cond, label) => { console.log((cond ? "PASS " : "FAIL ") + label); ok = ok && cond }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  const wsUrl = await new Promise((res, rej) => { let b = ""; proc.stderr.on("data", (d) => { b += d; const m = b.match(/DevTools listening on (ws:\S+)/); if (m) res(m[1]) }); setTimeout(() => rej(new Error(b)), 20000) })
  const ws = new WebSocket(wsUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const i = ++id
    const t = setTimeout(() => { pending.delete(i); rej(new Error(`CDP ${method} timed out after 30s`)) }, 30000)
    pending.set(i, (v) => { clearTimeout(t); res(v) })
    ws.send(JSON.stringify({ id: i, method, params, sessionId }))
  })
  const { result: { targetId } } = await send("Target.createTarget", { url: "file://" + page })
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true })
  await send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId)
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
    return r.result && r.result.result && r.result.result.value
  }
  for (let i = 0; i < 40 && !(await ev("Boolean(window.CallScribe && CallScribe.adapters && document.readyState === 'complete')")); i++) await sleep(250)

  const r = await ev(`(() => {
    const meet = CallScribe.adapters.find((a) => a.id === "google-meet")
    const rect = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height } }
    const t1 = document.getElementById("t1"), t2 = document.getElementById("t2"), t3 = document.getElementById("t3")
    const before = { t1: rect(t1), t2: rect(t2), t3: rect(t3) }
    meet.reclaimCaptionSpace(true)
    const css = getComputedStyle(t1)
    const after = { t1: rect(t1), t2: rect(t2), t3: rect(t3), t3translate: getComputedStyle(t3).translate, transform: css.transform, inline: t1.style.transform, origin: css.transformOrigin }
    meet.reclaimCaptionSpace(true) // idempotent
    const again = { t1: rect(t1), t2: rect(t2) }
    meet.reclaimCaptionSpace(false)
    const restored = { t1: rect(t1), t2: rect(t2), transform: getComputedStyle(t1).transform }
    return { before, after, again, restored }
  })()`)
  console.log(JSON.stringify(r))
  const near = (a, b) => Math.abs(a - b) < 1.01
  const same = (a, b) => ["left", "top", "width", "height"].every((k) => near(a[k], b[k]))
  // Grid 1000x600 plus a 200px band: tiles span x 100..900, y 0..300, so s = min(1000/800, 800/300) = 1.25,
  // and the group is centred: tx = -125, ty = 212.5. Tile 2 (no host transform) lands at 500, 212.5, 500x375.
  check(same(r.after.t2, { left: 500, top: 212.5, width: 500, height: 375 }), "a tile without a host transform is scaled and centred into the freed band")
  check(r.after.transform === HOST && r.after.inline === HOST, `the host's own transform on a tile is kept (${r.after.transform})`)
  // Ours composes outside the host's: the host-rendered tile goes through the same grid-level
  // mapping p -> s*p + (tx, ty) as tile 2, so the host's rotation and offset are kept, scaled.
  const s = 1.25, tx = -125, ty = 212.5
  const b = r.before.t1
  const exp = { left: s * b.left + tx, top: s * b.top + ty, width: s * b.width, height: s * b.height }
  check(same(r.after.t1, exp), `a tile with a host transform is scaled and moved on top of it (${JSON.stringify(r.after.t1)} vs ${JSON.stringify(exp)})`)
  check(same(r.after.t3, r.before.t3) && r.after.t3translate === "10px 5px", `a grid whose tiles use the translate/scale properties themselves is left alone (${r.after.t3translate})`)
  check(same(r.again.t1, r.after.t1) && same(r.again.t2, r.after.t2), "reapplying is stable")
  check(same(r.restored.t1, r.before.t1) && same(r.restored.t2, r.before.t2) && r.restored.transform === HOST, "showing captions again restores the host layout")
  ws.close()
} catch (e) {
  console.error(e)
  ok = false
} finally {
  proc.kill("SIGKILL")
  fs.rmSync(work, { recursive: true, force: true })
}
console.log(ok ? "meet-reclaim: PASS" : "meet-reclaim: FAIL")
process.exit(ok ? 0 : 1)
