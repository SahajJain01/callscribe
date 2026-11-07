import test from "node:test"
import assert from "node:assert/strict"
import { endTime } from "../src/shared/lifecycle.js"

const start = 1_000_000
const lastUpdate = start + 30 * 60 * 1000 // 30-minute call, last saved at 30:00
const hour = 60 * 60 * 1000

test("a call recovered after a crash ends at its last saved update, however long Chrome was down", () => {
  const s = { startedAt: start, updatedAt: lastUpdate }
  assert.equal(endTime(s, "stale", lastUpdate + 3 * 60 * 1000), lastUpdate)
  assert.equal(endTime(s, "stale", lastUpdate + hour), lastUpdate)
})

test("a stale call with no updates ends at its start", () => {
  assert.equal(endTime({ startedAt: start }, "stale", start + hour), start)
})

test("a call that ends normally ends now", () => {
  const now = lastUpdate + 2000
  assert.equal(endTime({ startedAt: start, updatedAt: lastUpdate }, "left", now), now)
  assert.equal(endTime({ startedAt: start, updatedAt: lastUpdate }, "tab-closed", now), now)
})

test("the end is never before the last update", () => {
  assert.equal(endTime({ startedAt: start, updatedAt: lastUpdate }, "left", lastUpdate - 5000), lastUpdate)
})
