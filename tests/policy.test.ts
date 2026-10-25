import assert from "node:assert/strict"
import { test } from "node:test"

import { estimateTokens } from "../src/classify.ts"
import {
  selectLlmlinguaCandidates,
  type PolicyMessage,
  type SelectionOptions,
} from "../src/policy.ts"

const prose = `The build failed because the TypeScript compiler could not resolve the module. I checked the configuration and module resolution was set to bundler, which should work. The failure only happens in the test package, where the same import is resolved from a different root. I tried clearing the dependency cache and reinstalling, but the error persisted. Next I will inspect the package exports map and the compiled output.`

const longProse = `${prose} ${prose} ${prose} ${prose}`

const code = `import { readFile } from "node:fs/promises"
import path from "node:path"

export async function loadConfig(dir: string): Promise<Config> {
  const file = path.join(dir, "config.json")
  const raw = await readFile(file, "utf8")
  return JSON.parse(raw)
}`

const log = `2026-10-22T09:12:00.000Z INFO  build    [01/64] compiling src/features/context/module_00.ts
2026-10-22T09:12:01.037Z DEBUG esbuild  resolve ../../packages/shared/src/tokens.ts
2026-10-22T09:12:02.000Z WARN  deprecated inflight@1.0.6
2026-10-22T09:12:03.000Z ERROR src/context/telemetry.ts(47,10): error TS2345
    at compressPrompt (src/context/compressor.ts:48:11)
PASS tests/context.test.ts
FAIL tests/parser.test.ts`

const json = JSON.stringify({ path: "src/index.ts", tokens: 1234, nested: { ok: true } }, null, 2)

const diff = `diff --git a/src/index.ts b/src/index.ts
index 1234567..89abcde 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
-export const version = 1
+export const version = 2
+export const stable = true`

function message(
  role: string,
  content: string | Array<{ type: string; text?: string; protected?: boolean }>,
): PolicyMessage {
  return { role, content }
}

function select(messages: PolicyMessage[], options: SelectionOptions = {}) {
  return selectLlmlinguaCandidates(messages, {
    minTokens: 1,
    budgetTokens: 100_000,
    ...options,
  })
}

test("selects old assistant prose but protects the last two user turns", () => {
  const messages = [
    message("assistant", longProse),
    message("user", "first request"),
    message("assistant", "working on it"),
    message("user", "second request"),
    message("assistant", "still working"),
    message("user", "current request"),
    message("tool", '{"ok":true}'),
  ]

  const result = select(messages)
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.messageIndex),
    [0],
  )
  assert.equal(result.protectedFromIndex, 3)
  assert.ok(result.rejected.some((item) => item.reason === "recent"))
})

test("protectedTurns=1 frees the previous turn but keeps the current one", () => {
  const messages = [
    message("assistant", longProse),
    message("user", "previous request"),
    message("assistant", longProse),
    message("user", "current request"),
  ]

  const result = select(messages, { protectedTurns: 1 })
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.messageIndex),
    [0, 2],
  )
  assert.equal(result.protectedFromIndex, 3)
})

test("never selects system messages", () => {
  const messages = [message("system", longProse), message("user", "current")]
  const result = select(messages)
  assert.equal(result.candidates.length, 0)
  assert.ok(result.rejected.some((item) => item.reason === "system"))
})

test("rejects code, logs, JSON, and diffs", () => {
  const messages = [
    message("assistant", code),
    message("tool", log),
    message("tool", json),
    message("assistant", diff),
    message("user", "current"),
  ]

  const result = select(messages)
  assert.equal(result.candidates.length, 0)
  assert.deepEqual(
    result.rejected.filter((item) => item.reason === "content").map((item) => item.detail),
    ["code", "log", "json", "diff"],
  )
})

test("selects old tool prose but rejects old tool logs", () => {
  const messages = [
    message("tool", longProse),
    message("tool", log),
    message("user", "current"),
    message("tool", longProse),
  ]

  const result = select(messages)
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.messageIndex),
    [0],
  )
  assert.ok(
    result.rejected.some(
      (item) => item.messageIndex === 1 && item.reason === "content" && item.detail === "log",
    ),
  )
})

