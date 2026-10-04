import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { registerHooks } from "node:module"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"

import { toCoucouEvents } from "../integrations/opencode/events.mjs"

function forbidden(object, ...keys) {
  for (const key of keys) Object.defineProperty(object, key, {
    enumerable: true,
    get() { throw new Error(`Forbidden read: ${key}`) },
  })
  return object
}

function state(directory = "/repo") {
  return { directory, sessions: new Map(), seen: new Map(), calls: new Map() }
}

let eventNumber = 0
function native(type, data = { sessionID: "ses1" }, cwd = "/repo") {
  const seq = ++eventNumber
  return {
    id: `evt${seq}`, created: 1, type, ...(cwd === null ? {} : { location: { directory: cwd } }), data,
    durable: { aggregateID: data.sessionID, seq, version: 1 },
  }
}

function prompt(inboxID, sessionID = "ses1", kind = "user") {
  return native("session.inbox.enqueued", { sessionID, inboxID,
    item: forbidden({ type: kind }, "payload", "delivery"),
  })
}

function tool(type, overrides = {}, cwd = "/repo") {
  return native(`session.tool.${type}`, forbidden({
    sessionID: "ses1", assistantMessageID: "assistant1", id: "call1", ...overrides,
  }, "input", "content", "metadata", "error", "text", "executed"), cwd)
}

const base = { coucou_agent: "opencode", session_id: "ses1" }
const located = { ...base, cwd: "/repo" }

test("native V2 data starts a session using only its reported envelope location", () => {
  const monitor = state()
  const event = {
    id: "evt-created", created: 1, type: "session.created", location: { directory: "/repo" },
    data: forbidden({ sessionID: "ses1", location: { directory: "/repo" }, projectID: "project1", slug: "slug1", version: "2.0.6" }, "text", "title"),
    durable: { aggregateID: "ses1", seq: 1, version: 1 },
  }
  assert.deepEqual(toCoucouEvents(event, monitor), [{ hook_event_name: "SessionStart", ...located }])
  assert.deepEqual(toCoucouEvents(event, monitor), [])
})

test("native tool outcomes correlate only bounded IDs and safe names, never raw data", () => {
  const monitor = state()
  for (const [id, type, hook] of [["ok", "success", "PostToolUse"], ["bad", "failed", "PostToolUseFailure"]]) {
    assert.deepEqual(toCoucouEvents(tool("input.started", { id, name: "bash" }), monitor), [])
    const called = tool("called", { id })
    forbidden(called.data, "name", "tool", "command", "path")
    assert.deepEqual(toCoucouEvents(called, monitor), [{ hook_event_name: "PreToolUse", ...located, tool_name: "bash" }])
    assert.deepEqual(toCoucouEvents({ ...called, id: `duplicate-${id}` }, monitor), [])
    const outcome = tool(type, { id })
    assert.deepEqual(toCoucouEvents(outcome, monitor), [{ hook_event_name: hook, ...located, tool_name: "bash" }])
    assert.deepEqual(toCoucouEvents({ ...outcome, id: `duplicate-outcome-${id}` }, monitor), [])
    assert.deepEqual(toCoucouEvents(tool("called", { id }), monitor), [])
    assert.deepEqual(toCoucouEvents(tool(type === "success" ? "failed" : "success", { id }), monitor), [])
  }
  assert.deepEqual(toCoucouEvents(native("session.execution.succeeded"), monitor), [{ hook_event_name: "Stop", ...located }],
    "a tool failure must not invent terminal execution failure")
})

test("only user inbox admission submits a prompt without reading payload or delivery", () => {
  const monitor = state()
  const user = prompt("inbox1")
  assert.deepEqual(toCoucouEvents(user, monitor), [{ hook_event_name: "UserPromptSubmit", ...located }])
  assert.deepEqual(toCoucouEvents(user, monitor), [])
  assert.deepEqual(toCoucouEvents(prompt("inbox1"), monitor), [])
  for (const kind of ["synthetic", "assistant", undefined]) {
    const event = prompt(`ignored-${kind}`, "ses1", kind)
    if (kind === undefined) delete event.data.item.type
    assert.deepEqual(toCoucouEvents(event, monitor), [])
  }
  assert.deepEqual(toCoucouEvents(prompt("inbox2"), monitor), [{ hook_event_name: "UserPromptSubmit", ...located }])
})

