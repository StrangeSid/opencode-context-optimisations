import assert from "node:assert/strict"
import { test } from "node:test"

import {
  extractProtectedLiterals,
  findMissingLiterals,
} from "../src/literals.ts"

test("extracts paths, URLs, numbers, line refs, and error codes", () => {
  const text =
    "Check src/context/compressor.ts and https://example.com/docs?x=1. " +
    "The failure is ECONNREFUSED on port 5433 at line 47; see src/index.ts:12 and TS2345."

  const literals = extractProtectedLiterals(text)
  assert.ok(literals.includes("src/context/compressor.ts"))
  assert.ok(literals.includes("https://example.com/docs?x=1"))
  assert.ok(literals.includes("5433"))
  assert.ok(literals.includes("line 47"))
  assert.ok(literals.includes("src/index.ts"))
  assert.ok(literals.includes(":12"))
  assert.ok(literals.includes("TS2345"))
})

test("reports literals dropped by compression", () => {
  const original = "Retry 7 times; do not edit src/legacy/parser.ts."
  const missing = findMissingLiterals(original, "Retry times do not edit legacy parser")

  assert.deepEqual(missing, ["src/legacy/parser.ts", "7"])
})

test("literal classes can be disabled", () => {
  const original = "Retry 7 times at src/legacy/parser.ts"
  const missing = findMissingLiterals(original, "Retry times at legacy parser", {
    includePaths: false,
    includeNumbers: false,
  })
  assert.deepEqual(missing, [])
})

test("a faithful compression has no missing literals", () => {
  const text = "Retry 7 times; do not edit src/legacy/parser.ts."
  assert.deepEqual(findMissingLiterals(text, text), [])
})
