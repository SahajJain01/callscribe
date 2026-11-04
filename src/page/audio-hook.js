// Runs in the page's own JS world at document_start, before the call app loads.
// Collects the call's audio tracks (remote WebRTC tracks + your microphone) without
// changing what the app sends or plays, and records a mix of them on request.
// Talks to the extension's content script with window.postMessage.
;(function () {
  "use strict"
  if (window.__callscribeAudioHook) return
  window.__callscribeAudioHook = true

  const TAG = "__callscribe"
  const remote = new Set()
  const mic = new Set()
  const peers = new Set()
  let rec = null // { ctx, dest, recorder, sources: Map<track, node>, includeMic, seq, id }

  const post = (msg, transfer) => window.postMessage({ [TAG]: "page", ...msg }, location.origin, transfer || [])

  function attach(track) {
    if (!rec || rec.sources.has(track) || track.readyState === "ended") return
    if (mic.has(track) && !rec.includeMic) return
    try {
      const node = rec.ctx.createMediaStreamSource(new MediaStream([track]))
      node.connect(rec.dest)
      rec.sources.set(track, node)
      track.addEventListener("ended", () => detach(track), { once: true })
    } catch (e) {
      post({ type: "log", message: "attach failed: " + e.message })
    }
  }

  function detach(track) {
    const node = rec && rec.sources.get(track)
    if (node) {
      try { node.disconnect() } catch {}
      rec.sources.delete(track)
    }
  }

  function addTrack(track, set) {
    if (!track || track.kind !== "audio" || set.has(track)) return
    set.add(track)
    track.addEventListener("ended", () => set.delete(track), { once: true })
    attach(track)
  }

  // --- capture remote tracks from every peer connection the app creates
  const NativePC = window.RTCPeerConnection
  if (NativePC) {
    const watch = (pc) => {
      peers.add(pc)
      pc.addEventListener("track", (ev) => addTrack(ev.track, remote))
      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "closed") peers.delete(pc)
      })
    }
    const Wrapped = new Proxy(NativePC, {
      construct(target, args, newTarget) {
        const pc = Reflect.construct(target, args, newTarget)
        try { watch(pc) } catch {}
        return pc
      },
    })
    window.RTCPeerConnection = Wrapped
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Wrapped
  }

  // --- capture the microphone the app opens
  const md = navigator.mediaDevices
  if (md && md.getUserMedia) {
    const nativeGUM = md.getUserMedia.bind(md)
    md.getUserMedia = async function (constraints) {
      const stream = await nativeGUM(constraints)
      try { stream.getAudioTracks().forEach((t) => addTrack(t, mic)) } catch {}
      return stream
    }
  }

  function sweepPeers() {
    for (const pc of peers) {
      try {
        for (const r of pc.getReceivers()) if (r.track && r.track.readyState === "live") addTrack(r.track, remote)
      } catch {}
    }
  }

  async function start(id, includeMic) {
    if (rec) return
    const ctx = new AudioContext({ sampleRate: 48000 })
    const dest = ctx.createMediaStreamDestination()
    // A silent constant keeps the recording continuous even before anyone speaks.
    const keepAlive = ctx.createConstantSource()
    keepAlive.offset.value = 0
    keepAlive.connect(dest)
    keepAlive.start()
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((m) => MediaRecorder.isTypeSupported(m))
    const recorder = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 48000 })
    const state = { ctx, dest, recorder, sources: new Map(), includeMic, seq: 0, id, mime }
    rec = state
    sweepPeers()
    remote.forEach(attach)
    mic.forEach(attach)
    let queue = Promise.resolve() // keeps chunks in order and 'stopped' after the last one
    recorder.ondataavailable = (ev) => {
      if (!ev.data || !ev.data.size) return
      const seq = state.seq++
      const blob = ev.data
      queue = queue.then(async () => {
        const buf = await blob.arrayBuffer()
        post({ type: "chunk", id, seq, mime, buf }, [buf])
      })
    }
    recorder.onstop = () => { queue = queue.then(() => post({ type: "stopped", id })) }
    recorder.start(5000)
    if (ctx.state !== "running") {
      ctx.resume().catch(() => {})
      const kick = () => ctx.resume().then(() => {
        if (ctx.state === "running") {
          document.removeEventListener("pointerdown", kick, true)
          document.removeEventListener("keydown", kick, true)
        }
      })
      document.addEventListener("pointerdown", kick, true)
      document.addEventListener("keydown", kick, true)
    }
    post({ type: "started", id, mime, remote: remote.size, mic: mic.size, state: ctx.state })
  }

  function stop() {
    if (!rec) return
    const r = rec
    rec = null
    try { if (r.recorder.state !== "inactive") r.recorder.stop() } catch {}
    // Let the final dataavailable fire before closing the graph.
    setTimeout(() => {
      r.sources.forEach((n) => { try { n.disconnect() } catch {} })
      r.ctx.close().catch(() => {})
    }, 1000)
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || ev.data[TAG] !== "ext") return
    const m = ev.data
    if (m.type === "start") start(m.id, m.includeMic !== false).catch((e) => post({ type: "error", id: m.id, message: String(e && e.message || e) }))
    else if (m.type === "stop") stop()
    else if (m.type === "status") post({ type: "status", recording: Boolean(rec), remote: remote.size, mic: mic.size, sources: rec ? rec.sources.size : 0, state: rec ? rec.ctx.state : null })
  })
  // Recording tracks that appear mid-call (new participants, mic switches).
  setInterval(() => { if (rec) { sweepPeers(); remote.forEach(attach); mic.forEach(attach) } }, 3000)
})()
