import assert from "node:assert/strict"
import { test } from "node:test"

import {
  createContextPlugin,
  resolvePluginConfig,
  type PluginRuntime,
} from "../src/plugin.ts"
import type { V2ContentPart, V2Message, V2ToolResult } from "../src/v2.ts"

const prose = `The build failed because the TypeScript compiler could not resolve the module. I checked the configuration and module resolution was set to bundler, which should work. The failure only happens in the test package, where the same import is resolved from a different root. I tried clearing the dependency cache and reinstalling, but the error persisted. Next I will inspect the package exports map and the compiled output.`

function fixture(): V2Message[] {
  return [
    {
      role: "assistant",
      content: [
        { type: "text", text: prose },
        {
          type: "tool-result",
          id: "call-1",
          name: "read",
          result: { type: "text", value: prose },
        },
      ],
    },
    { role: "user", content: [{ type: "text", text: "current request" }] },
  ] as unknown as V2Message[]
}

type Handler = (event: unknown) => Promise<void> | void

interface Harness {
  ctx: unknown
  options: Record<string, unknown>
  hookNames: string[]
  sessionHooks: Map<string, Handler>
  toolHooks: Map<string, Handler>
  addedTools: Array<{
    name: string
    execute: (input: { handle: string; query?: string }) => Promise<unknown>
  }>
}

function harness(options: Record<string, unknown> = {}, limit = 1_000_000): Harness {
  const state: Harness = {
    ctx: undefined,
    options,
    hookNames: [],
    sessionHooks: new Map(),
    toolHooks: new Map(),
    addedTools: [],
  }

  const ctx = {
    options,
    model: {
      async list() {
        return {
          location: {},
          data: [
            {
              id: "test-model",
              modelID: "test-model",
              providerID: "test-provider",
              limit: { context: limit, output: 1000 },
            },
          ],
        }
      },
    },
    session: {
      async hook(name: string, callback: Handler) {
        state.hookNames.push(name)
        state.sessionHooks.set(name, callback)
        return { dispose: async () => {} }
      },
    },
    tool: {
      async hook(name: string, callback: Handler) {
        state.toolHooks.set(name, callback)
        return { dispose: async () => {} }
      },
      async transform(callback: (editor: unknown) => void) {
        callback({
          list: () => state.addedTools,
          get: (id: string) => state.addedTools.find((tool) => tool.name === id),
          add: (tool: (typeof state.addedTools)[number]) => state.addedTools.push(tool),
          update: () => {},
          remove: () => {},
          namespace: () => {},
        })
        return { dispose: async () => {} }
      },
      async list() {
        return state.addedTools
      },
    },
  }

  state.ctx = ctx
  return state
}

function contextEvent(messages: V2Message[]) {
  return {
    messages,
    model: { id: "test-model", providerID: "test-provider" },
    system: [],
    tools: {},
  }
}

function recordingRuntime(output = "Condensed prose."): {
  runtime: PluginRuntime
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    runtime: {
      backend: {
        async compress(request) {
          calls.push(request.text)
          return output
        },
      },
      logger: () => {},
    },
  }
}

test("plugin config defaults are conservative", () => {
  const config = resolvePluginConfig({})
  assert.equal(config.enabled, true)
  assert.equal(config.debug, false)
  assert.equal(config.endpoint, undefined)
  assert.equal(config.allowUserProse, false)
  assert.equal(config.includeToolProse, true)
  assert.equal(config.validateLiterals, true)
  assert.equal(config.watermarkEnabled, true)
  assert.equal(config.watermarkRatio, undefined)
  assert.equal(config.compactionEnabled, true)
  assert.equal(config.toolOutputEnabled, false)
  assert.equal(config.expandToolEnabled, true)
})

test("plugin config reads options and normalizes the endpoint", () => {
  const config = resolvePluginConfig({
    enabled: false,
    debug: true,
    endpoint: "  http://127.0.0.1:8765/compress  ",
    protectedTurns: 1,
    rate: 0.5,
    toolOutputEnabled: true,
    protectedTools: ["edit", 3, "plan_*"],
  })

  assert.equal(config.enabled, false)
  assert.equal(config.debug, true)
  assert.equal(config.endpoint, "http://127.0.0.1:8765/compress")
  assert.equal(config.protectedTurns, 1)
  assert.equal(config.rate, 0.5)
  assert.equal(config.toolOutputEnabled, true)
  assert.deepEqual(config.protectedTools, ["edit", "plan_*"])
  assert.deepEqual(resolvePluginConfig({ protectedTools: [] }).protectedTools, [])
  assert.equal(resolvePluginConfig({ endpoint: "   " }).endpoint, undefined)
})

