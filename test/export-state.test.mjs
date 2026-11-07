// The capture -> export state machine (src/shared/lifecycle.js): when a call ends, who may
// export it, what a download's state means, retries, retention, and which messages and chunks
// the service worker accepts. Lifecycle F2 F3 F4 F5 F6 F9 M1 M4 M5, security I2 I4 M5.
import test from "node:test"
import assert from "node:assert/strict"
import * as L from "../src/shared/lifecycle.js"

const start = 1_000_000_000
const min = 60 * 1000
const day = 24 * 60 * min
const live = (o = {}) => ({ id: "slack-huddle-lx1-ab3cd", startedAt: start, updatedAt: start + 10 * min, tabId: 7, audio: { chunks: 2, bytes: 60000 }, ...o })
const ended = (o = {}, ex = {}) => {
  const s = live(o)
  L.markEnded(s, { reason: "left", at: start + 10 * min, now: start + 10 * min, autoDownload: true, folder: "CallScribe", base: "b" })
  Object.assign(s.export, ex)
  return s
}

// ---- end times (M1, backwards clock)
test("a normal leave ends at the leave event, not when finalize ran (M1)", () => {
  const s = live()
  const leftAt = start + 10 * min - 500
  assert.equal(L.endTime(s, "left", start + 10 * min + 9000, leftAt), leftAt)
  assert.equal(L.endTime(s, "tab-closed", start + 10 * min + 7000, start + 10 * min), start + 10 * min)
})

test("a backwards clock never gives an end before the start (no negative duration)", () => {
  const s = { startedAt: start }
  assert.ok(L.endTime(s, "left", start - 5 * min) >= start)
  assert.ok(L.endTime(s, "left", start - 5 * min, start - 6 * min) >= start)
  assert.ok(L.endTime({ startedAt: start, updatedAt: start - min }, "stale", start + min) >= start)
})

test("an event time from the future (bad clock in the tab) is capped at now", () => {
  assert.equal(L.endTime(live(), "left", start + 11 * min, start + 99 * min), start + 11 * min)
})

// ---- marking a call ended
test("ending a call with auto-download on queues one export job and pins its folder and file name", () => {
  const s = live()
  L.markEnded(s, { reason: "left", at: start + 9 * min, now: start + 10 * min, autoDownload: true, folder: "Calls", base: "2026_x_ab3cd" })
  assert.equal(s.endedAt, start + 9 * min)
  assert.equal(s.endReason, "left")
  assert.equal(s.export.state, "pending")
  assert.equal(s.export.folder, "Calls")
  assert.equal(s.export.base, "2026_x_ab3cd")
  assert.equal(s.todo, 1, "an ended call with a pending export is still work for the sweep (F2)")
})

test("ending twice keeps the first end and the first job (concurrent finalizers, F4)", () => {
  const s = live()
  L.markEnded(s, { reason: "left", at: start + 9 * min, now: start + 10 * min, autoDownload: true, folder: "CallScribe", base: "b" })
  s.export.state = "running"
  L.markEnded(s, { reason: "tab-closed", at: start + 12 * min, now: start + 12 * min, autoDownload: true, folder: "CallScribe", base: "b" })
  assert.equal(s.endedAt, start + 9 * min)
  assert.equal(s.endReason, "left")
  assert.equal(s.export.state, "running")
})

test("auto-download off: the call ends with no export job and is not sweep work", () => {
  const s = live()
  L.markEnded(s, { reason: "left", at: start + 9 * min, now: start + 10 * min, autoDownload: false, folder: "CallScribe", base: "b" })
  assert.equal(s.export.state, "off")
  assert.equal(s.todo, undefined)
})

test("a live call is sweep work; a finished export is not", () => {
  assert.equal(L.needsWork(live()), true)
  assert.equal(L.needsWork(ended()), true)
  assert.equal(L.needsWork(ended({}, { state: "done" })), false)
  assert.equal(L.needsWork(ended({}, { state: "failed" })), false)
})

// ---- claims (F4, F2)
test("only one finalizer gets the claim; a second claim by the same worker is refused (F4)", () => {
  const s = ended()
  assert.equal(L.claimExport(s, "w1", start + 11 * min), true)
  assert.equal(s.export.state, "running")
  assert.equal(s.export.attempts, 1)
  assert.equal(L.claimExport(s, "w1", start + 11 * min), false)
})