test("ignored events return before reading data, location, identity or policy", () => {
  for (const type of ["permission.asked", "permission.replied", "unknown.event", "session.text.delta",
    "session.text.started", "session.text.ended", "session.instructions.updated", "session.renamed",
    "session.execution.started", "session.step.started", "session.tool.input.ended", "session.idle",
    "session.status", "session.error", "message.updated", "message.part.updated", "session.moved", "session.reset"]) {
    assert.deepEqual(toCoucouEvents(forbidden({ type }, "data", "properties", "location", "id"), state()), [])
  }
})

test("native execution outcomes read no errors or legacy envelopes; duplicate failures are ignored", () => {
  const monitor = state()
  const success = forbidden(native("session.execution.succeeded"), "properties", "created", "durable")
  assert.deepEqual(toCoucouEvents(success, monitor), [{ hook_event_name: "Stop", ...located }])
  const failure = native("session.execution.failed", forbidden({ sessionID: "ses1" }, "error", "text", "content"))
  assert.deepEqual(toCoucouEvents(failure, monitor), [{ hook_event_name: "StopFailure", ...located }])
  assert.deepEqual(toCoucouEvents(failure, monitor), [])
  assert.deepEqual(toCoucouEvents(native("session.execution.succeeded"), monitor), [])
})

test("missing or invalid session, envelope, inbox and call identities are dropped", () => {
  for (const id of [undefined, null, "", 7, {}, "bad\nidentity", "\u007f", "\u0085", "\ud800", "\udfff", "é".repeat(129), "🐾".repeat(65)]) {
    const monitor = state()
    assert.deepEqual(toCoucouEvents(native("session.created", { sessionID: id }), monitor), [])
    assert.deepEqual(toCoucouEvents({ ...native("session.created"), id }, monitor), [])
    assert.deepEqual(toCoucouEvents(prompt(id), monitor), [])
    assert.deepEqual(toCoucouEvents(tool("input.started", { id, name: "bash" }), monitor), [])
    assert.deepEqual(toCoucouEvents(tool("called", { id }), monitor), [])
    assert.equal(monitor.sessions.size, 0)
  }
  assert.deepEqual(toCoucouEvents(native("session.created", { id: "not-a-session" }), state()), [])
})

test("opaque IDs preserve spaces, punctuation and Unicode without normalization", () => {
  for (const id of [" ", " session / #?= ", "../private", "👩‍💻", "e\u0301", "é".repeat(128), "🐾".repeat(64)]) {
    const monitor = state()
    assert.deepEqual(toCoucouEvents(native("session.created", { sessionID: id }), monitor),
      [{ hook_event_name: "SessionStart", coucou_agent: "opencode", session_id: id, cwd: "/repo" }])
    assert.deepEqual(toCoucouEvents(prompt(id), monitor), [{ hook_event_name: "UserPromptSubmit", ...located }])
    assert.deepEqual(toCoucouEvents(prompt(id), monitor), [])
    toCoucouEvents(tool("input.started", { id, name: "bash" }), monitor)
    assert.deepEqual(toCoucouEvents(tool("called", { id }), monitor), [{ hook_event_name: "PreToolUse", ...located, tool_name: "bash" }])
  }
})

