// When a session ended. A call that ends normally (left, tab closed) ends now. A stale one
// (Chrome or the tab crashed and nothing said goodbye) ends at its last saved update: we
// can't know how long Chrome was down, and the call can't have outlived its last update by
// much (captions save every few seconds, audio every 5 s).
export function endTime(session, reason, now) {
  const last = session.updatedAt || session.startedAt
  return reason === "stale" ? last : Math.max(last, now)
}