test("a claim left by a worker that died is taken over and resumed, not restarted (F2)", () => {
  const s = ended()
  L.claimExport(s, "dead-worker", start + 11 * min)
  s.export.files = { audio: { state: "complete", filename: "b.webm", downloadId: 4 } }
  assert.equal(L.claimExport(s, "w2", start + 30 * min), true)
  assert.equal(s.export.owner, "w2")
  assert.equal(s.export.attempts, 1, "resuming is the same attempt")
  assert.equal(s.export.files.audio.state, "complete", "outputs already saved are kept")
})

test("no claim before the retry is due, or once the job is done/failed/off, or before the call ended", () => {
  const s = ended({}, { state: "pending", nextAttemptAt: start + 20 * min, attempts: 1 })
  assert.equal(L.claimExport(s, "w", start + 19 * min), false)
  assert.equal(L.claimExport(s, "w", start + 20 * min), true)
  for (const state of ["done", "failed", "off"]) assert.equal(L.claimExport(ended({}, { state }), "w", start + day), false)
  assert.equal(L.claimExport(live(), "w", start + day), false)
})

// ---- download states (F3)
test("download states: only 'complete' is success; an interruption carries its error (F3)", () => {
  assert.deepEqual(L.downloadOutcome({ id: 1, state: "complete", filename: "/home/u/Downloads/CallScribe/b.md" }), { state: "complete", filename: "b.md" })
  assert.deepEqual(L.downloadOutcome({ id: 1, state: "interrupted", error: "USER_CANCELED", filename: "" }), { state: "interrupted", error: "USER_CANCELED" })
  assert.deepEqual(L.downloadOutcome({ id: 1, state: "in_progress", filename: "x" }), { state: "in_progress" })
  assert.deepEqual(L.downloadOutcome(undefined), { state: "missing" })
  assert.deepEqual(L.downloadOutcome({ id: 1, state: "complete", filename: "C:\\Users\\u\\Downloads\\CallScribe\\b (1).webm" }), { state: "complete", filename: "b (1).webm" })
})

test("outputs: audio first (the transcript names its file), transcript always", () => {
  assert.deepEqual(L.outputsFor(live()), ["audio", "transcript"])
  assert.deepEqual(L.outputsFor(live({ audio: { chunks: 0, bytes: 0 } })), ["transcript"])
  assert.deepEqual(L.outputsFor(live({ audio: undefined })), ["transcript"])
})

test("the transcript names the audio file that was actually written (F9)", () => {
  const s = ended({}, { files: { audio: { state: "complete", filename: "b (1).webm" } } })
  assert.equal(L.transcriptAudioRef(s), "b (1).webm")
  assert.equal(L.transcriptAudioRef(ended({}, { files: { audio: { state: "interrupted", error: "FILE_FAILED" } } })), null)
  assert.equal(L.transcriptAudioRef(ended({ audio: { chunks: 0, bytes: 0 } })), undefined)
})

test("the transcript is not held back by an audio download that failed or was canceled (review I-2)", () => {
  for (const error of ["FILE_FAILED", "USER_CANCELED"]) {
    const s = ended({}, { attempts: 1, files: { audio: { state: "interrupted", error } } })
    assert.equal(L.outputAction(s.export.files.transcript), "start", error)
    assert.equal(L.transcriptAudioRef(s), null, "its header says the audio backup was not saved")
  }
  assert.equal(L.mayWriteTranscript, undefined, "no gate: the transcript is written on the first attempt")
})

// ---- settling an attempt (F3 retry)
test("all outputs complete: export done, retention clock starts, not sweep work", () => {
  const s = ended()
  L.claimExport(s, "w", start + 11 * min)
  s.export.files = { audio: { state: "complete", filename: "b.webm" }, transcript: { state: "complete", filename: "b.md" } }
  L.settleExport(s, start + 12 * min)
  assert.equal(s.export.state, "done")
  assert.equal(s.exportDoneAt, start + 12 * min)
  assert.deepEqual(s.exportErrors, [])
  assert.equal(s.todo, undefined)
})

