// Render store assets (icons, screenshots, promo tile) from HTML with headless Chromium.
// node store/render.mjs
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const out = path.join(root, "store/out")
fs.mkdirSync(out, { recursive: true })
const chrome = process.env.CHROME || path.join(os.homedir(), ".hermes/tools/chromium-1208/chrome-linux64/chrome")
const prof = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "render-"))
const proc = spawn(chrome, ["--headless=new", `--user-data-dir=${prof}`, "--no-first-run", "--hide-scrollbars", "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] })
const wsUrl = await new Promise((res, rej) => { let b = ""; proc.stderr.on("data", (d) => { b += d; const m = b.match(/DevTools listening on (ws:\S+)/); if (m) res(m[1]) }); setTimeout(() => rej(new Error(b)), 20000) })
const ws = new WebSocket(wsUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0; const pending = new Map()
const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })) })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank" })
const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true })

async function render(file, html, w, h, opts = {}) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId)
  if (opts.transparent) await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId)
  else await send("Emulation.setDefaultBackgroundColorOverride", {}, sessionId)
  const f = path.join(out, "_page.html")
  fs.writeFileSync(f, html)
  await send("Page.navigate", { url: "file://" + f }, sessionId)
  await sleep(700)
  const r = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: w, height: h, scale: 1 } }, sessionId)
  fs.writeFileSync(file, Buffer.from(r.result.data, "base64"))
  console.log("wrote", path.relative(root, file))
}

const svg = fs.readFileSync(path.join(root, "store/icon.svg"), "utf8")
const svgUrl = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64")
for (const s of [16, 32, 48, 128])
  await render(path.join(root, `icons/${s}.png`), `<body style="margin:0"><img src="${svgUrl}" width="${s}" height="${s}" style="display:block">`, s, s, { transparent: true })

const css = fs.readFileSync(path.join(root, "store/shots.css"), "utf8")
for (const name of ["shot1", "shot2", "promo-small", "promo-marquee"]) {
  const body = fs.readFileSync(path.join(root, `store/${name}.html`), "utf8").replaceAll("{{ICON}}", svgUrl)
  const [w, h] = name === "promo-small" ? [440, 280] : name === "promo-marquee" ? [1400, 560] : [1280, 800]
  await render(path.join(out, `${name}.png`), `<!doctype html><meta charset="utf-8"><style>${css}</style>${body}`, w, h)
}
fs.rmSync(path.join(out, "_page.html"))
proc.kill()
process.exit(0)