test("old user prose is opt-in", () => {
  const messages = [
    message("user", longProse),
    message("assistant", "ack"),
    message("user", "middle request"),
    message("assistant", "ack"),
    message("user", "current request"),
  ]

  assert.equal(select(messages).candidates.length, 0)
  const withUser = select(messages, { allowUserProse: true })
  assert.deepEqual(
    withUser.candidates.map((candidate) => candidate.messageIndex),
    [0],
  )
})

test("budget is spent oldest-first and oversized candidates are skipped", () => {
  const old = longProse
  const newer = `${longProse} ${longProse}`
  const messages = [
    message("assistant", newer),
    message("user", "old request"),
    message("assistant", old),
    message("user", "middle request"),
    message("assistant", "ack"),
    message("user", "current request"),
  ]

  const budget = estimateTokens(old) + 10
  const result = select(messages, { budgetTokens: budget })
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.messageIndex),
    [2],
  )
  assert.ok(result.selectedTokens <= budget)
  assert.ok(result.rejected.some((item) => item.reason === "budget"))
})

test("short prose is rejected by the minimum token gate", () => {
  const messages = [message("assistant", prose), message("user", "current")]
  const result = selectLlmlinguaCandidates(messages, { minTokens: 10_000 })
  assert.equal(result.candidates.length, 0)
  assert.ok(result.rejected.some((item) => item.reason === "small"))
})

test("multipart content selects only text parts", () => {
  const messages = [
    message("assistant", [
      { type: "text", text: longProse },
      { type: "tool-call", text: "not text" },
      { type: "reasoning", text: longProse },
    ]),
    message("user", "current"),
  ]

  const result = select(messages)
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].partIndex, 0)
})

test("cache keys are stable and sensitive to text and rate", () => {
  const messages = [message("assistant", longProse), message("user", "current")]

  const first = select(messages).candidates[0].cacheKey
  const second = select(messages).candidates[0].cacheKey
  const otherRate = select(messages, { rate: 0.8 }).candidates[0].cacheKey
  const invalidRate = select(messages, { rate: 2 }).candidates[0].cacheKey
  const otherText = select([
    message("assistant", `${longProse} Extra sentence.`),
    message("user", "current"),
  ]).candidates[0].cacheKey

  assert.equal(first, second)
  assert.equal(first, invalidRate)
  assert.notEqual(first, otherRate)
  assert.notEqual(first, otherText)
  assert.match(first, /^[0-9a-f]{64}$/)
})

test("a transcript without user messages protects everything", () => {
  const messages = [message("system", longProse), message("assistant", longProse)]
  const result = select(messages)
  assert.equal(result.candidates.length, 0)
  assert.equal(result.protectedFromIndex, 0)
})

test("protected parts are rejected before classification", () => {
  const messages = [
    message("assistant", [{ type: "text", text: longProse, protected: true }]),
    message("user", "current"),
  ]

  const result = select(messages)
  assert.equal(result.candidates.length, 0)
  assert.ok(
    result.rejected.some(
      (item) => item.reason === "content" && item.detail === "protected",
    ),
  )
})

test("NaN protectedTurns falls back to the safe default", () => {
  const messages = [message("assistant", longProse), message("user", "current")]
  const withNaN = select(messages, { protectedTurns: Number.NaN })
  const withDefault = select(messages)

  assert.deepEqual(withNaN, withDefault)
  assert.equal(withNaN.protectedFromIndex, 1)
  assert.equal(withNaN.candidates.length, 1)
})

test("NaN minTokens falls back to the default gate", () => {
  const messages = [message("assistant", prose), message("user", "current")]
  const result = selectLlmlinguaCandidates(messages, { minTokens: Number.NaN })

  assert.equal(result.candidates.length, 0)
  assert.ok(result.rejected.some((item) => item.reason === "small"))
})
