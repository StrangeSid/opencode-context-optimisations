import assert from "node:assert/strict"
import { test } from "node:test"

import { classifyText, estimateTokens, isTokenCompressible } from "../src/classify.ts"

const prose = `The build failed because the TypeScript compiler could not resolve the module. I checked the configuration and module resolution was set to bundler, which should work. The failure only happens in the test package, where the same import is resolved from a different root. I tried clearing the dependency cache and reinstalling, but the error persisted. Next I will inspect the package exports map and the compiled output.`

const typescript = `import { readFile } from "node:fs/promises"
import path from "node:path"

export async function loadConfig(dir: string): Promise<Config> {
  const file = path.join(dir, "config.json")
  const raw = await readFile(file, "utf8")
  const parsed = JSON.parse(raw)
  if (!parsed.version || parsed.version !== 2) {
    throw new Error(\`unsupported config version \${parsed.version}\`)
  }
  return { ...parsed, file }
}
`

const log = `2026-10-22T09:12:00.000Z INFO  build    [01/64] compiling src/features/context/module_00.ts
2026-10-22T09:12:01.037Z DEBUG esbuild  resolve ../../packages/shared/src/tokens.ts
2026-10-22T09:12:02.000Z WARN  deprecated inflight@1.0.6
2026-10-22T09:12:03.000Z ERROR src/context/telemetry.ts(47,10): error TS2345
    at compressPrompt (src/context/compressor.ts:48:11)
PASS tests/context.test.ts
FAIL tests/parser.test.ts`

const diff = `diff --git a/src/index.ts b/src/index.ts
index 1234567..89abcde 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
-export const version = 1
+export const version = 2
+export const stable = true`

test("classifies prose as compressible", () => {
  const result = classifyText(prose)
  assert.equal(result.kind, "prose")
  assert.equal(isTokenCompressible(result), true)
})

test("classifies TypeScript as code and refuses token compression", () => {
  const result = classifyText(typescript)
  assert.equal(result.kind, "code")
  assert.equal(isTokenCompressible(result), false)
})

test("classifies build output as logs", () => {
  const result = classifyText(log)
  assert.equal(result.kind, "log")
  assert.equal(isTokenCompressible(result), false)
})

test("classifies unified diffs", () => {
  const result = classifyText(diff)
  assert.equal(result.kind, "diff")
  assert.equal(isTokenCompressible(result), false)
})

test("classifies JSON objects and arrays", () => {
  assert.equal(classifyText('{"a":1,"b":[2,3]}').kind, "json")
  assert.equal(classifyText('[{"path":"src/index.ts"}]').kind, "json")
  assert.equal(isTokenCompressible(classifyText('{"a":1}')), false)
})

test("refuses prose with heavy path density", () => {
  const result = classifyText(
    "Changed src/a.ts, src/b.ts and packages/core/src/c.ts. Then updated /workspace/proj/config.json and ./scripts/build.mjs.",
  )
  assert.equal(result.kind, "unknown")
  assert.equal(isTokenCompressible(result), false)
})

test("treats fenced code inside prose as non-compressible", () => {
  const text = `Here is the failing code:\n\n\`\`\`ts\nconst value = parse(input)\nif (!value) throw new Error("bad")\n\`\`\`\n\nIt fails when the input is empty.`
  const result = classifyText(text)
  assert.equal(result.kind, "code")
  assert.equal(isTokenCompressible(result), false)
})

test("blank input is empty", () => {
  assert.equal(classifyText("   \n").kind, "empty")
  assert.equal(estimateTokens(""), 0)
})

test("token estimate is monotonic and handles CJK", () => {
  assert.ok(estimateTokens(prose.repeat(2)) > estimateTokens(prose))
  assert.ok(estimateTokens("日本語のテキスト") > 0)
})