test("cwd comes only from a valid matching native envelope, never data or cached scope", () => {
  for (const cwd of ["/repo/日本語", "C:\\repo", "/" + "é".repeat(511) + "a"]) {
    assert.equal(toCoucouEvents(native("session.created", { sessionID: "ses1" }, cwd), state(cwd))[0].cwd, cwd)
  }
  for (const cwd of [undefined, null, {}, "", "relative", "/bad\npath", "/\ud800", "/" + "é".repeat(512)]) {
    const event = native("session.created")
    event.location.directory = cwd
    assert.deepEqual(toCoucouEvents(event, state()), [])
    const invalidScope = state()
    invalidScope.directory = cwd
    assert.deepEqual(toCoucouEvents(native("session.created"), invalidScope), [])
  }
  const monitor = state()
  assert.deepEqual(toCoucouEvents(native("session.created", { sessionID: "ses1", location: { directory: "/repo" } }, null), monitor), [])
  toCoucouEvents(native("session.created", forbidden({ sessionID: "ses1" }, "location", "directory")), monitor)
  assert.deepEqual(toCoucouEvents(native("session.execution.succeeded", { sessionID: "ses1" }, null), monitor),
    [{ hook_event_name: "Stop", ...base }])
})

test("shared native streams are scoped before foreign data is read or names are enriched", () => {
  const a = state("/repo")
  const b = state("/other")
  const start = native("session.created")
  assert.equal(toCoucouEvents(start, a).length, 1)
  assert.deepEqual(toCoucouEvents(start, b), [])
  const other = native("session.created", { sessionID: "other" }, "/other")
  assert.deepEqual(toCoucouEvents(other, a), [])
  assert.equal(toCoucouEvents(other, b).length, 1)
  toCoucouEvents(tool("input.started", { name: "bash" }), a)
  const foreignName = tool("input.started", { name: "private_tool" }, "/other")
  assert.deepEqual(toCoucouEvents(foreignName, a), [])
  const foreign = native("session.tool.success", {}, "/other")
  forbidden(foreign, "data", "id")
  assert.deepEqual(toCoucouEvents(foreign, a), [])
  assert.deepEqual(toCoucouEvents(tool("called"), a), [{ hook_event_name: "PreToolUse", ...located, tool_name: "bash" }])
  assert.deepEqual(toCoucouEvents(native("session.execution.failed", { sessionID: "other" }, null), a), [])
  assert.deepEqual(toCoucouEvents(native("session.deleted", { sessionID: "ses1" }, "/other"), a), [])
  assert.equal(a.sessions.has("ses1"), true)
})

test("tool labels are bounded safe metadata with generic outcomes when start/name is absent", () => {
  for (const label of [undefined, null, {}, "", "bash secret --token=x", "é".repeat(129), "bad\nname", "\ud800"]) {
    const monitor = state()
    toCoucouEvents(tool("input.started", { name: label }), monitor)
    assert.deepEqual(toCoucouEvents(tool("called"), monitor), [{ hook_event_name: "PreToolUse", ...located }])
    assert.deepEqual(toCoucouEvents(tool("success"), monitor), [{ hook_event_name: "PostToolUse", ...located }])
  }
  const monitor = state()
  toCoucouEvents(tool("input.started", { name: "é".repeat(128) }), monitor)
  assert.equal(toCoucouEvents(tool("called"), monitor)[0].tool_name, "é".repeat(128))
  assert.deepEqual(toCoucouEvents(tool("failed", { id: "no-start" }), monitor), [{ hook_event_name: "PostToolUseFailure", ...located }])
  assert.deepEqual(toCoucouEvents(tool("called", { id: "no-name" }), monitor), [{ hook_event_name: "PreToolUse", ...located }])
})

