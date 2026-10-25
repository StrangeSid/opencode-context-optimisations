import assert from "node:assert/strict"
import { test } from "node:test"

import {
  createLruCache,
  optimizeTranscript,
  type CompressionBackend,
  type CompressionRequest,
  type OptimizerOptions,
} from "../src/optimizer.ts"
import { createExpandAnnotator, createExpandStore } from "../src/expand.ts"
import type { V2ContentPart, V2Message, V2ToolResult } from "../src/v2.ts"

const prose = `The build failed because the TypeScript compiler could not resolve the module. I checked the configuration and module resolution was set to bundler, which should work. The failure only happens in the test package, where the same import is resolved from a different root. I tried clearing the dependency cache and reinstalling, but the error persisted. Next I will inspect the package exports map and the compiled output.`

const toolProse = `The read tool returned the package manifest and the relevant source files. The exports map points at the compiled output, and the same module identifier resolves differently from the test package. I will compare both resolutions before changing the configuration.`

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
          result: { type: "text", value: toolProse },
        },
      ],
    },
    { role: "user", content: [{ type: "text", text: "current request" }] },
  ] as unknown as V2Message[]
}

const baseOptions: OptimizerOptions = {
  minTokens: 1,
  budgetTokens: 100_000,
  rate: 0.6,
  modelId: "test-model",
  timeoutMs: 200,
  maxCompressedRatio: 0.9,
}

function recordingBackend(
  calls: CompressionRequest[],
  output: string | ((request: CompressionRequest) => string) = "Condensed prose.",
): CompressionBackend {
  return {
    async compress(request) {
      calls.push(request)
      return typeof output === "function" ? output(request) : output
    },
  }
}

function textParts(message: V2Message): V2ContentPart[] {
  return message.content as V2ContentPart[]
}

test("compresses old text and tool-result text in place", async () => {
  const messages = fixture()
  const calls: CompressionRequest[] = []
  const stats = await optimizeTranscript(messages, baseOptions, {
    backend: recordingBackend(calls),
    cache: createLruCache(8),
  })

  assert.equal(stats.enabled, true)
  assert.equal(stats.candidates, 2)
  assert.equal(stats.compressed, 2)
  assert.equal(stats.applied, 2)
  assert.equal(stats.cacheHits, 0)
  assert.equal(stats.failures, 0)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].kind, "text")
  assert.equal(calls[1].kind, "tool-result")
  assert.equal(calls[1].toolName, "read")
  assert.ok(stats.savedTokens > 0)

  const parts = textParts(messages[0])
  assert.equal(parts[0].text, "Condensed prose.")
  assert.equal((parts[1].result as V2ToolResult).value, "Condensed prose.")
})

test("reuses the LRU across model calls", async () => {
  const cache = createLruCache(8)
  const calls: CompressionRequest[] = []
  const backend = recordingBackend(calls)

  await optimizeTranscript(fixture(), baseOptions, { backend, cache })
  const stats = await optimizeTranscript(fixture(), baseOptions, { backend, cache })

  assert.equal(calls.length, 2)
  assert.equal(stats.cacheHits, 2)
  assert.equal(stats.compressed, 2)
  assert.equal(stats.failures, 0)
})

test("identical spans in one call share the compressor result", async () => {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "text", text: prose },
        { type: "text", text: prose },
      ],
    },
    { role: "user", content: [{ type: "text", text: "current request" }] },
  ] as unknown as V2Message[]
  const calls: CompressionRequest[] = []
  const stats = await optimizeTranscript(messages, baseOptions, {
    backend: recordingBackend(calls),
    cache: createLruCache(8),
  })

  assert.equal(calls.length, 1)
  assert.equal(stats.cacheHits, 1)
  assert.equal(stats.compressed, 2)
})

test("backend failure leaves the original transcript untouched", async () => {
  const messages = fixture()
  const stats = await optimizeTranscript(messages, baseOptions, {
    backend: {
      async compress() {
        throw new Error("sidecar unavailable")
      },
    },
    cache: createLruCache(8),
  })

  assert.equal(stats.failures, 2)
  assert.equal(stats.compressed, 0)
  assert.equal(stats.applied, 0)
  assert.equal(textParts(messages[0])[0].text, prose)
  assert.equal((textParts(messages[0])[1].result as V2ToolResult).value, toolProse)
})

test("a slow backend times out and fails open", async () => {
  const messages = fixture()
  const stats = await optimizeTranscript(
    messages,
    { ...baseOptions, timeoutMs: 10 },
    {
      backend: {
        compress() {
          return new Promise<string>(() => {})
        },
      },
      cache: createLruCache(8),
    },
  )

  assert.equal(stats.failures, 2)
  assert.equal(stats.compressed, 0)
  assert.equal(textParts(messages[0])[0].text, prose)
})

