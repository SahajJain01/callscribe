import { clock } from "../shared/format.js"

const $ = (s) => document.querySelector(s)
const ask = (msg) => chrome.runtime.sendMessage(msg)
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB")
const PAGE = 50

$("#ver").textContent = "v" + chrome.runtime.getManifest().version

async function current() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  let st = null
  try { st = await chrome.tabs.sendMessage(tab.id, { type: "tab-status" }) } catch {}
  const box = $("#now")
  if (!st) {
    box.innerHTML = `<span class="muted">Open a Google Meet call or a Slack huddle (app.slack.com) in this tab.</span>`
    return
  }
  if (!st.session) {
    box.innerHTML = `<div class="live"><span class="dot"></span><b>${esc(st.platform)}</b><span class="muted">waiting for a call</span></div>`
    return
  }
  const { session } = await ask({ type: "get", id: st.session.id })
  const mins = clock(Date.now() - st.session.startedAt)
  const audio = session && session.audio && session.audio.bytes ? `audio ${kb(session.audio.bytes)}` : "no audio yet"
  box.innerHTML = `<div class="live"><span class="dot on"></span><b>Recording ${esc(st.platform)}</b><span class="muted">${mins}</span></div>
    <div class="muted">${st.session.lines} caption lines · ${audio}</div>
    ${st.captionsOn ? "" : `<div class="warn">Captions are off. ${esc(st.hint || "")}</div>`}`
}

const day = (t) => new Date(t).toLocaleDateString([], { month: "short", day: "numeric" })

// Where the call's files stand: saved (and when the browser copy goes), saving, failed, or manual.
function status(s) {
  if (!s.endedAt) return { text: "" }
  switch (s.exportState) {
    case "done": return { text: `<div class="muted">Saved to Downloads · kept here until ${day(s.deleteAt)}</div>` }
    case "pending":
    case "running": return { text: `<div class="muted">Saving to Downloads…${s.exportErrors && s.exportErrors.length ? " (retrying: " + esc(s.exportErrors.join("; ")) + ")" : ""}</div>` }
    case "failed": return { text: `<div class="warn">Not saved: ${esc((s.exportErrors || []).join("; "))}</div>`, retry: "Save again" }
    case "off": return { text: `<div class="muted">Not saved automatically (kept here until you delete it)</div>`, retry: "Save to Downloads" }
    default: return { text: s.exportErrors && s.exportErrors.length ? `<div class="warn">${esc(s.exportErrors.join("; "))}</div>` : "" }
  }
}

let shown = 0
function item(s) {
  const when = new Date(s.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  const dur = clock((s.endedAt || Date.now()) - s.startedAt)
  const live = s.endedAt ? "" : " · <b>live</b>"
  const st = status(s)
  return `<li data-id="${esc(s.id)}" data-live="${s.endedAt ? "" : "1"}">
    <div class="t">${esc(s.title || s.platformName)}</div>
    <div class="muted">${esc(s.platformName)} · ${when} · ${dur} · ${s.lines} lines${s.audioBytes ? " · " + kb(s.audioBytes) : ""}${live}</div>
    <div class="row">
      <button data-a="export-transcript">Transcript</button>
      ${s.audioBytes ? `<button data-a="export-audio">Audio</button>` : ""}
      ${st.retry ? `<button data-a="export">${st.retry}</button>` : ""}
      <button data-a="delete" class="del">Delete</button>
    </div>${st.text}
  </li>`
}

// Every stored call is reachable: pages of 50, "Show more" for the next page.
async function list(count = PAGE) {
  const r = await ask({ type: "list", offset: 0, limit: Math.max(PAGE, count) })
  render(r, false)
}
async function more() {
  const r = await ask({ type: "list", offset: shown, limit: PAGE })
  render(r, true)
}
function render({ sessions = [], total = 0, error } = {}, append) {
  const ul = $("#list")
  const empty = $("#empty")
  if (error) {
    empty.hidden = false
    empty.textContent = error
    return
  }
  if (!append) ul.innerHTML = ""
  ul.insertAdjacentHTML("beforeend", sessions.map(item).join(""))
  shown = ul.querySelectorAll("li[data-id]").length
  empty.hidden = total > 0
  $("#count").textContent = total ? `${total} stored` : ""
  const btn = $("#more")
  btn.hidden = shown >= total
  btn.textContent = `Show more (${total - shown} older)`
}

$("#more").addEventListener("click", (ev) => {
  ev.stopImmediatePropagation()
  more()
})
document.addEventListener("click", onClick)
async function onClick(ev) {
  const b = ev.target.closest("button[data-a]")
  if (!b || b.dataset.busy) return
  ev.stopImmediatePropagation()
  const li = b.closest("li")
  const id = li.dataset.id
  if (b.dataset.a === "delete") {
    const q = li.dataset.live ? "This call is still being recorded. Delete it and stop saving it?" : "Delete this call's transcript and audio from the browser? Files already in Downloads stay."
    if (!confirm(q)) return
  }
  b.dataset.busy = "1"
  const r = await ask({ type: b.dataset.a, id })
  delete b.dataset.busy
  if (r && r.error) alert(r.error)
  list(shown)
}

async function settingsUi() {
  const { settings = {} } = await chrome.storage.local.get("settings")
  for (const box of document.querySelectorAll("input[data-k]")) {
    box.checked = settings[box.dataset.k] !== false
    box.addEventListener("change", async () => {
      const cur = (await chrome.storage.local.get("settings")).settings || {}
      cur[box.dataset.k] = box.checked
      await chrome.storage.local.set({ settings: cur })
    })
  }
}

current()
list()
settingsUi()
setInterval(current, 2000)