test("a failed download is recorded as an error and retried later (F3)", () => {
  const s = ended({ audio: { chunks: 0, bytes: 0 } })
  L.claimExport(s, "w", start + 11 * min)
  s.export.files = { transcript: { state: "interrupted", error: "FILE_FAILED", downloadId: 3 } }
  L.settleExport(s, start + 11 * min)
  assert.equal(s.export.state, "pending")
  assert.deepEqual(s.exportErrors, ["transcript: FILE_FAILED"])
  assert.ok(s.export.nextAttemptAt > start + 11 * min)
  assert.equal(s.todo, 1)
  assert.equal(s.export.owner, undefined)
  assert.ok(s.export.log.some((e) => /FILE_FAILED/.test(e.error)))
})

// ---- a download the user canceled (review I-2, controller ruling)
const canceledFile = { state: "interrupted", error: "USER_CANCELED", downloadId: 3 }
test("a canceled download is recorded as canceled and not retried automatically (review I-2a)", () => {
  const s = ended({ audio: { chunks: 0, bytes: 0 } })
  L.claimExport(s, "w", start + 11 * min)
  s.export.files = { transcript: { ...canceledFile } }
  L.settleExport(s, start + 11 * min)
  assert.equal(s.export.state, "canceled")
  assert.deepEqual(s.exportErrors, ["transcript: USER_CANCELED"])
  assert.equal(s.todo, undefined, "not sweep work")
  assert.equal(L.needsWork(s), false)
  assert.equal(L.claimExport(s, "w", start + day), false, "no automatic retry")
  assert.equal(s.exportDoneAt, undefined)
  assert.equal(L.retentionDue(s, start + 365 * day), false, "never deleted by retention")
  assert.equal(L.acceptChunk(s, { tabId: 7, seq: 9, size: 10, mime: "audio/webm", now: start + 12 * min }).fatal, true)
})
test("canceled audio with the transcript saved: canceled, the transcript is kept, the audio is not retried (review I-2)", () => {
  const s = ended()
  L.claimExport(s, "w", start + 11 * min)
  s.export.files = { audio: { ...canceledFile }, transcript: { state: "complete", filename: "b.md" } }
  assert.equal(L.outputAction(s.export.files.audio), "skip")
  L.settleExport(s, start + 11 * min)
  assert.equal(s.export.state, "canceled")
  assert.deepEqual(s.exportErrors, ["audio: USER_CANCELED"])
  assert.equal(L.retentionDue(s, start + 365 * day), false)
})
test("canceled audio and a transcript that failed: the transcript alone is retried (review I-2)", () => {
  const s = ended()
  L.claimExport(s, "w", start + 11 * min)
  s.export.files = { audio: { ...canceledFile }, transcript: { state: "interrupted", error: "FILE_FAILED" } }
  L.settleExport(s, start + 11 * min)
  assert.equal(s.export.state, "pending")
  assert.equal(L.claimExport(s, "w", s.export.nextAttemptAt), true)
  assert.equal(L.outputAction(s.export.files.audio), "skip")
  assert.equal(L.outputAction(s.export.files.transcript), "start")
  s.export.files.transcript = { state: "complete", filename: "b.md" }
  L.settleExport(s, s.export.nextAttemptAt + 1)
  assert.equal(s.export.state, "canceled")
})

test("after the last attempt the job is failed (kept, shown, not retried)", () => {
  const s = ended({ audio: { chunks: 0, bytes: 0 } })
  let now = start + 11 * min
  for (let i = 0; i < L.MAX_ATTEMPTS; i++) {
    assert.equal(L.claimExport(s, "w", now), true, "attempt " + (i + 1))
    s.export.files = { transcript: { state: "interrupted", error: "FILE_FAILED" } }
    L.settleExport(s, now)
    now = (s.export.nextAttemptAt || now) + 1
  }
  assert.equal(s.export.state, "failed")
  assert.equal(L.claimExport(s, "w", now + day), false)
  assert.equal(L.needsWork(s), false)
})

test("a manual retry restarts a failed job from scratch", () => {
  const s = ended({}, { state: "failed", attempts: 5, files: { transcript: { state: "interrupted", error: "X" } } })
  L.resetExport(s, { folder: "CallScribe", base: "b" })
  assert.equal(s.export.state, "pending")
  assert.equal(s.export.attempts, 0)
  assert.equal(L.claimExport(s, "w", start + day), true)
})

