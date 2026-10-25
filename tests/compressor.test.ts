import assert from "node:assert/strict"
import { test } from "node:test"

import { createHttpCompressor } from "../src/compressor.ts"
import type { CompressionRequest } from "../src/optimizer.ts"

const request: CompressionRequest = {
  text: "A long piece of prose that should be compressed.",
  rate: 0.6,
  modelId: "llmlingua-2",
  kind: "tool-result",
  cacheKey: "abc123",
  toolName: "read",
}

function fakeFetch(
  body: unknown,
  init: { status?: number; capture?: (url: string, options: RequestInit) => void } = {},
): typeof fetch {
  return (async (url: string | URL | Request, options?: RequestInit) => {
    init.capture?.(String(url), options ?? {})
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

test("posts the sidecar contract and returns text", async () => {
  let url = ""
  let options: RequestInit | undefined
  const backend = createHttpCompressor({
    endpoint: "http://127.0.0.1:8765/compress",
    timeoutMs: 100,
    fetch: fakeFetch({ text: "short" }, {
      capture: (capturedUrl, capturedOptions) => {
        url = capturedUrl
        options = capturedOptions
      },
    }),
  })

  const text = await backend.compress(request)
  assert.equal(text, "short")
  assert.equal(url, "http://127.0.0.1:8765/compress")
  assert.equal(options?.method, "POST")
  assert.deepEqual(JSON.parse(String(options?.body)), {
    text: request.text,
    rate: 0.6,
    model: "llmlingua-2",
    kind: "tool-result",
    tool: "read",
  })
})

test("accepts the compressed alias", async () => {
  const backend = createHttpCompressor({
    endpoint: "http://127.0.0.1:8765/compress",
    fetch: fakeFetch({ compressed: "alias" }),
  })
  assert.equal(await backend.compress(request), "alias")
})

test("rejects a non-2xx response", async () => {
  const backend = createHttpCompressor({
    endpoint: "http://127.0.0.1:8765/compress",
    fetch: fakeFetch({ error: "boom" }, { status: 503 }),
  })
  await assert.rejects(() => backend.compress(request), /compressor HTTP 503/)
})

test("rejects a response without non-empty text", async () => {
  const backend = createHttpCompressor({
    endpoint: "http://127.0.0.1:8765/compress",
    fetch: fakeFetch({ ok: true }),
  })
  await assert.rejects(() => backend.compress(request), /missing text/)
})