test("native failure persists until a new user inbox, including duplicate admission after later failure", () => {
  const monitor = state()
  const start = native("session.created")
  toCoucouEvents(start, monitor)
  const prior = prompt("prior")
  toCoucouEvents(prior, monitor)
  const failure = () => native("session.execution.failed", forbidden({ sessionID: "ses1" }, "error"), null)
  const success = () => native("session.execution.succeeded", { sessionID: "ses1" }, null)
  assert.deepEqual(toCoucouEvents(failure(), monitor), [{ hook_event_name: "StopFailure", ...base }])
  assert.deepEqual(toCoucouEvents(success(), monitor), [])
  const next = prompt("next")
  assert.deepEqual(toCoucouEvents(next, monitor), [{ hook_event_name: "UserPromptSubmit", ...located }])
  assert.deepEqual(toCoucouEvents(success(), monitor), [{ hook_event_name: "Stop", ...base }])
  toCoucouEvents(failure(), monitor)
  for (const duplicate of [start, prior, next, prompt("prior"), prompt("next"), prompt("synthetic", "ses1", "synthetic")]) {
    assert.deepEqual(toCoucouEvents(duplicate, monitor), [])
  }
  assert.deepEqual(toCoucouEvents(native("session.created"), monitor), [], "lifecycle replay must not overwrite terminal failure")
  toCoucouEvents(tool("input.started", { name: "bash" }), monitor)
  assert.deepEqual(toCoucouEvents(tool("called"), monitor), [], "late tool progress must not overwrite terminal failure")
  assert.deepEqual(toCoucouEvents(tool("success"), monitor), [])
  assert.deepEqual(toCoucouEvents(tool("failed", { id: "late-failed" }), monitor), [])
  assert.deepEqual(toCoucouEvents(success(), monitor), [])
  assert.equal(toCoucouEvents(prompt("third"), monitor)[0].hook_event_name, "UserPromptSubmit")
  assert.equal(toCoucouEvents(success(), monitor)[0].hook_event_name, "Stop")
})

test("same call and inbox IDs in different sessions cannot collide or share names/failure", () => {
  const monitor = state()
  for (const [sessionID, name] of [["ses1", "bash"], ["ses2", "read"]]) {
    toCoucouEvents(native("session.created", { sessionID }), monitor)
    toCoucouEvents(tool("input.started", { sessionID, name }), monitor)
    assert.deepEqual(toCoucouEvents(prompt("same-inbox", sessionID), monitor),
      [{ hook_event_name: "UserPromptSubmit", coucou_agent: "opencode", session_id: sessionID, cwd: "/repo" }])
    assert.deepEqual(toCoucouEvents(tool("called", { sessionID }), monitor),
      [{ hook_event_name: "PreToolUse", coucou_agent: "opencode", session_id: sessionID, cwd: "/repo", tool_name: name }])
  }
  toCoucouEvents(native("session.execution.failed"), monitor)
  assert.deepEqual(toCoucouEvents(tool("failed", { sessionID: "ses2" }, null), monitor),
    [{ hook_event_name: "PostToolUseFailure", coucou_agent: "opencode", session_id: "ses2", tool_name: "read" }])
  assert.deepEqual(toCoucouEvents(tool("success", {}, null), monitor), [])
  assert.deepEqual(toCoucouEvents(native("session.execution.succeeded", { sessionID: "ses2" }, null), monitor),
    [{ hook_event_name: "Stop", coucou_agent: "opencode", session_id: "ses2" }])
  assert.deepEqual(toCoucouEvents(native("session.execution.succeeded", { sessionID: "ses1" }, null), monitor), [])
})

test("session pressure drops new ownership without evicting any of the 16 admitted sessions", () => {
  const monitor = state()
  const admitted = []
  for (let i = 0; i < 1000; i++) {
    admitted.push(...toCoucouEvents(native("session.created", { sessionID: `ses${i}` }), monitor))
  }
  assert.equal(admitted.length, 16)
  assert.equal(monitor.sessions.size, 16)
  assert.deepEqual(toCoucouEvents(native("session.execution.succeeded", { sessionID: "ses999" }, null), monitor), [])
  assert.equal(toCoucouEvents(native("session.execution.failed", { sessionID: "ses0" }, null), monitor)[0].hook_event_name, "StopFailure")
  assert.deepEqual(toCoucouEvents(native("session.execution.succeeded", { sessionID: "ses0" }, null), monitor), [])
  assert.equal(toCoucouEvents(native("session.deleted", { sessionID: "ses0" }, null), monitor)[0].hook_event_name, "SessionEnd")
  assert.equal(toCoucouEvents(native("session.created", { sessionID: "recovered" }), monitor).length, 1)
  assert.equal(monitor.sessions.size, 16)
})

