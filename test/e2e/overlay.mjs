// runtime I3 + overlay minors, measured in a real browser: the overlay (src/content/overlay.js)
// on a plain page in headless Chromium, fed a 2,000-line call the way main.js feeds it.
// - expanding must not block the main thread (no 'longtask' over 50 ms; the expand handler is timed)
// - collapsed/expanded refreshes stay cheap (timed per update)
// - the whole call can still be scrolled back to (the rendered window extends on scroll-up),
//   with follow-latest and "↓ latest"
// - the card fits a 240x200 CSS px viewport and 300% zoom (426x219 CSS px), default top-centre
// - RTL pages: the overlay chrome stays ltr, caption text and names are dir=auto
// - a press on the transcript's scrollbar drags it and still keeps focus on the page
// No extension, no network. Screenshots go to <work>/*.png (path printed).
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..")
const chrome = process.env.CHROME || path.join(os.homedir(), ".hermes/tools/chromium-1208/chrome-linux64/chrome")
const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "callscribe-overlay-"))
const N = Number(process.env.LINES || 2000)
const page = path.join(work, "call.html")
// attachShadow is opened for the test only, so the test can read the transcript it renders.
fs.writeFileSync(page, `<!doctype html><meta charset="utf-8">
<body style="margin:0; background:#123; height:3000px">
<input id="probe" placeholder="page input (focus probe)" style="margin:300px 20px">
<script>
  const real = Element.prototype.attachShadow
  Element.prototype.attachShadow = function (o) { const r = real.call(this, { ...o, mode: "open" }); window.__shadow = r; return r }
</script>
<script src="file://${repo}/src/content/overlay.js"></script>
`)