test("an interrupted output is started again on the next attempt; a complete one is not", () => {
  assert.equal(L.outputAction({ state: "complete", filename: "b.md" }), "keep")
  assert.equal(L.outputAction({ state: "interrupted", error: "X", downloadId: 2 }), "start")
  assert.equal(L.outputAction(undefined), "start")
  assert.equal(L.outputAction({ state: "in_progress", downloadId: 2 }), "check")
  assert.equal(L.outputAction({ state: "starting" }), "find", "a download may have started just before the worker died")
})

// ---- retention (user decision)
test("retention: deleted 30 days after a confirmed export; never-exported and auto-download-off calls are kept", () => {
  const done = ended({}, { state: "done" })
  done.exportDoneAt = start
  assert.equal(L.retentionDue(done, start + 30 * day - 1), false)
  assert.equal(L.retentionDue(done, start + 30 * day), true)
  assert.equal(L.retentionDue(ended({}, { state: "failed" }), start + 365 * day), false)
  assert.equal(L.retentionDue(ended({}, { state: "off" }), start + 365 * day), false)
  assert.equal(L.retentionDue(live({ startedAt: start - 365 * day }), start), false)
  assert.equal(L.retentionDue({ id: "legacy", startedAt: start, endedAt: start, exported: start, exportErrors: [] }, start + 365 * day), false,
    "a legacy 'exported' flag is not a confirmed download")
})

// ---- stale decision and probes (M4)
test("stale: a live tab keeps the call; a missing tab ends it now; an unanswering tab after the stale window", () => {
  const s = live()
  const now = s.updatedAt + 30 * 1000
  assert.equal(L.isStale(s, { alive: true, tabExists: true, now: now + day }), false)
  assert.equal(L.isStale(s, { alive: false, tabExists: false, now }), true)
  assert.equal(L.isStale(s, { alive: false, tabExists: true, now }), false)
  assert.equal(L.isStale(s, { alive: false, tabExists: true, now: s.updatedAt + L.STALE_MS + 1 }), true)
  assert.equal(L.isStale(ended(), { alive: false, tabExists: false, now }), false)
})

test("a probe that never answers resolves to its fallback after the timeout (M4)", async () => {
  const t0 = Date.now()
  const v = await L.withTimeout(new Promise(() => {}), 50, "fallback")
  assert.equal(v, "fallback")
  assert.ok(Date.now() - t0 < 1000)
  assert.equal(await L.withTimeout(Promise.resolve(1), 50, 0), 1)
  assert.equal(await L.withTimeout(Promise.reject(new Error("x")), 50, 0), 0)
})

test("single flight: overlapping runs share one execution (sweeps, M4; finalizers, F4)", async () => {
  let runs = 0
  const once = L.singleFlight(async () => { runs++; await new Promise((r) => setTimeout(r, 20)) })
  await Promise.all([once(), once(), once()])
  assert.equal(runs, 1)
  await once()
  assert.equal(runs, 2)
  const byKey = L.singleFlight(async (k) => { runs++; await new Promise((r) => setTimeout(r, 5)); return k })
  runs = 0
  assert.deepEqual(await Promise.all([byKey("a"), byKey("a"), byKey("b")]), ["a", "a", "b"])
  assert.equal(runs, 2)
})

// ---- chunk acceptance (M5, security I2, F5)
const chunk = (o = {}) => ({ tabId: 7, seq: 0, size: 30000, mime: "audio/webm;codecs=opus", now: start + 5 * min, ...o })
test("chunks are accepted for this tab's live session", () => {
  assert.deepEqual(L.acceptChunk(live(), chunk()), { ok: true })
})
test("chunks for unknown or deleted sessions are refused for good (M5, I2)", () => {
  assert.equal(L.acceptChunk(undefined, chunk()).fatal, true)
  assert.equal(L.acceptChunk(undefined, chunk(), { tombstone: true }).fatal, true)
})
test("chunks from another tab are refused (security M5)", () => {
  assert.equal(L.acceptChunk(live(), chunk({ tabId: 8 })).fatal, true)
})
test("a late chunk is still taken after the call ended, until its audio export starts (F5)", () => {
  assert.deepEqual(L.acceptChunk(ended(), chunk()), { ok: true })
  assert.deepEqual(L.acceptChunk(ended({}, { state: "off" }), chunk()), { ok: true })
  for (const state of ["running", "done", "failed"]) assert.equal(L.acceptChunk(ended({}, { state }), chunk()).fatal, true, state)
})
test("chunk shape: size, sequence and MIME type are checked (I2)", () => {
  assert.equal(L.acceptChunk(live(), chunk({ size: 0 })).fatal, true)
  assert.equal(L.acceptChunk(live(), chunk({ size: L.MAX_CHUNK_BYTES + 1 })).fatal, true)
  assert.equal(L.acceptChunk(live(), chunk({ seq: -1 })).fatal, true)
  assert.equal(L.acceptChunk(live(), chunk({ seq: 1.5 })).fatal, true)
  assert.equal(L.acceptChunk(live(), chunk({ mime: "text/html" })).fatal, true)
  assert.deepEqual(L.acceptChunk(live(), chunk({ mime: "audio/ogg;codecs=opus" })), { ok: true })
})
test("a session can't store far more audio than its length allows (disk fill, I2)", () => {
  const s = live({ audio: { chunks: 100, bytes: 50 * 1024 * 1024 } })
  assert.equal(L.acceptChunk(s, chunk({ now: start + 60 * 1000 })).fatal, true)
  const real = live({ audio: { chunks: 720, bytes: 22 * 1024 * 1024 } }) // 1 h at 48 kbps
  assert.deepEqual(L.acceptChunk(real, chunk({ now: start + 60 * min })), { ok: true })
})