test("event/inbox pressure retains failure and duplicate-admission guards until deletion", () => {
  const monitor = state()
  toCoucouEvents(prompt("prior"), monitor)
  toCoucouEvents(native("session.execution.failed"), monitor)
  for (let i = 0; i < 1000; i++) toCoucouEvents(native("session.execution.failed"), monitor)
  assert.ok(monitor.seen.size <= 256)
  assert.deepEqual(toCoucouEvents(prompt("prior"), monitor), [])
  assert.deepEqual(toCoucouEvents(prompt("new-under-pressure"), monitor), [])
  assert.deepEqual(toCoucouEvents(native("session.execution.succeeded"), monitor), [])
  assert.equal(monitor.sessions.get("ses1").failed, true)
  assert.equal(toCoucouEvents(native("session.deleted", { sessionID: "ses1" }, null), monitor)[0].hook_event_name, "SessionEnd")
  assert.equal(monitor.seen.size, 0)
  assert.equal(toCoucouEvents(prompt("new-after-deletion"), monitor)[0].hook_event_name, "UserPromptSubmit")
})

test("call pressure fails closed without evicting pending names and deletion frees all lookups", () => {
  const monitor = state()
  toCoucouEvents(tool("input.started", { id: "call0", name: "read" }), monitor)
  for (let i = 1; i < 1000; i++) toCoucouEvents(tool("input.started", { id: `call${i}`, name: "bash" }), monitor)
  assert.ok(monitor.calls.size <= 256)
  assert.ok(monitor.seen.size <= 256)
  assert.deepEqual(toCoucouEvents(tool("called", { id: "overflow" }), monitor), [])
  assert.deepEqual(toCoucouEvents(tool("called", { id: "call0" }), monitor), [])
  assert.equal(monitor.calls.values().next().value.toolName, "read")
  assert.equal(toCoucouEvents(native("session.deleted", { sessionID: "ses1" }, null), monitor)[0].hook_event_name, "SessionEnd")
  assert.equal(monitor.calls.size, 0)
  assert.equal(monitor.seen.size, 0)
  assert.equal(monitor.sessions.size, 0)
  toCoucouEvents(tool("input.started", { name: "read" }), monitor)
  assert.equal(toCoucouEvents(tool("called"), monitor)[0].tool_name, "read")
})

test("locationless deletion clears only its owner and leaves no names or tombstones", () => {
  const monitor = state()
  for (const sessionID of ["ses1", "ses2"]) {
    toCoucouEvents(native("session.created", { sessionID }), monitor)
    toCoucouEvents(prompt("inbox", sessionID), monitor)
    toCoucouEvents(tool("input.started", { sessionID, name: "bash" }), monitor)
    toCoucouEvents(native("session.execution.failed", { sessionID }), monitor)
  }
  const end = native("session.deleted", forbidden({ sessionID: "ses1" }, "location", "error", "text"), null)
  assert.deepEqual(toCoucouEvents(end, monitor), [{ hook_event_name: "SessionEnd", ...base }])
  assert.deepEqual(toCoucouEvents(end, monitor), [])
  assert.deepEqual(toCoucouEvents(native("session.execution.succeeded", { sessionID: "ses1" }, null), monitor), [])
  assert.equal(monitor.sessions.size, 1)
  assert.ok([...monitor.seen.values()].every(owner => owner === "ses2"))
  assert.ok([...monitor.calls.values()].every(call => call.sessionId === "ses2"))
  toCoucouEvents(native("session.created"), monitor)
  assert.deepEqual(toCoucouEvents(tool("called"), monitor), [{ hook_event_name: "PreToolUse", ...located }])
  assert.deepEqual(toCoucouEvents(native("session.execution.succeeded"), monitor), [{ hook_event_name: "Stop", ...located }])
  assert.deepEqual(toCoucouEvents(native("session.execution.succeeded", { sessionID: "ses2" }, null), monitor), [])
})

