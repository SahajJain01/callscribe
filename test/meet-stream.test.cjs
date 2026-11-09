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

// --- caption language (docs/superpowers/specs/2026-11-10-caption-language-design.md)
function tagged(id, version, text, lang, final) {
  const cap = [...(final ? vi(2, 1) : []), ...ld(3, s(text)), ...(lang ? ld(4, s(lang)) : []), ...ld(6, s(D))]
  return new Uint8Array(ld(1, ld(1, [...vi(1, id), ...vi(2, version), ...ld(3, cap)]))).buffer
}
function withLanguage(initial) {
  let lang = initial
  const got = []
  const sent = []
  const st = meet.createCaptionStream({ toPage: (m) => sent.push(m), onUtterance: (u) => got.push(u.text), onName: () => {}, language: () => lang })
  let t = 0
  const msg = (dir, buf) => st.handle({ type: "dc-msg", label: "captions_v2", dir, t: (t += 100), buf })
  const requests = () => sent.filter((m) => m.type === "dc-send").map((m) => P.decodeOutgoing(new Uint8Array(m.buf)))
  const replyLast = () => msg("in", reply(requests().at(-1).seq))
  st.handle({ type: "dc-open", label: "captions_v2" })
  st.start()
  replyLast()
  return { st, msg, got, requests, replyLast, set: (l) => (lang = l) }
}

test("language: the first request asks for the chosen language", () => {
  const { requests } = withLanguage("vi-VN")
  assert.deepEqual(requests().map((r) => [r.kind, r.lang]), [["language", "vi-VN"]])
})

test("language: Meet's CC asking for another language is answered with ours, once; the same language isn't", () => {
  const { msg, requests, replyLast } = withLanguage("vi-VN")
  msg("out", P.encodeLanguage(4, "en-US").buffer)
  assert.deepEqual(requests().map((r) => r.lang), ["vi-VN", "vi-VN"])
  replyLast()
  msg("out", P.encodeLanguage(5, "vi-VN").buffer)
  msg("in", reply(5))
  assert.equal(requests().length, 2)
})

test("language: wrong-language captions are dropped during the switch; ours and untagged ones are kept after", () => {
  const { msg, got, replyLast } = withLanguage("vi-VN")
  msg("out", P.encodeLanguage(4, "en-US").buffer)
  msg("in", reply(4))
  msg("in", tagged(1, 1, "hello there", "en-US", true))
  msg("in", tagged(2, 1, "xin chào sớm", "vi-VN", true))
  replyLast()
  msg("in", tagged(3, 1, "xin chào", "vi-VN", true))
  msg("in", tagged(4, 1, "no tag", "", true))
  assert.deepEqual(got, ["xin chào sớm", "xin chào", "no tag"])
})

test("language: changing the menu mid-call asks again, once", () => {
  const { st, requests, set } = withLanguage("vi-VN")
  set("ja-JP")
  st.languageChanged()
  st.languageChanged()
  assert.deepEqual(requests().map((r) => r.lang), ["vi-VN", "ja-JP"])
})

test("language: after a menu change, captions still in the old language are dropped until our reply", () => {
  const { st, msg, got, set, replyLast } = withLanguage("vi-VN")
  set("ja-JP")
  st.languageChanged()
  msg("in", tagged(1, 1, "còn tiếng Việt", "vi-VN", true))
  replyLast()
  msg("in", tagged(2, 1, "こんにちは", "ja-JP", true))
  assert.deepEqual(got, ["こんにちは"])
})

test("language: Meet turning CC off is answered in the chosen language", async () => {
  const { msg, requests } = withLanguage("vi-VN")
  msg("out", P.encodeLanguage(6, "").buffer)
  await new Promise((r) => setTimeout(r, 350))
  assert.deepEqual(requests().map((r) => r.lang), ["vi-VN", "vi-VN"])
})

test("language: Meet re-asking repeatedly still respects the retry limit", () => {
  const { msg, requests } = withLanguage("vi-VN")
  for (let i = 0; i < 20; i++) msg("out", P.encodeLanguage(10 + i, "en-US").buffer)
  // one answer per Meet request at most, and never unbounded
  assert.ok(requests().length <= 21, String(requests().length))
})

test("language: a code Meet never answers stops blocking Meet's own captions once retries run out", () => {
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    const { st, msg, got, requests } = withLanguage("vi-VN")
    msg("out", P.encodeLanguage(4, "en-US").buffer) // Meet's CC; our re-request gets no reply
    msg("in", reply(4))
    for (let i = 0; i < 6; i++) {
      now += 6000
      st.tick()
    }
    assert.ok(requests().length <= 7, String(requests().length))
    msg("in", tagged(1, 1, "hello there", "en-US", true))
    assert.deepEqual(got, ["hello there"])
  } finally {
    Date.now = realNow
  }
})