// ---- who may send what (security M5)
const EXT = "abcdefghijklmnop"
const ORIGIN = `chrome-extension://${EXT}/`
test("library operations only from the extension's popup page", () => {
  assert.equal(L.isLibrarySender({ id: EXT, url: ORIGIN + "src/popup/popup.html" }, EXT, ORIGIN), true)
  assert.equal(L.isLibrarySender({ id: EXT, url: ORIGIN + "src/popup/popup.html", tab: { id: 3, url: ORIGIN + "src/popup/popup.html" } }, EXT, ORIGIN), true,
    "the popup opened in a tab is still the popup")
  assert.equal(L.isLibrarySender({ id: EXT, url: "https://meet.google.com/abc", tab: { id: 3 } }, EXT, ORIGIN), false)
  assert.equal(L.isLibrarySender({ id: EXT, url: ORIGIN + "src/offscreen/offscreen.html" }, EXT, ORIGIN), false)
  assert.equal(L.isLibrarySender({ id: "other", url: ORIGIN + "src/popup/popup.html" }, EXT, ORIGIN), false)
  assert.equal(L.isLibrarySender({ id: EXT }, EXT, ORIGIN), false)
})
test("session messages are bound to the tab that started the session", () => {
  assert.equal(L.ownsSession(live(), { tab: { id: 7 } }), true)
  assert.equal(L.ownsSession(live(), { tab: { id: 8 } }), false)
  assert.equal(L.ownsSession(live(), {}), false)
  assert.equal(L.ownsSession(undefined, { tab: { id: 7 } }), false)
})

// ---- file names (F9)
test("file names carry a short session id so two calls never share a name (F9)", () => {
  assert.equal(L.shortId("slack-huddle-lx1abc-ab3cd"), "ab3cd")
  assert.equal(L.shortId("google-meet-m0-Z_9/x"), "z9x")
  assert.notEqual(L.exportBase("2026-11-04_1605_Slack-huddle_design", "slack-huddle-a-aaaaa"), L.exportBase("2026-11-04_1605_Slack-huddle_design", "slack-huddle-a-bbbbb"))
  assert.equal(L.exportBase("2026-11-04_1605_Slack-huddle_design", "slack-huddle-a-ab3cd"), "2026-11-04_1605_Slack-huddle_design_ab3cd")
})