const proc = spawn(chrome, ["--headless=new", `--user-data-dir=${path.join(work, "profile")}`, "--no-first-run", "--window-size=1280,720",
  "--allow-file-access-from-files", "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] })
let ok = true
const check = (cond, label) => { console.log((cond ? "PASS " : "FAIL ") + label); ok = ok && cond }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = {}
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
  const metrics = (width, height, deviceScaleFactor = 1) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile: false }, sessionId)
  await metrics(1280, 720)
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
    return r.result && r.result.result && r.result.result.value
  }
  const shot = async (name) => {
    const s = await send("Page.captureScreenshot", { format: "png" }, sessionId)
    const f = path.join(work, name)
    fs.writeFileSync(f, Buffer.from(s.result.data, "base64"))
    console.log("screenshot:", f)
    return f
  }
  const mouse = async (x, y, kinds = ["mouseMoved", "mousePressed", "mouseReleased"]) => {
    for (const type of kinds) {
      await send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 }, sessionId)
    }
  }
  for (let i = 0; i < 40 && !(await ev("Boolean(window.CallScribe && CallScribe.createOverlay && document.readyState === 'complete')")); i++) await sleep(250)

  // A 2,000-line call, ~17 s apart (about 9.5 hours of lines at that rate; it's the count that matters).
  await ev(`(() => {
    const T0 = Date.now() - ${N} * 17000 - 5000
    const who = ["Priya Raman", "Sam Okafor", "Alice", "Bob (Acme)"]
    const words = "we should ship the export fix today and keep the overlay cheap while the call runs for two hours".split(" ")
    const lines = []
    for (let i = 0; i < ${N}; i++) {
      const w = []
      for (let k = 0; k < 14 + (i % 9); k++) w.push(words[(i * 7 + k * 3) % words.length])
      lines.push({ speaker: who[i % who.length], text: "line " + i + " " + w.join(" "), start: T0 + i * 17000, end: T0 + i * 17000 + 9000, live: false })
    }
    lines[lines.length - 1].live = true
    window.__T0 = T0
    window.__lines = lines
    window.__state = (ls) => ({ platform: "google-meet", startedAt: T0, source: "feed", audio: "recording", micMuted: false, micRecorded: true, lines: ls, lastCaptionAt: Date.now() })
    window.__long = []
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push({ at: e.startTime, ms: e.duration }) }).observe({ type: "longtask", buffered: true })
    // Times the click handler that expands the card, including the layout it forces.
    window.__handler = []
    let t = 0
    addEventListener("pointerup", () => { t = performance.now() }, true)
    addEventListener("pointerup", () => { if (t) window.__handler.push(performance.now() - t); t = 0 })
    document.getElementById("probe").focus()
    window.__ov = CallScribe.createOverlay({ doc: document, storage: null, onCaptionLanguage: (code) => { window.__picked = code } })
    window.__ov.update(window.__state(lines))
    return true
  })()`)
  await sleep(300)
  // Per-update cost: same lines (a quiet heartbeat), then a new array with the live line grown
  // (what main.js passes when a caption changes).
  const timeUpdates = (label) => ev(`(() => {
    const ls = window.__lines
    const runs = (fn, n) => { const ts = []; for (let i = 0; i < n; i++) { const a = performance.now(); fn(i); document.body.offsetHeight; ts.push(performance.now() - a) } ts.sort((a, b) => a - b); return { mean: +(ts.reduce((s, x) => s + x, 0) / n).toFixed(3), p95: +ts[Math.floor(n * 0.95)].toFixed(3), max: +ts[n - 1].toFixed(3) } }
    const same = runs(() => window.__ov.update(window.__state(ls)), 40)
    const grown = runs((i) => {
      const next = ls.slice()
      next[next.length - 1] = { ...ls[ls.length - 1], text: ls[ls.length - 1].text + " more" + i }
      window.__lines = next
      window.__ov.update(window.__state(next))
    }, 40)
    return { same, grown }
  })()`)
  results.collapsed = await timeUpdates("collapsed")
  console.log("collapsed update ms:", JSON.stringify(results.collapsed))
  check(results.collapsed.same.p95 < 2, `collapsed refresh with ${N} lines is cheap (p95 ${results.collapsed.same.p95} ms < 2)`)

  // Expand with a real click on the pill.
  await ev("window.__long.length = 0, true")
  const pill = await ev(`(() => { const b = document.getElementById("callscribe-overlay").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
  await mouse(pill.x, pill.y)
  await sleep(800)
  const exp = await ev(`({ state: document.getElementById("callscribe-overlay").getAttribute("data-state"), handler: window.__handler.slice(), long: window.__long.slice(), focus: document.activeElement && document.activeElement.id, rows: __shadow.querySelectorAll(".row").length })`)
  results.expand = exp
  console.log("expand:", JSON.stringify(exp))
  check(exp.state === "expanded", "pill click expands the card")
  check(exp.focus === "probe", "expanding keeps focus on the page")
  // The first expansion also pays the card's one-off first layout (~16 ms here even with 10
  // lines); it must stay well clear of a long task. Re-expanding is the per-line part.
  const handlerMs = Math.max(...exp.handler)
  check(handlerMs < 40, `expanding ${N} lines the first time is one short task (handler ${handlerMs.toFixed(1)} ms < 40)`)
  check(exp.long.every((l) => l.ms <= 50), `no long task over 50 ms while expanding (${JSON.stringify(exp.long.map((l) => Math.round(l.ms)))})`)
  const tailShown = await ev(`__shadow.querySelector(".log").textContent.includes("line ${N - 1} ")`)
  check(tailShown, "expanded card shows the latest line")
  const atBottom = await ev(`(() => { const l = __shadow.querySelector(".log"); return l.scrollHeight - l.scrollTop - l.clientHeight <= 24 })()`)
  check(atBottom, "expanded card follows the latest line")

  // Collapse and expand again, twice: collapsing unmounts the rows, re-expanding is short.
  const reexpand = []
  for (let r = 0; r < 2; r++) {
    const hd = await ev(`(() => { const b = __shadow.querySelector(".hd").getBoundingClientRect(); return { x: b.left + 40, y: b.top + 10 } })()`)
    await mouse(hd.x, hd.y)
    await sleep(300)
    const gone = await ev(`({ state: document.getElementById("callscribe-overlay").getAttribute("data-state"), rows: __shadow.querySelectorAll(".row").length })`)
    check(gone.state === "collapsed" && gone.rows === 0, `collapsing unmounts the transcript rows (${JSON.stringify(gone)})`)
    const p2 = await ev(`(() => { const b = document.getElementById("callscribe-overlay").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
    await ev("window.__handler.length = 0, true")
    await mouse(p2.x, p2.y)
    await sleep(300)
    reexpand.push(...(await ev("window.__handler")))
  }
  results.reexpand = reexpand
  check(reexpand.length === 2 && reexpand.every((ms) => ms < 16), `re-expanding ${N} lines takes under 16 ms (${reexpand.map((ms) => ms.toFixed(1)).join(", ")} ms)`)
  results.expanded = await timeUpdates("expanded")
  console.log("expanded update ms:", JSON.stringify(results.expanded))
  check(results.expanded.same.p95 < 2, `expanded quiet refresh is cheap (p95 ${results.expanded.same.p95} ms < 2)`)
  check(results.expanded.grown.p95 < 8, `expanded refresh with a growing live line is cheap (p95 ${results.expanded.grown.p95} ms < 8)`)

  // Scroll back through the whole call with the mouse wheel; every extension step stays short.
  await ev("window.__long.length = 0, true")
  const logBox = await ev(`(() => { const b = __shadow.querySelector(".log").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, left: b.left, right: b.right, top: b.top, bottom: b.bottom } })()`)
  let reachedFirst = false
  let midShot = null
  const t0 = Date.now()
  for (let i = 0; i < 400 && !reachedFirst; i++) {
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: logBox.x, y: logBox.y, deltaX: 0, deltaY: -3000 }, sessionId)
    await sleep(30)
    reachedFirst = await ev(`(() => { const l = __shadow.querySelector(".log"); return l.textContent.includes("line 0 ") && l.scrollTop === 0 })()`)
    if (!midShot && (await ev(`__shadow.querySelector(".log").textContent.includes("line ${Math.floor(N / 2)} ")`))) {
      await ev(`(() => { const r = [...__shadow.querySelectorAll(".row")].find((r) => r.textContent.includes("line ${Math.floor(N / 2)} ")); r.scrollIntoView({ block: "center" }); return true })()`)
      await sleep(100)
      midShot = await shot("expanded-2000-mid-call.png")
    }
  }
  results.scrollBack = { reachedFirst, ms: Date.now() - t0, long: await ev("window.__long.slice()") }
  console.log("scroll back:", JSON.stringify(results.scrollBack))
  check(reachedFirst, "the whole call can be scrolled back to its first line")
  check(results.scrollBack.long.every((l) => l.ms <= 50), `no long task over 50 ms while scrolling back (${JSON.stringify(results.scrollBack.long.map((l) => Math.round(l.ms)))})`)
  const order = await ev(`(() => { const rs = [...__shadow.querySelectorAll(".row")].map((r) => +r.textContent.match(/line (\\d+) /)[1]); return rs.every((v, i) => v === rs[0] + i) && rs[0] === 0 && rs.at(-1) === ${N - 1} })()`)
  check(order, "rendered rows are the call in order, first to latest, no gaps")

  // Scrolled up: a new line doesn't yank the view, "↓ latest" shows and jumps back.
  const before = await ev(`__shadow.querySelector(".log").scrollTop`)
  await ev(`(() => { window.__lines = window.__lines.concat({ speaker: "Sam Okafor", text: "line ${N} new while scrolled up", start: Date.now(), end: Date.now(), live: true }); window.__ov.update(window.__state(window.__lines)); return true })()`)
  await sleep(100)
  const after = await ev(`({ top: __shadow.querySelector(".log").scrollTop, jump: !__shadow.querySelector(".jump").hidden })`)
  check(after.top === before && after.jump, `scrolled up: a new line keeps the view (${before} -> ${after.top}) and shows "↓ latest"`)
  const jb = await ev(`(() => { const b = __shadow.querySelector(".jump").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
  await mouse(jb.x, jb.y)
  await sleep(200)
  const back = await ev(`(() => { const l = __shadow.querySelector(".log"); return { bottom: l.scrollHeight - l.scrollTop - l.clientHeight <= 24, latest: l.textContent.includes("line ${N} new"), jump: !__shadow.querySelector(".jump").hidden, focus: document.activeElement.id } })()`)
  check(back.bottom && back.latest && !back.jump && back.focus === "probe", `"↓ latest" jumps to the new line and keeps page focus (${JSON.stringify(back)})`)

  // Following again: the DOM doesn't keep growing with the call.
  await ev(`(() => { for (let i = 1; i <= 400; i++) { window.__lines = window.__lines.concat({ speaker: "Alice", text: "line " + (${N} + i) + " more talk", start: Date.now(), end: Date.now(), live: false }); window.__ov.update(window.__state(window.__lines)) } return true })()`)
  const follow = await ev(`(() => { const l = __shadow.querySelector(".log"); return { rows: __shadow.querySelectorAll(".row").length, bottom: l.scrollHeight - l.scrollTop - l.clientHeight <= 24, latest: l.textContent.includes("line ${N + 400} ") } })()`)
  results.followRows = follow.rows
  check(follow.bottom && follow.latest, "following: new lines keep the latest in view")
  check(follow.rows <= 400, `following: rows mounted stay bounded (${follow.rows} <= 400)`)

  // The transcript scrollbar: a press-drag on it scrolls and keeps page focus.
  // Scrolled to the middle first; aim at the middle of the thumb and drag it down.
  const sb = await ev(`(() => { const l = __shadow.querySelector(".log"); l.scrollTop = (l.scrollHeight - l.clientHeight) / 2; const b = l.getBoundingClientRect(); const th = Math.max(20, l.clientHeight * l.clientHeight / l.scrollHeight); return { x: b.left + l.clientLeft + l.clientWidth + (l.offsetWidth - l.clientWidth - l.clientLeft) / 2, y: b.top + l.clientTop + (l.clientHeight - th) * (l.scrollTop / (l.scrollHeight - l.clientHeight)) + th / 2, w: l.offsetWidth - l.clientWidth, top: l.scrollTop } })()`)
  await sleep(300) // let the compositor move the thumb before pressing it
  if (sb.w > 0) {
    await mouse(sb.x, sb.y, ["mouseMoved", "mousePressed"])
    for (let k = 1; k <= 5; k++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: sb.x, y: sb.y + k * 10, button: "left", buttons: 1 }, sessionId)
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: sb.x, y: sb.y + 50, button: "left", buttons: 0, clickCount: 1 }, sessionId)
    await sleep(200)
    const r = await ev(`({ top: __shadow.querySelector(".log").scrollTop, focus: document.activeElement.id, hit: window.__sbHit })`)
    check(r.top > sb.top && r.focus === "probe", `scrollbar drag scrolls the transcript (${sb.top} -> ${r.top}) and keeps page focus`)
  } else console.log("note: overlay scrollbars in this Chromium take no layout width; scrollbar drag not checked")

  // Fits small viewports and 300% zoom (1280x657 at 300% is 426x219 CSS px), default top-centre.
  const card = () => ev(`(() => { const c = __shadow.querySelector(".card").getBoundingClientRect(); return { left: c.left, right: c.right, top: c.top, bottom: c.bottom, vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight } })()`)
  const inside = (c) => c.left >= 0 && c.top >= 0 && c.right <= c.vw && c.bottom <= c.vh
  for (const [w, h, dsf, name] of [[240, 200, 1, "card-240x200.png"], [426, 219, 3, "card-300pct-zoom.png"]]) {
    await metrics(w, h, dsf)
    await sleep(300)
    const c = await card()
    results[name] = c
    check(inside(c), `card fits ${w}x${h} CSS px${dsf > 1 ? " at 300% zoom" : ""} (${JSON.stringify(c)})`)
    await shot(name)
  }
  await metrics(1280, 720)
  await sleep(200)

  // RTL page: the overlay's own layout stays ltr; captions and names pick their direction.
  await ev(`(() => { document.documentElement.dir = "rtl"; window.__lines = window.__lines.concat({ speaker: "مريم", text: "line ${N + 401} مرحبا بالجميع", start: Date.now(), end: Date.now(), live: false }); window.__ov.update(window.__state(window.__lines)); return true })()`)
  await sleep(100)
  const rtl = await ev(`(() => {
    const rows = [...__shadow.querySelectorAll(".row")]
    const last = rows.at(-1)
    return {
      card: getComputedStyle(__shadow.querySelector(".card")).direction,
      pill: getComputedStyle(__shadow.querySelector(".pill")).direction,
      log: getComputedStyle(__shadow.querySelector(".log")).direction,
      text: last.querySelector("span:not(.t)").getAttribute("dir"),
      name: last.querySelector("b").getAttribute("dir"),
      textBidi: getComputedStyle(last.querySelector("span:not(.t)")).unicodeBidi,
      pillText: __shadow.querySelector(".tail > span").getAttribute("dir"),
      pillName: __shadow.querySelector(".pill .sp").getAttribute("dir"),
    }
  })()`)
  results.rtl = rtl
  check(rtl.card === "ltr" && rtl.pill === "ltr" && rtl.log === "ltr", `RTL page: overlay chrome stays ltr (${JSON.stringify(rtl)})`)
  check(rtl.text === "auto" && rtl.name === "auto" && rtl.pillText === "auto" && rtl.pillName === "auto" && /isolate/.test(rtl.textBidi), "caption text and names are dir=auto, isolated")

  // Caption language menu (Meet) and hint (Slack), in the Captions status row.
  await ev(`(() => {
    document.documentElement.dir = ""
    const langs = [["en-US", "English (US)"], ["vi-VN", "Tiếng Việt"], ["ja-JP", "日本語"]]
    const base = window.__state
    window.__state = (ls) => ({ ...base(ls), captionLanguage: { code: "vi-VN", options: langs }, captionHint: null })
    window.__ov.update(window.__state(window.__lines))
    return true
  })()`)
  await sleep(100)
  const menu = await ev(`(() => { const s = __shadow.querySelector(".st select"); if (!s) return null; window.__sel = s; const b = s.getBoundingClientRect(); return { value: s.value, n: s.options.length, label: s.options[s.selectedIndex].textContent, x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
  check(Boolean(menu) && menu.value === "vi-VN" && menu.n === 3 && menu.label === "Tiếng Việt", `Meet: language menu in the status row shows the chosen language (${JSON.stringify(menu)})`)
  if (menu) {
    await mouse(menu.x, menu.y)
    await sleep(300)
    const after = await ev(`({ state: document.getElementById("callscribe-overlay").getAttribute("data-state"), focused: __shadow.activeElement === window.__sel })`)
    check(after.state === "expanded", `clicking the menu doesn't collapse the card (${JSON.stringify(after)})`)
    check(after.focused, "clicking the menu focuses it, so the dropdown can open (mousedown isn't cancelled)")
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId)
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId)
    const kept = await ev(`(() => { window.__ov.update(window.__state(window.__lines)); window.__ov.update(window.__state(window.__lines)); return __shadow.querySelector(".st select") === window.__sel })()`)
    check(kept, "overlay refreshes keep the same menu element (an open dropdown isn't torn down)")
    // I1: while the menu is in use, refreshes that change the status (a new line) leave it alone.
    await ev(`(() => { window.__sel.focus(); return true })()`)
    const busy = await ev(`(() => {
      for (let i = 0; i < 3; i++) {
        window.__lines = window.__lines.concat({ speaker: "Alice", text: "status change " + i, start: Date.now(), end: Date.now(), live: false })
        window.__ov.update(window.__state(window.__lines))
      }
      return { same: __shadow.querySelector(".st select") === window.__sel, connected: window.__sel.isConnected, focused: __shadow.activeElement === window.__sel }
    })()`)
    check(busy.same && busy.connected && busy.focused, `status changes while the menu is open don't detach or unfocus it (${JSON.stringify(busy)})`)
    const picked = await ev(`(() => { window.__sel.value = "ja-JP"; window.__sel.dispatchEvent(new Event("change", { bubbles: true })); return window.__picked })()`)
    check(picked === "ja-JP", `choosing a language calls onCaptionLanguage (${picked})`)
    // I2: after choosing, keyboard focus leaves the overlay (Meet's Space-to-unmute keeps working).
    const after2 = await ev(`({ shadowFocus: Boolean(__shadow.activeElement), active: document.activeElement && document.activeElement.id })`)
    check(!after2.shadowFocus && after2.active !== "callscribe-overlay", `choosing a language gives focus back to the page (${JSON.stringify(after2)})`)
    await ev(`(() => { window.__sel.focus(); return true })()`)
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId)
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId)
    check(!(await ev(`Boolean(__shadow.activeElement)`)), "Escape on the menu gives focus back to the page")
    const stale = await ev(`(() => { const st = __shadow.querySelector(".st").textContent; return st.includes(String(window.__lines.length)) })()`)
    check(stale, "the status row catches up once the menu is no longer in use")
    await shot("language-meet.png")
  }
  const odd = await ev(`(() => {
    const base = window.__state
    window.__ov.update({ ...base(window.__lines), captionLanguage: { code: "zh-TW", options: base(window.__lines).captionLanguage.options } })
    const s = __shadow.querySelector(".st select")
    return s && { value: s.value, label: s.options[s.selectedIndex] && s.options[s.selectedIndex].textContent }
  })()`)
  check(odd && odd.value === "zh-TW" && odd.label === "zh-TW", `a browser code outside the list is shown, not a blank menu (${JSON.stringify(odd)})`)
  await ev(`(() => {
    const base = window.__state
    window.__state = (ls) => ({ ...base(ls), platform: "slack-huddle", source: "cc", captionLanguage: null, captionHint: "Caption language: change it in Slack's huddle caption settings" })
    window.__ov.update(window.__state(window.__lines))
    return true
  })()`)
  await sleep(100)
  const slack = await ev(`({ select: Boolean(__shadow.querySelector(".st select")), hint: __shadow.querySelector(".st").textContent.includes("Slack's huddle caption settings") })`)
  check(!slack.select && slack.hint, `Slack: a hint, no menu (${JSON.stringify(slack)})`)
  await shot("language-slack.png")
} catch (e) {
  console.log("FAIL", e.stack || e)
  ok = false
} finally {
  proc.kill()
}
fs.writeFileSync(path.join(work, "results.json"), JSON.stringify(results, null, 2))
console.log("results:", path.join(work, "results.json"))
console.log(ok ? "OVERLAY OK" : "OVERLAY FAILED")
process.exit(ok ? 0 : 1)