test("an expansion is skipped and not cached", async () => {
  const messages = fixture()
  const calls: CompressionRequest[] = []
  const stats = await optimizeTranscript(messages, baseOptions, {
    backend: recordingBackend(calls, prose + " " + prose),
    cache: createLruCache(8),
  })

  assert.equal(stats.compressed, 0)
  assert.equal(stats.skipped, 2)
  assert.equal(textParts(messages[0])[0].text, prose)
})

test("disabled optimization does not call the backend", async () => {
  let calls = 0
  const stats = await optimizeTranscript(
    fixture(),
    { ...baseOptions, enabled: false },
    {
      backend: {
        async compress() {
          calls += 1
          return "Condensed prose."
        },
      },
    },
  )

  assert.equal(stats.enabled, false)
  assert.equal(stats.candidates, 0)
  assert.equal(calls, 0)
})

test("LRU evicts the least recently used entry", () => {
  const cache = createLruCache(2)
  cache.set("a", "A")
  cache.set("b", "B")
  assert.equal(cache.get("a"), "A")
  cache.set("c", "C")

  assert.equal(cache.get("b"), undefined)
  assert.equal(cache.get("a"), "A")
  assert.equal(cache.get("c"), "C")
  assert.equal(cache.size, 2)
})

test("a zero-capacity cache never stores", () => {
  const cache = createLruCache(0)
  cache.set("a", "A")
  assert.equal(cache.get("a"), undefined)
  assert.equal(cache.size, 0)
})

test("code, JSON, and error spans never reach the backend", async () => {
  const code = `import { readFile } from "node:fs/promises"
import path from "node:path"

export async function loadConfig(dir: string): Promise<Config> {
  const file = path.join(dir, "config.json")
  const raw = await readFile(file, "utf8")
  return JSON.parse(raw)
}`
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "text", text: code },
        {
          type: "tool-result",
          id: "call-json",
          name: "api",
          result: { type: "json", value: { ok: true } },
        },
        {
          type: "tool-result",
          id: "call-error",
          name: "bash",
          result: { type: "error", value: "Error: exact diagnostics" },
        },
        { type: "text", text: prose },
      ],
    },
    { role: "user", content: [{ type: "text", text: "current request" }] },
  ] as unknown as V2Message[]
  const calls: CompressionRequest[] = []
  const stats = await optimizeTranscript(messages, baseOptions, {
    backend: recordingBackend(calls),
    cache: createLruCache(8),
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].text, prose)
  assert.equal(stats.candidates, 1)
  assert.equal(stats.compressed, 1)
  assert.equal(textParts(messages[0])[0].text, code)
  assert.deepEqual((textParts(messages[0])[1].result as V2ToolResult).value, { ok: true })
  assert.equal(
    (textParts(messages[0])[2].result as V2ToolResult).value,
    "Error: exact diagnostics",
  )
})

test("an empty value from a custom cache is never applied", async () => {
  const messages = fixture()
  const calls: CompressionRequest[] = []
  const stats = await optimizeTranscript(messages, baseOptions, {
    backend: recordingBackend(calls),
    cache: {
      get() {
        return ""
      },
      set() {},
      size: 0,
    },
  })

  assert.equal(calls.length, 0)
  assert.equal(stats.compressed, 0)
  assert.equal(stats.skipped, 2)
  assert.equal(textParts(messages[0])[0].text, prose)
})

test("literal validation rejects output that drops paths or numbers", async () => {
  const text = prose + " The retry limit is 7 and the parser lives at src/legacy/parser.ts."
  const messages = [
    { role: "assistant", content: [{ type: "text", text }] },
    { role: "user", content: [{ type: "text", text: "current request" }] },
  ] as unknown as V2Message[]
  const stats = await optimizeTranscript(messages, baseOptions, {
    backend: recordingBackend([], "retry limit and parser lives at legacy parser"),
    cache: createLruCache(8),
  })

  assert.equal(stats.compressed, 0)
  assert.equal(stats.literalRejects, 1)
  assert.equal(stats.skipped, 1)
  assert.equal(textParts(messages[0])[0].text, text)
})

test("the expand annotator appends a recoverable marker", async () => {
  const messages = fixture()
  const store = createExpandStore()
  const stats = await optimizeTranscript(messages, baseOptions, {
    backend: recordingBackend([], "Condensed prose."),
    cache: createLruCache(8),
    onCompressed: createExpandAnnotator(store),
  })

  assert.equal(stats.compressed, 2)
  const first = textParts(messages[0])[0].text ?? ""
  assert.match(first, /^Condensed prose\.\n\[ctx_expand:ctx_[0-9a-f]+\]$/)
  const handle = first.match(/ctx_expand:(ctx_[0-9a-f]+)/)?.[1]
  assert.ok(handle)
  assert.equal(store.get(handle ?? ""), prose)
})
