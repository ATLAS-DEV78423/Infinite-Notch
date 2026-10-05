import { Plugin } from "@opencode/plugin"

import { toCoucouEvents } from "./events.mjs"
import { createRelay } from "./relay.mjs"

export default Plugin.define({
  id: "coucou-opencode",
  setup(ctx) {
    const sender = createRelay(process.env.COUCOU_HOOK ?? "coucou-hook", "opencode")
    const controller = new AbortController()
    const monitorState = { sessions: new Map(), seen: new Map(), calls: new Map() }

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted) break
          for (const payload of toCoucouEvents(event, monitorState)) {
            sender.enqueue(payload)
          }
        }
      } catch {
        // Stream errors can contain private upstream data; monitoring is optional.
      }
    })()

    return () => {
      controller.abort()
      monitorState.sessions.clear()
      monitorState.seen.clear()
      monitorState.calls.clear()
      return sender.close()
    }
  },
})
