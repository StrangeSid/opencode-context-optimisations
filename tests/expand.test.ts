import assert from "node:assert/strict"
import { test } from "node:test"

import { createExpandAnnotator, createExpandStore } from "../src/expand.ts"

test("stores originals under deterministic handles", () => {
  const store = createExpandStore()
  const first = store.add("the original text")
  const second = store.add("the original text")

  assert.ok(first)
  assert.equal(first, second)
  assert.equal(store.get(first ?? ""), "the original text")
  assert.equal(store.size, 1)
  assert.equal(store.chars, "the original text".length)
})

test("unknown handles and oversized texts are rejected", () => {
  const store = createExpandStore({ maxChars: 10 })
  assert.equal(store.get("ctx_missing"), undefined)
  assert.equal(store.add("x".repeat(11)), undefined)
})

test("search returns matching lines with line numbers", () => {
  const store = createExpandStore()
  const handle = store.add("alpha\nbeta error: ECONNREFUSED\ngamma")
  assert.ok(handle)
  assert.equal(
    store.search(handle ?? "", "econnrefused"),
    "L2: beta error: ECONNREFUSED",
  )
  assert.match(store.search(handle ?? "", "missing") ?? "", /No line matched/)
  assert.equal(store.search(handle ?? ""), "alpha\nbeta error: ECONNREFUSED\ngamma")
})

test("LRU eviction removes the oldest entry", () => {
  const store = createExpandStore({ maxEntries: 1 })
  const first = store.add("first")
  const second = store.add("second")

  assert.ok(first)
  assert.ok(second)
  assert.equal(store.get(first ?? ""), undefined)
  assert.equal(store.get(second ?? ""), "second")
  assert.equal(store.size, 1)
})

test("annotator appends a deterministic retrieval marker", () => {
  const store = createExpandStore()
  const annotate = createExpandAnnotator(store)
  const first = annotate({ original: "long original prose", compressed: "short prose" })
  const second = annotate({ original: "long original prose", compressed: "short prose" })

  assert.equal(first, second)
  assert.match(first, /^short prose\n\[ctx_expand:ctx_[0-9a-f]+\]$/)
  const handle = first.match(/ctx_expand:(ctx_[0-9a-f]+)/)?.[1]
  assert.ok(handle)
  assert.equal(store.get(handle ?? ""), "long original prose")
})
