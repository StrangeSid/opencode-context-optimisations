import assert from "node:assert/strict"
import { test } from "node:test"

import {
  findToolTextSlot,
  isProtectedTool,
  type ToolResultLike,
} from "../src/tool-result.ts"

test("extracts a string content slot", () => {
  const result: ToolResultLike = { content: "long output" }
  const slot = findToolTextSlot(result)
  assert.equal(slot?.text, "long output")
  assert.deepEqual(slot?.apply(result, "short"), { content: "short" })
})

test("chooses the longest text entry and preserves files", () => {
  const result: ToolResultLike = {
    content: [
      { type: "text", text: "short" },
      { type: "file", uri: "file:///tmp/a.ts", mime: "text/plain" },
      { type: "text", text: "a much longer output" },
    ],
    metadata: { tool: "read" },
  }
  const slot = findToolTextSlot(result)
  assert.equal(slot?.text, "a much longer output")
  assert.deepEqual(slot?.apply(result, "compressed"), {
    content: [
      { type: "text", text: "short" },
      { type: "file", uri: "file:///tmp/a.ts", mime: "text/plain" },
      { type: "text", text: "compressed" },
    ],
    metadata: { tool: "read" },
  })
})

test("falls back to a string output", () => {
  const result: ToolResultLike = { output: "output text" }
  const slot = findToolTextSlot(result)
  assert.equal(slot?.text, "output text")
  assert.deepEqual(slot?.apply(result, "short"), { output: "short" })
})

test("returns undefined when there is no text slot", () => {
  assert.equal(findToolTextSlot({ output: { structured: true } }), undefined)
  assert.equal(findToolTextSlot({ content: [] }), undefined)
})

test("protected tool matching supports exact names and prefixes", () => {
  assert.equal(isProtectedTool("edit", ["edit", "write"]), true)
  assert.equal(isProtectedTool("read", ["edit", "write"]), false)
  assert.equal(isProtectedTool("plan_create", ["plan_*"]), true)
})