// ---- calls stored by the previous version (DB v1, review I-1)
const v1 = (o = {}) => ({ id: "slack-huddle-old-v1aa", platform: "slack-huddle", platformName: "Slack huddle", title: "old", startedAt: start, updatedAt: start + min, utterances: [], audio: { chunks: 0, bytes: 0 }, ...o })
test("v1 upgrade: an ended call the old version never exported becomes export work (review I-1)", () => {
  const s = L.migrateV1Row(v1({ endedAt: start + min, exportErrors: [] }))
  assert.equal(s.todo, 1)
  assert.equal(L.needsWork(s), true)
  assert.equal(s.export, undefined, "the job is made by the worker, which knows the settings")
})
test("v1 upgrade: a live call is sweep work; a call the old version exported stays manual-only (review I-1)", () => {
  assert.equal(L.migrateV1Row(v1()).todo, 1)
  const old = L.migrateV1Row(v1({ endedAt: start + min, exported: start + 2 * min, exportErrors: [] }))
  assert.equal(old.todo, undefined)
  assert.equal(L.needsWork(old), false)
  assert.equal(L.adoptLegacy(old, { autoDownload: true, folder: "CallScribe", base: "b" }).export, undefined)
})
test("a never-exported v1 call gets a pending export when auto-download is on (review I-1)", () => {
  const s = L.adoptLegacy(L.migrateV1Row(v1({ endedAt: start + min })), { autoDownload: true, folder: "CallScribe", base: "old_v1aa" })
  assert.equal(s.export.state, "pending")
  assert.equal(s.export.base, "old_v1aa")
  assert.equal(s.todo, 1)
  assert.equal(L.claimExport(s, "w", start + day), true)
})
test("a never-exported v1 call is flagged not saved (Save button) when auto-download is off (review I-1)", () => {
  const s = L.adoptLegacy(L.migrateV1Row(v1({ endedAt: start + min })), { autoDownload: false, folder: "CallScribe", base: "b" })
  assert.equal(s.export.state, "off")
  assert.equal(s.todo, undefined)
  assert.equal(L.needsWork(s), false)
  assert.equal(L.retentionDue(s, start + 365 * day), false)
})
test("adopting a v1 call twice changes nothing the second time", () => {
  const s = L.adoptLegacy(L.migrateV1Row(v1({ endedAt: start + min })), { autoDownload: true, folder: "CallScribe", base: "b" })
  s.export.state = "running"
  L.adoptLegacy(s, { autoDownload: false, folder: "X", base: "y" })
  assert.equal(s.export.state, "running")
  assert.equal(s.export.folder, "CallScribe")
})

// ---- resuming: which download may be adopted (review I-3)
const ME = "abcdefghijklmnop"
const iso = (t) => new Date(t).toISOString()
const startingFile = { state: "starting", name: "CallScribe/b_ab3cd.md", requestedAt: start + 10 * min }
const dl = (o = {}) => ({ id: 9, filename: "/home/u/Downloads/CallScribe/b_ab3cd.md", byExtensionId: ME, state: "complete", startTime: iso(start + 10 * min + 5), ...o })
test("resume adopts the download it asked for, also when Chrome added (n) (F2)", () => {
  assert.equal(L.adoptable(dl(), startingFile, ME), true)
  assert.equal(L.adoptable(dl({ filename: "/d/CallScribe/b_ab3cd (2).md" }), startingFile, ME), true)
  assert.equal(L.adoptable(dl({ state: "in_progress" }), startingFile, ME), true)
})
test("resume never adopts a download started before the export asked for it: a manual mid-call transcript (review I-3)", () => {
  assert.equal(L.adoptable(dl({ startTime: iso(start + 9 * min) }), startingFile, ME), false)
  assert.equal(L.adoptable(dl({ startTime: iso(start + 10 * min - 1) }), startingFile, ME), false)
})
test("resume never adopts another name, another extension's download, an interrupted one, or when the request time is unknown (review I-3)", () => {
  assert.equal(L.adoptable(dl({ filename: "/d/CallScribe/b_ab3cd (manual).md" }), startingFile, ME), false)
  assert.equal(L.adoptable(dl({ filename: "/d/CallScribe/b_ab3cdx.md" }), startingFile, ME), false)
  assert.equal(L.adoptable(dl({ filename: "/d/CallScribe/b_ab3cd.webm" }), startingFile, ME), false)
  assert.equal(L.adoptable(dl({ byExtensionId: "other" }), startingFile, ME), false)
  assert.equal(L.adoptable(dl({ state: "interrupted" }), startingFile, ME), false)
  assert.equal(L.adoptable(dl(), { state: "starting", name: "CallScribe/b_ab3cd.md" }, ME), false)
})

// ---- the start time a tab reports (review M-5)
test("a session's start time from the tab is clamped to the last 24 hours (audio budget, review M-5)", () => {
  const now = start + day
  assert.equal(L.clampStart(0, now), now - day)
  assert.equal(L.clampStart(now + 5 * min, now), now)
  assert.equal(L.clampStart(now - 5 * min, now), now - 5 * min)
  assert.equal(L.clampStart("x", now), now)
})
