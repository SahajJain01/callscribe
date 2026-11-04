import { clock } from "../shared/format.js"

const $ = (s) => document.querySelector(s)
const ask = (msg) => chrome.runtime.sendMessage(msg)
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB")

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

async function list() {
  const { sessions = [] } = await ask({ type: "list" })
  const ul = $("#list")
  if (!sessions.length) {
    ul.outerHTML = `<div class="empty muted" id="list">Nothing yet. Calls show up here once they start.</div>`
    return
  }
  ul.innerHTML = sessions
    .map((s) => {
      const when = new Date(s.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      const dur = clock((s.endedAt || Date.now()) - s.startedAt)
      const live = s.endedAt ? "" : " · <b>live</b>"
      const err = s.exportErrors && s.exportErrors.length ? `<div class="warn">${esc(s.exportErrors.join("; "))}</div>` : ""
      return `<li data-id="${esc(s.id)}">
        <div class="t">${esc(s.title || s.platformName)}</div>
        <div class="muted">${esc(s.platformName)} · ${when} · ${dur} · ${s.lines} lines${s.audioBytes ? " · " + kb(s.audioBytes) : ""}${live}</div>
        <div class="row">
          <button data-a="export-transcript">Transcript</button>
          ${s.audioBytes ? `<button data-a="export-audio">Audio</button>` : ""}
          <button data-a="delete" class="del">Delete</button>
        </div>${err}
      </li>`
    })
    .join("")
}

document.addEventListener("click", onClick)
async function onClick(ev) {
  const b = ev.target.closest("button[data-a]")
  if (!b || b.dataset.busy) return
  ev.stopImmediatePropagation()
  const id = b.closest("li").dataset.id
  if (b.dataset.a === "delete" && !confirm("Delete this call's transcript and audio?")) return
  b.dataset.busy = "1"
  const r = await ask({ type: b.dataset.a, id })
  delete b.dataset.busy
  if (r && r.error) alert(r.error)
  list()
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
