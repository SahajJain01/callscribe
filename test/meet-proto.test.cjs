// Google Meet captions_v2 data-channel decoding, against messages captured from real calls.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const P = require("../src/shared/meet-proto.js")
const { UtteranceTracker } = require("../src/shared/merge.js")

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/meet-captions-v2.json"), "utf8"))
const bytes = (m) => new Uint8Array(Buffer.from(m.b64, "base64"))

test("decodes caption updates: utterance id, version, final flag, text, device", () => {
  const caps = fx.subscribed.filter((m) => m.dir === "in").map((m) => P.decodeIncoming(bytes(m))).filter((d) => d && d.kind === "captions")
  assert.ok(caps.length > 40)
  const all = caps.flatMap((c) => c.utterances)
  const first = all[0]
  assert.equal(first.id, "1")
  assert.equal(first.version, 1)
  assert.equal(first.final, false)
  assert.equal(first.text, "Hello!")
  assert.match(first.device, /^spaces\/[^/]+\/devices\/\d+$/)
  const finals = all.filter((u) => u.final).map((u) => u.text)
  assert.deepEqual(finals, [
    "Hello everyone! This is the first test of the caption.",
    "The weather in Hanoi is warm today.",
    "Now, we are checking the second phase. Bananas are yellow, and the sky is blue",
    "over the river.",
  ])
})

test("decodes Meet's own caption on/off requests and the server's replies", () => {
  const out = fx.toggles.filter((m) => m.dir === "out").map((m) => P.decodeOutgoing(bytes(m))).filter((d) => d && d.kind === "language")
  assert.deepEqual(out.map((d) => d.lang), ["en-US", "", "en-US", "", "en-US", "", "en-US", ""])
  assert.deepEqual(out.map((d) => d.seq), [2, 3, 4, 5, 6, 7, 8, 9])
  const replies = fx.toggles.filter((m) => m.dir === "in").map((m) => P.decodeIncoming(bytes(m))).filter((d) => d && d.kind === "reply")
  assert.deepEqual(replies.map((d) => d.seq), [2, 3, 4, 5, 6, 7, 8, 9])
})

test("acks and other control traffic are not mistaken for captions", () => {
  const outs = fx.subscribed.filter((m) => m.dir === "out").map((m) => P.decodeOutgoing(bytes(m)))
  const langs = outs.filter((d) => d && d.kind === "language")
  assert.deepEqual(langs.map((d) => d.seq), [2, 3, 4, 5, 6, 7, 1000]) // Meet's own toggles, then CallScribe's
  assert.ok(outs.filter((d) => d && d.kind === "other").length > 20) // utterance acks
  const ins = fx.toggles.filter((m) => m.dir === "in").map((m) => P.decodeIncoming(bytes(m)))
  assert.ok(ins.every((d) => d === null || ["captions", "reply", "other"].includes(d.kind)))
})

test("subscribe message is byte-identical to Meet's own 'captions on' request", () => {
  const meet = fx.toggles.find((m) => m.dir === "out" && P.decodeOutgoing(bytes(m))?.lang === "en-US")
  const seq = P.decodeOutgoing(bytes(meet)).seq
  assert.deepEqual(P.encodeLanguage(seq, "en-US"), bytes(meet))
  // and the one CallScribe sent in the real test (seq 1000) round-trips
  const ours = fx.subscribed.find((m) => m.dir === "out" && P.decodeOutgoing(bytes(m))?.seq === 1000)
  assert.deepEqual(P.encodeLanguage(1000, "en-US"), bytes(ours))
})

test("finds participant names in collections updates", () => {
  // Shape seen in Meet's collections channel: 1 > 2 > 13 > 1 > 2 > { 1: device id, 2: display name }
  const enc = new TextEncoder()
  const v = (n) => { const o = []; while (n > 127) { o.push((n & 127) | 128); n >>>= 7 } o.push(n); return o }
  const ld = (f, b) => [(f << 3) | 2, ...v(b.length), ...b]
  const dev = ld(1, enc.encode("spaces/abc/devices/42")).concat(ld(2, enc.encode("Emanuel Piza")))
  const msg = ld(1, ld(2, ld(13, ld(1, ld(2, dev)))))
  assert.deepEqual(P.findDeviceNames(new Uint8Array(msg)), [["spaces/abc/devices/42", "Emanuel Piza"]])
  // A caption message carries a device id but no name pair.
  const cap = fx.subscribed.find((m) => m.dir === "in" && P.decodeIncoming(bytes(m))?.kind === "captions")
  assert.deepEqual(P.findDeviceNames(bytes(cap)), [])
})

test("malformed input returns null instead of throwing", () => {
  assert.equal(P.decodeIncoming(new Uint8Array([0xff, 0xff, 0xff])), null)
  assert.equal(P.decodeOutgoing(new Uint8Array([])), null)
})

test("UtteranceTracker: latest version wins, one entry per utterance, names resolved late", () => {
  let t = 1000
  const tr = new UtteranceTracker(() => t)
  for (const m of fx.subscribed.filter((m) => m.dir === "in")) {
    const d = P.decodeIncoming(bytes(m))
    if (d && d.kind === "captions") { t = m.t; for (const u of d.utterances) tr.add(u) }
  }
  let s = tr.snapshot()
  assert.equal(s.length, 4)
  assert.equal(s[0].speaker, "Unknown speaker 1")
  assert.equal(s[0].text, "Hello everyone! This is the first test of the caption.")
  assert.equal(s[3].text, "over the river.")
  assert.ok(s.every((e, i) => e.start <= e.end && (i === 0 || e.start >= s[i - 1].start)))
  const device = P.decodeIncoming(bytes(fx.subscribed.find((m) => m.dir === "in" && P.decodeIncoming(bytes(m))?.kind === "captions"))).utterances[0].device
  tr.setName(device, "Sahaj Jain")
  assert.equal(tr.dirty, true)
  s = tr.snapshot()
  assert.ok(s.every((e) => e.speaker === "Sahaj Jain"))
})

test("UtteranceTracker: stale versions and empty text are ignored; restarts get a new entry", () => {
  let t = 0
  const tr = new UtteranceTracker(() => t)
  const u = (id, version, text, final = false, device = "d1", epoch = 0) => ({ id, version, text, final, device, epoch })
  t = 100; tr.add(u("1", 1, "Hello"))
  t = 200; tr.add(u("1", 3, "Hello there"))
  t = 300; tr.add(u("1", 2, "Hello th")) // late, older version
  t = 400; tr.add(u("2", 1, ""))
  t = 500; tr.add(u("1", 1, "Second subscription", false, "d1", 1)) // same id after a resubscribe
  const s = tr.snapshot()
  assert.deepEqual(s.map((e) => [e.text, e.start, e.end]), [["Hello there", 100, 200], ["Second subscription", 500, 500]])
})
