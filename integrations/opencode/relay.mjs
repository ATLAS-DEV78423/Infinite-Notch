import { spawn } from "node:child_process"

/** FIFO for detached, already-minimized packets; overload drops the newest packet. */
export function createRelay(command, agent) {
  const queue = []
  let active
  let closed = false
  let generation = 0
  let closing

  function stop(child) {
    child.stdin?.destroy()
    try { child.kill("SIGKILL") } catch {}
  }

  function pump() {
    if (closed || active || queue.length === 0) return
    const { event, input } = queue.shift()
    const currentGeneration = generation
    try {
      const child = spawn(command, ["--agent", agent, event], {
        stdio: ["pipe", "ignore", "ignore"], shell: false,
      })
      let reaped
      const done = new Promise(resolve => { reaped = resolve })
      active = { child, done }
      const deadline = setTimeout(() => stop(child), 2000)
      child.on("error", () => stop(child))
      child.stdin?.on("error", () => stop(child))
      child.once("close", () => {
        clearTimeout(deadline)
        child.stdin?.destroy()
        active = undefined
        reaped()
        if (currentGeneration === generation) pump()
      })
      child.stdin?.end(input)
    } catch {
      if (active) stop(active.child)
      else queueMicrotask(pump)
    }
  }

  return {
    enqueue(payload) {
      if (closed || queue.length >= 17) return false
      try {
        const event = payload.hook_event_name
        if (typeof event !== "string") return false
        const input = JSON.stringify(payload) + "\n"
        if (Buffer.byteLength(input, "utf8") > 65536) return false
        queue.push({ event, input })
        pump()
        return true
      } catch { return false }
    },
    close() {
      if (closing) return closing
      closed = true
      generation++
      queue.length = 0
      closing = active?.done ?? Promise.resolve()
      if (active) stop(active.child)
      return closing
    },
  }
}