test("native input envelopes remain unchanged and output never contains content", () => {
  const monitor = state()
  const events = [
    native("session.created", { sessionID: "ses1", location: { directory: "/repo" }, slug: "PRIVATE_SLUG" }),
    native("session.inbox.enqueued", { sessionID: "ses1", inboxID: "inbox1", item: { type: "user", payload: { text: "PRIVATE_PROMPT" }, delivery: "immediate" } }),
    native("session.tool.input.started", { sessionID: "ses1", assistantMessageID: "assistant1", id: "call1", name: "bash" }),
    native("session.tool.called", { sessionID: "ses1", id: "call1", input: { command: "PRIVATE_COMMAND" }, executed: true }),
    native("session.tool.success", { sessionID: "ses1", id: "call1", content: "PRIVATE_RESULT", metadata: { secret: "PRIVATE_METADATA" }, executed: true }),
    native("session.execution.failed", { sessionID: "ses1", error: { type: "provider", message: "PRIVATE_ERROR" } }),
  ]
  const original = JSON.stringify(events)
  const output = events.flatMap(event => toCoucouEvents(event, monitor))
  assert.equal(JSON.stringify(events), original)
  assert.equal(output.length, 5)
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE_/)
})

test("the plugin sends only minimal JSON to a real executable and never logs stream exceptions", async () => {
  const directory = await mkdtemp("/tmp/opencode/coucou-node-privacy-")
  const executable = join(directory, "capture")
  await writeFile(executable, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", value => input += value);
process.stdin.on("end", () => writeFileSync(process.env.COUCOU_CAPTURE + "/" + process.pid + ".json", JSON.stringify({ args: process.argv.slice(2), input })));
`, { mode: 0o700 })
  const oldHook = process.env.COUCOU_HOOK
  const oldCapture = process.env.COUCOU_CAPTURE
  process.env.COUCOU_HOOK = executable
  process.env.COUCOU_CAPTURE = directory
  // Qualifies our plugin boundary only, not the real upstream SDK.
  const loader = registerHooks({ resolve(specifier, context, next) {
    if (specifier === "@opencode/plugin") return {
      url: "data:text/javascript,export const Plugin = { define: value => value }", shortCircuit: true,
    }
    return next(specifier, context)
  } })
  const logs = []
  const originalError = console.error
  console.error = (...args) => logs.push(args)
  let cleanup
  try {
    const { default: plugin } = await import(`../integrations/opencode/coucou.ts?privacy=${Date.now()}`)
    const events = [
      native("session.created", { sessionID: "ses1", slug: "PRIVATE_SLUG", location: { directory: "/repo" } }),
      native("session.tool.input.started", { sessionID: "ses1", assistantMessageID: "assistant1", id: "call1", name: "bash" }),
      native("session.tool.failed", { sessionID: "ses1", assistantMessageID: "assistant1", id: "call1", error: "PRIVATE_ERROR", executed: true }, null),
    ]
    const original = JSON.stringify(events)
    const controllerSignals = []
    let locationReads = 0
    const ctx = { event: { async *subscribe({ signal }) {
      controllerSignals.push(signal)
      for (const event of events) yield event
      yield forbidden(native("session.created", {}, "/other"), "data")
      throw new Error("PRIVATE_STREAM_ERROR")
    } }, get location() {
      locationReads++
      return { directory: "/repo" }
    } }
    cleanup = plugin.setup(ctx)
    let files = []
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) {
      files = (await readdir(directory)).filter(name => name.endsWith(".json"))
      if (files.length === 2) break
      await delay(10)
    }
    assert.equal(files.length, 2, "expected two real captured stdin packets")
    const captures = await Promise.all(files.map(async name => JSON.parse(await readFile(join(directory, name), "utf8"))))
    captures.sort((a, b) => a.args.at(-1).localeCompare(b.args.at(-1)))
    assert.deepEqual(captures, [
      { args: ["--agent", "opencode", "PostToolUseFailure"], input: JSON.stringify({ hook_event_name: "PostToolUseFailure", ...base, tool_name: "bash" }) + "\n" },
      { args: ["--agent", "opencode", "SessionStart"], input: JSON.stringify({ hook_event_name: "SessionStart", ...base, cwd: "/repo" }) + "\n" },
    ])
    assert.equal(JSON.stringify(events), original)
    assert.equal(locationReads, 1, "registration directory is read only to scope shared events")
    assert.deepEqual(logs, [])
    await cleanup()
    assert.equal(controllerSignals[0].aborted, true)
  } finally {
    await cleanup?.()
    console.error = originalError
    loader.deregister()
    if (oldHook === undefined) delete process.env.COUCOU_HOOK
    else process.env.COUCOU_HOOK = oldHook
    if (oldCapture === undefined) delete process.env.COUCOU_CAPTURE
    else process.env.COUCOU_CAPTURE = oldCapture
    await rm(directory, { recursive: true, force: true })
  }
})

test("missing relay and stream failures are silent even with a private exception", async () => {
  const loader = registerHooks({ resolve(specifier, context, next) {
    if (specifier === "@opencode/plugin") return {
      url: "data:text/javascript,export const Plugin = { define: value => value }", shortCircuit: true,
    }
    return next(specifier, context)
  } })
  const logs = []
  const originalError = console.error
  const oldHook = process.env.COUCOU_HOOK
  process.env.COUCOU_HOOK = `/tmp/opencode/coucou-test-missing-${Date.now()}/relay`
  console.error = (...args) => logs.push(args)
  try {
    const { default: plugin } = await import(`../integrations/opencode/coucou.ts?silent=${Date.now()}`)
    const cleanup = plugin.setup({ location: { directory: "/repo" }, event: { async *subscribe() {
      yield native("session.created")
      throw new Error("PRIVATE_STREAM_ERROR")
    } } })
    await delay(0)
    assert.deepEqual(logs, [])
    await cleanup()
  } finally {
    console.error = originalError
    if (oldHook === undefined) delete process.env.COUCOU_HOOK
    else process.env.COUCOU_HOOK = oldHook
    loader.deregister()
  }
})

test("plugin cleanup aborts, kills its child and ignores an iterator's late event", async () => {
  const directory = await mkdtemp("/tmp/opencode/coucou-node-unload-")
  const executable = join(directory, "held relay.mjs")
  await writeFile(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(directory, "starts"))}, process.pid + "\\n");
setTimeout(() => {}, 4000);
`, { mode: 0o700 })
  const oldHook = process.env.COUCOU_HOOK
  process.env.COUCOU_HOOK = executable
  const loader = registerHooks({ resolve(specifier, context, next) {
    if (specifier === "@opencode/plugin") return {
      url: "data:text/javascript,export const Plugin = { define: value => value }", shortCircuit: true,
    }
    return next(specifier, context)
  } })
  let release
  const held = new Promise(resolve => { release = resolve })
  let cleanup
  let pid
  try {
    const { default: plugin } = await import(`../integrations/opencode/coucou.ts?unload=${Date.now()}`)
    let signal
    cleanup = plugin.setup({ location: { directory: "/repo" }, event: { async *subscribe(options) {
      signal = options.signal
      yield native("session.created")
      yield tool("input.started", { name: "bash" })
      yield prompt("inbox1")
      await held
      yield native("session.created", { sessionID: "late-session" })
    } } })
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      try { pid = Number((await readFile(join(directory, "starts"), "utf8")).trim()); break }
      catch (error) { if (error.code !== "ENOENT") throw error }
      await delay(10)
    }
    assert.ok(pid)
    await cleanup()
    assert.equal(signal.aborted, true)
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
    release()
    await delay(100)
    assert.equal((await readFile(join(directory, "starts"), "utf8")).trim(), String(pid))
    await cleanup()
  } finally {
    release()
    await cleanup?.()
    if (pid) { try { process.kill(pid, "SIGKILL") } catch {} }
    await delay(50)
    loader.deregister()
    if (oldHook === undefined) delete process.env.COUCOU_HOOK
    else process.env.COUCOU_HOOK = oldHook
    await rm(directory, { recursive: true, force: true })
  }
})
