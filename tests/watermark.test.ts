import assert from "node:assert/strict"
import { test } from "node:test"

import { estimateTokens } from "../src/classify.ts"
import type { V2Message } from "../src/v2.ts"
import { estimateRequestTokens, evaluateWatermark } from "../src/watermark.ts"

const messages: V2Message[] = [
  { role: "assistant", content: [{ type: "text", text: "old narration" }] },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        id: "call-1",
        name: "read",
        input: { path: "src/index.ts", options: { lines: 100 } },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        id: "call-1",
        name: "read",
        result: { type: "text", value: "tool output text" },
      },
    ],
  },
  { role: "user", content: [{ type: "text", text: "current request" }] },
]

test("request estimation counts system, tools, messages, and tool inputs", () => {
  const bare = estimateRequestTokens({ messages })
  const withSystem = estimateRequestTokens({
    system: [{ text: "system instructions" }],
    messages,
  })
  const withTools = estimateRequestTokens({
    tools: { read: { description: "read a file", input: { type: "object" } } },
    messages,
  })

  assert.ok(bare > 0)
  assert.ok(withSystem > bare)
  assert.ok(withTools > bare)
  assert.ok(bare >= estimateTokens("tool output text"))
})

test("watermark compares estimated usage to the usable context", () => {
  const below = evaluateWatermark(600, 100_000, { outputReserveTokens: 15_000 })
  const above = evaluateWatermark(60_000, 100_000, { outputReserveTokens: 15_000 })

  assert.equal(below?.shouldCompress, false)
  assert.equal(above?.shouldCompress, true)
  assert.equal(above?.reserveTokens, 15_000)
  assert.equal(above?.usableTokens, 85_000)
})

test("watermark honors the threshold and explicit reserve", () => {
  assert.equal(
    evaluateWatermark(700, 1000, { outputReserveTokens: 0, highRatio: 0.7 })
      ?.shouldCompress,
    true,
  )
  assert.equal(
    evaluateWatermark(699, 1000, { outputReserveTokens: 0, highRatio: 0.7 })
      ?.shouldCompress,
    false,
  )
  assert.equal(
    evaluateWatermark(700, 1000, { outputReserveTokens: 300 })
      ?.shouldCompress,
    true,
  )
})

test("invalid limits or thresholds fall back safely", () => {
  assert.equal(evaluateWatermark(100, 0), undefined)
  assert.equal(evaluateWatermark(100, Number.NaN), undefined)
  const decision = evaluateWatermark(100, 100_000, { highRatio: Number.NaN })
  assert.equal(decision?.threshold, 0.7)
})
