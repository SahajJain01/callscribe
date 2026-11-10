// Runs src/content/main.js in Node's vm with a fake adapter, chrome.* APIs, overlay and
// private page channel (CallScribe.bridge, normally src/content/bridge.js), plus a fake clock.
const vm = require("node:vm")
const fs = require("node:fs")
const path = require("node:path")

const ROOT = path.join(__dirname, "../..")
const merge = require(path.join(ROOT, "src/shared/merge.js"))
const languages = require(path.join(ROOT, "src/shared/languages.js"))

function createContent(opts = {}) {
  let now = 1_000_000
  let nextTimer = 1
  const timers = new Map()
  const setTimeout = (fn, ms) => { const id = nextTimer++; timers.set(id, { at: now + (ms || 0), fn }); return id }
  const clearTimeout = (id) => { timers.delete(id) }
  const setInterval = (fn, ms) => { const id = nextTimer++; timers.set(id, { at: now + ms, fn, every: ms }); return id }
  function advance(ms) {
    const end = now + ms
    for (;;) {
      let first = null
      for (const [id, t] of timers) if (t.at <= end && (!first || t.at < first[1].at)) first = [id, t]
      if (!first) break
      const [id, t] = first
      now = t.at
      if (t.every) t.at += t.every
      else timers.delete(id)
      t.fn()
    }
    now = end
  }
  const FakeDate = class extends Date {
    constructor(...a) { if (a.length) super(...a); else super(now) }
    static now() { return now }
  }

  // --- the page and the call app
  const state = { inCall: false, muted: opts.muted, title: "Huddle" }
  const micEl = { id: "mic", contains: (t) => t === micEl }
  const adapter = {
    id: "slack-huddle",
    name: "Slack huddle",
    matches: () => true,
    captionContainer: null,
    inCall: () => state.inCall,
    title: () => state.title,
    selfMuted: () => { if (state.mutedThrows) throw new Error("boom"); return state.muted },
    micToggle: () => micEl,
    captionsOn: () => false,
    captionRows: () => [],
    ...(opts.adapter || {}),
  }
  const observers = []
  class MutationObserver {
    constructor(cb) { this.cb = cb; this.targets = []; this.connected = false; observers.push(this) }
    observe(target, o) { this.targets.push({ target, o }); this.connected = true }
    disconnect() { this.connected = false }
    fire(records = []) { if (this.connected) this.cb(records) }
  }
  const doc = new EventTarget()
  // Elements main.js adds to <head> (the hidden-captions style), found again by id.
  const head = new Set()
  const append = (el) => { head.add(el) }
  Object.assign(doc, {
    body: { nodeName: "BODY" }, head: { appendChild: append }, documentElement: { appendChild: append },
    getElementById: (id) => [...head].find((el) => el.id === id) || null,
    createElement: (tag) => { const el = { tagName: tag.toUpperCase(), id: "", textContent: "", remove() { head.delete(el) } }; return el },
    title: "Huddle",
    // state.container: the caption container element, once the page shows captions.
    querySelector: (sel) => (state.container && sel && sel === adapter.captionContainer ? state.container : null),
  })
  const win = new EventTarget()
  win.postMessage = () => { throw new Error("main.js must not use window.postMessage") }

  // --- private channel to the MAIN world
  const toPage = []
  const bridgeListeners = new Set()
  const bridge = {
    send(msg) { toPage.push(JSON.parse(JSON.stringify(msg, (k, v) => (v instanceof ArrayBuffer ? { bytes: v.byteLength } : v)))); return true },
    onMessage(fn) { bridgeListeners.add(fn); return () => bridgeListeners.delete(fn) },
    // opts.pageDead: the MAIN-world scripts never answered (the private channel is dead).
    connected: () => !opts.pageDead,
  }
  const fromPage = (msg) => { for (const fn of [...bridgeListeners]) fn(msg) }

  // --- chrome.*
  const sent = []
  const storageListeners = []
  const store = { settings: { recordAudio: true, includeMic: true, autoCaptions: false, showOverlay: true, ...(opts.settings || {}) } }
  const runtime = {
    id: "extid",
    reply: opts.reply,
    sendMessage(msg) {
      if (runtime.throwSync) throw new Error("Extension context invalidated.")
      sent.push(msg)
      // runtime.reply(msg): what the service worker answers (a value, a promise, or a throw = rejection).
      if (!runtime.reply) return Promise.resolve({ ok: true })
      try {
        return Promise.resolve(runtime.reply(msg))
      } catch (e) {
        return Promise.reject(e)
      }
    },
    onMessage: { addListener() {} },
  }
  const chrome = {
    runtime,
    storage: {
      local: {
        get: async (k) => ({ [k]: store[k] }),
        set: async (o) => {
          const changes = {}
          for (const [k, v] of Object.entries(o)) { changes[k] = { oldValue: store[k], newValue: v }; store[k] = v }
          for (const fn of storageListeners) fn(changes)
        },
      },
      onChanged: { addListener: (fn) => storageListeners.push(fn) },
    },
  }

  // --- overlay
  const overlays = []
  const createOverlay = (o) => {
    const ov = { opts: o, updates: [], removed: false, update(s) { this.updates.push(s) }, remove() { this.removed = true } }
    overlays.push(ov)
    return ov
  }

  const errors = []
  // merge.js is loaded outside the vm, so its default clock would be the real one: use the fake clock.
  const CaptionTracker = class extends merge.CaptionTracker { constructor(n = () => now) { super(n) } }
  const UtteranceTracker = class extends merge.UtteranceTracker { constructor(n = () => now) { super(n) } }
  const CallScribe = { ...merge, ...languages, CaptionTracker, UtteranceTracker, adapters: [adapter], createOverlay, bridge }
  const ctx = {
    window: win, document: doc, location: { href: "https://app.slack.com/client", hostname: "app.slack.com" },
    chrome, CallScribe, MutationObserver, setTimeout, clearTimeout, setInterval, clearInterval: clearTimeout,
    Date: FakeDate, Math, JSON, Promise, Map, Set, WeakMap, Object, Array, ArrayBuffer, Uint8Array, Number, String, Boolean, Error,
    console: { log() {}, debug() {}, warn() {}, error: (...a) => errors.push(a) }, btoa, Event, EventTarget,
    navigator: { language: "en-US", languages: ["en-US"], ...(opts.navigator || {}) },
  }
  ctx.globalThis = ctx
  win.top = win
  ctx.top = win
  ctx.self = win
  vm.createContext(ctx)
  // window.top !== window guard: in the vm, window is `win`.
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/content/main.js"), "utf8"), ctx, { filename: "src/content/main.js" })

  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)) }
  const setSettings = async (patch) => { await chrome.storage.local.set({ settings: { ...store.settings, ...patch } }); await flush() }
  const ofType = (list, type) => list.filter((m) => m.type === type)

  return {
    state, adapter, micEl, doc, head, win, toPage, fromPage, sent, runtime, chrome, overlays, observers, errors, advance, flush, setSettings, ofType,
    get now() { return now },
  }
}

module.exports = { createContent }