test("a backend-injected plugin registers context, compaction, and expand", async () => {
  const state = harness({ minTokens: 1, budgetTokens: 100_000, watermarkEnabled: false })
  const { runtime } = recordingRuntime()
  const plugin = createContextPlugin(runtime)

  await plugin.setup(state.ctx as never)
  assert.deepEqual(state.hookNames, ["context", "compaction"])
  assert.equal(state.addedTools.length, 1)
  assert.equal(state.addedTools[0].name, "context_expand")

  const messages = fixture()
  await state.sessionHooks.get("context")?.({ ...contextEvent(messages) })
  const parts = messages[0].content as V2ContentPart[]
  assert.match(parts[0].text ?? "", /^Condensed prose\.\n\[ctx_expand:ctx_/ )
  assert.match((parts[1].result as V2ToolResult).value as string, /^Condensed prose\.\n\[ctx_expand:ctx_/ )
})

test("watermark below the threshold skips the backend", async () => {
  const state = harness(
    { minTokens: 1, budgetTokens: 100_000, watermarkEnabled: true, watermarkRatio: 0.7 },
    1_000_000,
  )
  const { runtime, calls } = recordingRuntime()
  const plugin = createContextPlugin(runtime)
  await plugin.setup(state.ctx as never)

  const messages = fixture()
  await state.sessionHooks.get("context")?.({ ...contextEvent(messages) })
  assert.equal(calls.length, 0)
  assert.equal((messages[0].content as V2ContentPart[])[0].text, prose)
})

test("compaction pre-compresses the transcript without setting result", async () => {
  const state = harness({
    minTokens: 1,
    budgetTokens: 100_000,
    watermarkEnabled: false,
    compactionBudgetTokens: 100_000,
  })
  const { runtime } = recordingRuntime()
  const plugin = createContextPlugin(runtime)
  await plugin.setup(state.ctx as never)

  const messages = fixture()
  const event: { messages: V2Message[]; result?: unknown } = { messages }
  await state.sessionHooks.get("compaction")?.(event)
  assert.match(
    (messages[0].content as V2ContentPart[])[0].text ?? "",
    /^Condensed prose\.\n\[ctx_expand:ctx_/,
  )
  assert.equal(event.result, undefined)
})

test("tool-output lane compresses a completed tool result when enabled", async () => {
  const state = harness({
    minTokens: 1,
    budgetTokens: 100_000,
    watermarkEnabled: false,
    toolOutputEnabled: true,
    toolMinTokens: 1,
    toolBudgetTokens: 100_000,
    expandToolEnabled: false,
  })
  const { runtime, calls } = recordingRuntime()
  const plugin = createContextPlugin(runtime)
  await plugin.setup(state.ctx as never)

  const event = {
    status: "completed",
    tool: "read",
    id: "call-1",
    input: {},
    result: { content: prose },
  }
  await state.toolHooks.get("execute.after")?.(event)
  assert.equal(calls.length, 1)
  assert.equal(event.result.content, "Condensed prose.")
})

test("tool-output lane respects protected tools and errors", async () => {
  const state = harness({
    watermarkEnabled: false,
    toolOutputEnabled: true,
    toolMinTokens: 1,
    expandToolEnabled: false,
  })
  const { runtime, calls } = recordingRuntime()
  const plugin = createContextPlugin(runtime)
  await plugin.setup(state.ctx as never)

  const protectedEvent = {
    status: "completed",
    tool: "edit",
    id: "call-1",
    input: {},
    result: { content: prose },
  }
  await state.toolHooks.get("execute.after")?.(protectedEvent)
  assert.equal(protectedEvent.result.content, prose)

  const errorEvent = {
    status: "error",
    tool: "read",
    id: "call-2",
    input: {},
    error: { message: "boom" },
  }
  await state.toolHooks.get("execute.after")?.(errorEvent)
  assert.equal(calls.length, 0)
})

test("context_expand returns the original text for a marker handle", async () => {
  const state = harness({ minTokens: 1, budgetTokens: 100_000, watermarkEnabled: false })
  const { runtime } = recordingRuntime()
  const plugin = createContextPlugin(runtime)
  await plugin.setup(state.ctx as never)

  const messages = fixture()
  await state.sessionHooks.get("context")?.({ ...contextEvent(messages) })
  const text = (messages[0].content as V2ContentPart[])[0].text ?? ""
  const handle = text.match(/ctx_expand:(ctx_[0-9a-f]+)/)?.[1]
  assert.ok(handle)

  const result = (await state.addedTools[0].execute({ handle: handle ?? "" })) as {
    content: Array<{ type: string; text: string }>
  }
  assert.equal(result.content[0].text, prose)
})



test("watermark above the threshold runs the backend", async () => {
  const state = harness(
    { minTokens: 1, budgetTokens: 100_000, watermarkEnabled: true, watermarkRatio: 0.7 },
    10,
  )
  const { runtime, calls } = recordingRuntime()
  const plugin = createContextPlugin(runtime)
  await plugin.setup(state.ctx as never)

  const messages = fixture()
  await state.sessionHooks.get("context")?.({ ...contextEvent(messages) })
  assert.ok(calls.length > 0)
  assert.match((messages[0].content as V2ContentPart[])[0].text ?? "", /^Condensed prose\./)
})

test("no endpoint and no injected backend means no hooks or tools", async () => {
  const state = harness()
  const plugin = createContextPlugin()

  await plugin.setup(state.ctx as never)
  assert.deepEqual(state.hookNames, [])
  assert.equal(state.addedTools.length, 0)
})

test("disabled plugin ignores an injected backend", async () => {
  const state = harness({ enabled: false })
  const { runtime } = recordingRuntime()
  const plugin = createContextPlugin(runtime)

  await plugin.setup(state.ctx as never)
  assert.deepEqual(state.hookNames, [])
  assert.equal(state.addedTools.length, 0)
})
