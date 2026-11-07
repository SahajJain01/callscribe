// createCaptionStream (google-meet.js) + UtteranceTracker, with hand-encoded captions_v2 messages.
const test = require("node:test")
const assert = require("node:assert/strict")
const P = require("../src/shared/meet-proto.js")
require("../src/content/adapters/google-meet.js")
const { UtteranceTracker } = require("../src/shared/merge.js")
const meet = globalThis.CallScribe.adapters.find((a) => a.id === "google-meet")

const vb = (n) => { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128) } o.push(n); return o }
const ld = (f, b) => [(f << 3) | 2, ...vb(b.length), ...b]
const vi = (f, n) => [(f << 3) | 0, ...vb(n)]
const s = (x) => [...Buffer.from(x, "utf8")]
function caption(id, version, text, device, final) {
  const cap = [...(final ? vi(2, 1) : []), ...ld(3, s(text)), ...ld(6, s(device))]
  const u = [...vi(1, id), ...vi(2, version), ...ld(3, cap)]
  return new Uint8Array(ld(1, ld(1, u))).buffer
}
const reply = (seq) => new Uint8Array(ld(1, ld(2, [...vi(1, seq), ...ld(3, [])]))).buffer

function setup() {
  const tr = new UtteranceTracker(() => 0)
  const sent = []
  const st = meet.createCaptionStream({ toPage: (m) => sent.push(m), onUtterance: (u, t) => tr.add(u, t), onName: () => {} })
  let t = 0
  const msg = (dir, buf) => st.handle({ type: "dc-msg", label: "captions_v2", dir, t: (t += 100), buf })
  return { tr, st, sent, msg }
}
const D = "spaces/s/devices/1"

test("S1 sanity: decoder round-trips hand-encoded caption", () => {
  const d = P.decodeIncoming(new Uint8Array(caption(3, 2, "hi there", D, true)))
  assert.deepEqual(d.utterances[0], { id: "3", version: 2, final: true, text: "hi there", lang: "", device: D })
})

test("S2 if ids restart after Meet's own CC-on request while our feed flows, new speech is kept", () => {
  const { tr, st, sent, msg } = setup()
  st.handle({ type: "dc-open", label: "captions_v2" })
  st.start()
  const ourSeq = P.decodeOutgoing(new Uint8Array(sent.find((m) => m.type === "dc-send").buf)).seq
  msg("in", reply(ourSeq)) // flowing
  for (let v = 1; v <= 8; v++) msg("in", caption(1, v, "first utterance words ".repeat(1) + v, D, v === 8))
  // user presses CC in Meet: Meet sends its own language request (small seq)
  msg("out", P.encodeLanguage(4, "en-US").buffer)
  msg("in", reply(4))
  // server (per the code's own assumption) restarts utterance ids for the new subscription
  for (let v = 1; v <= 3; v++) msg("in", caption(1, v, "second utterance " + v, D, v === 3))
  const texts = tr.snapshot().map((e) => e.text)
  assert.ok(texts.some((x) => /second utterance/.test(x)), JSON.stringify(texts))
  assert.ok(texts.some((x) => /first utterance/.test(x)), JSON.stringify(texts))
})
