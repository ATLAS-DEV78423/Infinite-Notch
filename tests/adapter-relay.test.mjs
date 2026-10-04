import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"

let createRelay
try { ({ createRelay } = await import("../integrations/opencode/relay.mjs")) } catch {}

async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(10)
  }
  assert.fail("timed out waiting for test-owned relay")
}

async function lines(directory, name) {
  try { return (await readFile(join(directory, name), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse) }
  catch (error) { if (error.code === "ENOENT") return []; throw error }
}

async function fixture(t) {
  assert.equal(typeof createRelay, "function", "bounded sender is not implemented")
  const directory = await mkdtemp("/tmp/opencode/coucou-node-relay-")
  const executable = join(directory, "relay with spaces ; $(not-a-command).mjs")
  await writeFile(executable, `#!${process.execPath}
import { appendFileSync, existsSync, mkdirSync, rmdirSync } from "node:fs";
const directory = ${JSON.stringify(directory)};
const event = process.argv.at(-1);
setTimeout(() => process.exit(3), 6000).unref();
try { mkdirSync(directory + "/lock"); }
catch { appendFileSync(directory + "/overlap", "overlap\\n"); }
appendFileSync(directory + "/starts", JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + "\\n");
process.on("exit", () => { try { rmdirSync(directory + "/lock"); } catch {} });
if (event === "stalled" || event === "close-active") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (event === "broken-pipe") {
  process.stdin.destroy();
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", value => input += value);
  process.stdin.on("end", () => {
    const finish = () => {
      appendFileSync(directory + "/packets", JSON.stringify({ args: process.argv.slice(2), input }) + "\\n");
    };
    if (event === "held") {
      const timer = setInterval(() => {
        if (existsSync(directory + "/release")) { clearInterval(timer); finish(); }
      }, 10);
    } else finish();
  });
}
`, { mode: 0o700 })
  const sender = createRelay(executable, "opencode")
  t.after(async () => {
    try {
      await sender.close()
      for (const { pid } of await lines(directory, "starts")) {
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "fixture child must be reaped")
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  return { directory, executable, sender }
}

function packet(event, id = "session / #?= ; $() 👩‍💻") {
  return { hook_event_name: event, coucou_agent: "opencode", session_id: id }
}

test("one child and 17 pending FIFO packets bound bursts without merging transitions", async t => {
  const { sender, directory } = await fixture(t)
  assert.equal(sender.enqueue(packet("held")), true)
  await until(async () => (await lines(directory, "starts")).length === 1)
  const events = ["SessionStart", "PreToolUse", "PostToolUseFailure", "StopFailure", "SessionEnd"]
  const expected = []
  for (let i = 0; i < 17; i++) {
    const value = packet(events[i % events.length], `session ${i}`)
    expected.push({ ...value })
    assert.equal(sender.enqueue(value), true)
    value.session_id = "MUTATED_AFTER_ENQUEUE"
  }
  for (let i = 0; i < 100; i++) assert.equal(sender.enqueue(packet("Stop", `overflow ${i}`)), false)
  await delay(50)
  assert.equal((await lines(directory, "starts")).length, 1)
  await writeFile(join(directory, "release"), "")
  await until(async () => (await lines(directory, "packets")).length === 18)
  const captures = await lines(directory, "packets")
  assert.deepEqual(captures.map(value => JSON.parse(value.input)), [packet("held"), ...expected])
  assert.deepEqual(captures[0].args, ["--agent", "opencode", "held"])
  assert.equal((await lines(directory, "overlap")).length, 0)
})

test("a non-reading child has a two-second deadline before the next child starts", async t => {
  const { sender, directory } = await fixture(t)
  const began = Date.now()
  assert.equal(sender.enqueue({ ...packet("stalled"), padding: "x".repeat(60000) }), true)
  await until(async () => (await lines(directory, "starts")).length === 1)
  assert.equal(sender.enqueue(packet("SessionEnd")), true)
  await until(async () => (await lines(directory, "packets")).length === 1, 3500)
  const starts = await lines(directory, "starts")
  assert.equal(starts.length, 2)
  assert.throws(() => process.kill(starts[0].pid, 0), { code: "ESRCH" })
  assert.ok(Date.now() - began >= 1800 && Date.now() - began < 3500)
})

test("close kills and reaps the child, drops queued work, and rejects future enqueue", async t => {
  const { sender, directory } = await fixture(t)
  sender.enqueue({ ...packet("close-active"), padding: "x".repeat(60000) })
  await until(async () => (await lines(directory, "starts")).length === 1)
  sender.enqueue(packet("SessionEnd"))
  await Promise.all([sender.close(), sender.close()])
  assert.equal(sender.enqueue(packet("SessionStart")), false)
  await delay(50)
  const starts = await lines(directory, "starts")
  assert.equal(starts.length, 1)
  assert.throws(() => process.kill(starts[0].pid, 0), { code: "ESRCH" })
  assert.deepEqual(await lines(directory, "packets"), [])
})

test("stdin is detached JSON capped at 64KiB including LF and argument text stays literal", async t => {
  const { sender, directory } = await fixture(t)
  const value = packet("event ; $(not-a-command)")
  value.padding = ""
  value.padding = "é".repeat(Math.floor((65536 - Buffer.byteLength(JSON.stringify(value) + "\n")) / 2))
  while (Buffer.byteLength(JSON.stringify(value) + "\n") < 65536) value.padding += "x"
  assert.equal(sender.enqueue(value), true)
  assert.equal(sender.enqueue({ ...value, padding: value.padding + "x" }), false)
  await until(async () => (await lines(directory, "packets")).length === 1)
  const [capture] = await lines(directory, "packets")
  assert.equal(Buffer.byteLength(capture.input), 65536)
  assert.deepEqual(capture.args, ["--agent", "opencode", "event ; $(not-a-command)"])
  assert.equal(JSON.parse(capture.input).session_id, value.session_id)
})

test("EPIPE and ENOENT stay silent and do not wedge delivery", async t => {
  const { sender, directory, executable } = await fixture(t)
  sender.enqueue({ ...packet("broken-pipe"), padding: "x".repeat(60000) })
  sender.enqueue(packet("SessionEnd"))
  await until(async () => (await lines(directory, "packets")).length === 1)
  const missing = createRelay(join(directory, "missing relay"), "opencode")
  try {
    missing.enqueue(packet("SessionStart"))
    await delay(50)
    // A recovered executable proves a spawn error did not leave an active slot stuck.
    await writeFile(join(directory, "missing relay"), await readFile(executable), { mode: 0o700 })
    missing.enqueue(packet("Stop"))
    await until(async () => (await lines(directory, "packets")).length === 2)
  } finally { await missing.close() }
})
