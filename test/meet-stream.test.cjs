// Meet caption stream (google-meet.js createCaptionStream) + UtteranceTracker with hand-encoded
// captions_v2 messages: resubscriptions while our feed is flowing (transcript I4 / M3).
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
  return new Uint8Array(ld(1, ld(1, [...vi(1, id), ...vi(2, version), ...ld(3, cap)]))).buffer
}
const reply = (seq) => new Uint8Array(ld(1, ld(2, [...vi(1, seq), ...ld(3, [])]))).buffer
const D = "spaces/s/devices/1"

function flowing() {
  const tr = new UtteranceTracker(() => 0)
  const sent = []
  const st = meet.createCaptionStream({ toPage: (m) => sent.push(m), onUtterance: (u, t) => tr.add(u, t), onName: () => {} })
  let t = 0
  const msg = (dir, buf) => st.handle({ type: "dc-msg", label: "captions_v2", dir, t: (t += 100), buf })
  st.handle({ type: "dc-open", label: "captions_v2" })
  st.start()
  msg("in", reply(P.decodeOutgoing(new Uint8Array(sent.find((m) => m.type === "dc-send").buf)).seq))
  return { tr, msg }
}

test("I4: ids restarting at the same version after Meet's own CC request don't overwrite the old line", () => {
  const { tr, msg } = flowing()
  msg("in", caption(1, 1, "Good morning", D, true))
  msg("out", P.encodeLanguage(4, "en-US").buffer) // the user pressed CC in Meet
  msg("in", reply(4))
  msg("in", caption(1, 1, "Next topic", D, true)) // the new subscription starts ids again
  assert.deepEqual(tr.snapshot().map((e) => e.text), ["Good morning", "Next topic"])
})

test("M3: if ids continue across that request, the unfinished utterance is not split", () => {
  const { tr, msg } = flowing()
  msg("in", caption(7, 3, "So the plan", D, false))
  msg("out", P.encodeLanguage(4, "en-US").buffer)
  msg("in", reply(4))
  msg("in", caption(7, 4, "So the plan is to ship Friday.", D, true))
  assert.deepEqual(tr.snapshot().map((e) => e.text), ["So the plan is to ship Friday."])
})
