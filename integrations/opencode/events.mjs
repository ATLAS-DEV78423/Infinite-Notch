import { posix, win32 } from "node:path"

const AGENT = "opencode"
const SESSION_CAP = 16
const LOOKUP_CAP = 256
const TYPES = new Set([
  "session.created", "session.deleted", "session.inbox.enqueued", "session.tool.input.started",
  "session.tool.called", "session.tool.success", "session.tool.failed",
  "session.execution.succeeded", "session.execution.failed", "session.moved",
])

function bounded(value, limit) {
  return typeof value === "string" && value.length > 0 && value.length <= limit
    && Buffer.byteLength(value, "utf8") <= limit && !/[\p{Cc}\p{Cs}]/u.test(value)
}

function opaque(value) {
  return bounded(value, 256) ? value : undefined
}

function directory(value) {
  return bounded(value, 1024) && (posix.isAbsolute(value) || win32.isAbsolute(value)) ? value : undefined
}

function payload(eventName, data, fields = {}) {
  return {
    hook_event_name: eventName,
    coucou_agent: AGENT,
    session_id: data.sessionId,
    ...(data.cwd === undefined ? {} : { cwd: data.cwd }),
    ...fields,
  }
}

/** The session's own reported location; the plugin's registration directory is never a cwd source. */
function sessionDirectory(event, info) {
  return directory(info?.location?.directory) ?? directory(event.location?.directory)
}

/** OpenCode 2.0.6 baseline; each session remembers only the directory it reported itself. */
export function toCoucouEvents(event, monitorState) {
  const type = event?.type
  if (!TYPES.has(type)) return []
  const info = event.data
  const sessionId = opaque(info?.sessionID)
  const eventId = opaque(event.id)
  if (sessionId === undefined || eventId === undefined) return []
  const reported = sessionDirectory(event, info)
  let session = monitorState.sessions.get(sessionId)

  // ponytail: a move is the one silence that clears the directory; no scope or process fallback exists.
  if (type === "session.moved") {
    if (!session) return []
    session.directory = reported
    return []
  }
  const cwd = reported ?? session?.directory
  if (session !== undefined && reported !== undefined) session.directory = reported
  const data = { sessionId, cwd }

  if (type === "session.deleted") {
    if (!session) return []
    monitorState.sessions.delete(sessionId)
    for (const [key, owner] of monitorState.seen) if (owner === sessionId) monitorState.seen.delete(key)
    for (const [key, call] of monitorState.calls) if (call.sessionId === sessionId) monitorState.calls.delete(key)
    return [payload("SessionEnd", data)]
  }
  if (!session && (cwd === undefined || monitorState.sessions.size >= SESSION_CAP)) return []
  if (session?.failed && type !== "session.inbox.enqueued" && type !== "session.execution.failed") return []

  const eventKey = JSON.stringify(["event", sessionId, eventId])
  let inboxKey
  if (type === "session.inbox.enqueued") {
    const inboxId = opaque(info.inboxID)
    if (inboxId === undefined || info.item?.type !== "user") return []
    inboxKey = JSON.stringify(["inbox", sessionId, inboxId])
  }
  let callKey
  if (type.startsWith("session.tool.")) {
    const callId = opaque(info.id)
    if (callId === undefined) return []
    callKey = JSON.stringify([sessionId, callId])
  }
  let call = callKey === undefined ? undefined : monitorState.calls.get(callKey)
  if (monitorState.seen.has(eventKey) || (inboxKey !== undefined && monitorState.seen.has(inboxKey))) return []
  // ponytail: retain guards until deletion/unload; pressure drops new observations instead of evicting protection.
  if (monitorState.seen.size + (inboxKey === undefined ? 1 : 2) > LOOKUP_CAP
    || (callKey !== undefined && !call && monitorState.calls.size >= LOOKUP_CAP)) return []
  if (!session) {
    session = { failed: false, directory: cwd }
    monitorState.sessions.set(sessionId, session)
  }
  monitorState.seen.set(eventKey, sessionId)
  if (inboxKey !== undefined) monitorState.seen.set(inboxKey, sessionId)
  if (callKey !== undefined && !call) {
    call = { sessionId, called: false, ended: false }
    monitorState.calls.set(callKey, call)
  }

  switch (type) {
    case "session.created":
      return [payload("SessionStart", data)]

    case "session.inbox.enqueued":
      session.failed = false
      return [payload("UserPromptSubmit", data)]

    case "session.execution.succeeded":
      return [payload("Stop", data)]

    case "session.execution.failed":
      session.failed = true
      return [payload("StopFailure", data)]

    case "session.tool.input.started": {
      if (call.called || call.ended || call.toolName !== undefined) return []
      const name = info.name
      if (bounded(name, 256) && /^[\p{L}\p{N}_.:-]+$/u.test(name)) call.toolName = name
      return []
    }

    case "session.tool.called":
    case "session.tool.success":
    case "session.tool.failed": {
      const fields = call.toolName === undefined ? {} : { tool_name: call.toolName }
      if (type === "session.tool.called") {
        if (call.called || call.ended) return []
        call.called = true
        return [payload("PreToolUse", data, fields)]
      }
      if (call.ended) return []
      call.ended = true
      return [payload(type === "session.tool.success" ? "PostToolUse" : "PostToolUseFailure", data, fields)]
    }

    default:
      return []
  }
}
