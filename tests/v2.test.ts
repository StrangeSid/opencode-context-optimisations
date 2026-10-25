import assert from "node:assert/strict"
import { test } from "node:test"

import type { TextPart } from "../src/policy.ts"
import { selectLlmlinguaCandidates } from "../src/policy.ts"
import {
  applyV2Replacements,
  policySpanKey,
  toPolicyTranscript,
  type V2ContentPart,
  type V2Message,
  type V2ToolResult,
} from "../src/v2.ts"

const prose = `The build failed because the TypeScript compiler could not resolve the module. I checked the configuration and module resolution was set to bundler, which should work. The failure only happens in the test package, where the same import is resolved from a different root. I tried clearing the dependency cache and reinstalling, but the error persisted. Next I will inspect the package exports map and the compiled output.`

function fixture(): V2Message[] {
  return [
    {
      id: "m1",
      role: "assistant",
      content: [
        { type: "text", text: prose },
        { type: "tool-call", id: "call-1", name: "read", input: { path: "src/a.ts" } },
        {
          type: "tool-result",
          id: "call-1",
          name: "read",
          result: { type: "text", value: prose },
        },
        {
          type: "tool-result",
          id: "call-2",
          name: "bash",
          result: { type: "error", value: "Error: build failed at src/a.ts:4" },
        },
        {
          type: "tool-result",
          id: "call-3",
          name: "api",
          result: { type: "json", value: { ok: true, path: "src/a.ts" } },
        },
        {
          type: "tool-result",
          id: "call-4",
          name: "fetch",
          result: {
            type: "content",
            value: [
              { type: "text", text: prose },
              { type: "file", uri: "file:///tmp/spec.md", mime: "text/markdown" },
            ],
          },
        },
        { type: "reasoning", text: prose },
        { type: "media", media: {} },
      ],
    },
    {
      role: "user",
      content: [{ type: "text", text: "current request" }],
    },
  ] as unknown as V2Message[]
}

test("adapter extracts text, tool-result text, error, JSON, and content text", () => {
  const transcript = toPolicyTranscript(fixture())

  assert.equal(transcript.messages.length, 2)
  assert.equal(transcript.spans.length, 6)

  const parts = transcript.messages[0].content as TextPart[]
  assert.deepEqual(
    parts.map((part) => part.text),
    [prose, prose, "Error: build failed at src/a.ts:4", '{"ok":true,"path":"src/a.ts"}', prose],
  )
  assert.deepEqual(
    parts.map((part) => part.protected === true),
    [false, false, true, true, false],
  )

  assert.deepEqual(
    transcript.spans.map((span) => span.source),
    [
      { kind: "text", partIndex: 0 },
      { kind: "tool-result", partIndex: 2, resultType: "text" },
      { kind: "tool-result", partIndex: 3, resultType: "error" },
      { kind: "tool-result", partIndex: 4, resultType: "json" },
      { kind: "tool-result", partIndex: 5, resultType: "content", contentIndex: 0 },
      { kind: "text", partIndex: 0 },
    ],
  )
  assert.equal(transcript.byPolicyPart.get(policySpanKey(0, 4))?.source.kind, "tool-result")
  assert.equal(transcript.messages[0].id, "m1")
})

test("policy selects unprotected prose and rejects protected error/JSON spans", () => {
  const transcript = toPolicyTranscript(fixture())
  const result = selectLlmlinguaCandidates(transcript.messages, {
    minTokens: 1,
    budgetTokens: 100_000,
  })

  assert.deepEqual(
    result.candidates.map((candidate) => policySpanKey(candidate.messageIndex, candidate.partIndex ?? -1)),
    ["0:0", "0:1", "0:4"],
  )
  assert.ok(
    result.rejected.some(
      (item) =>
        item.messageIndex === 0 &&
        item.partIndex === 2 &&
        item.reason === "content" &&
        item.detail === "protected",
    ),
  )
  assert.ok(
    result.rejected.some(
      (item) =>
        item.messageIndex === 0 &&
        item.partIndex === 3 &&
        item.reason === "content" &&
        item.detail === "protected",
    ),
  )
})

test("replacements write back to the exact text and tool-result spans", () => {
  const messages = fixture()
  const transcript = toPolicyTranscript(messages)

  const applied = applyV2Replacements(messages, [
    { span: transcript.spans[0], text: "compressed text" },
    { span: transcript.spans[1], text: "compressed tool text" },
    { span: transcript.spans[4], text: "compressed content text" },
  ])

  assert.equal(applied, 3)

  const content = messages[0].content as V2ContentPart[]
  assert.equal(content[0].text, "compressed text")
  assert.equal((content[2].result as V2ToolResult).value, "compressed tool text")
  assert.equal((content[3].result as V2ToolResult).value, "Error: build failed at src/a.ts:4")
  assert.deepEqual((content[4].result as V2ToolResult).value, {
    ok: true,
    path: "src/a.ts",
  })

  const entries = (content[5].result as V2ToolResult).value as Array<{
    type: string
    text?: string
  }>
  assert.equal(entries[0].text, "compressed content text")
  assert.equal(content[2].id, "call-1")
  assert.equal(content[2].name, "read")
})

test("string content is supported for legacy/test callers", () => {
  const messages: V2Message[] = [
    { role: "assistant", content: prose },
    { role: "user", content: "current request" },
  ]
  const transcript = toPolicyTranscript(messages)

  assert.equal(transcript.spans.length, 2)
  assert.equal(transcript.spans[0].source.kind, "text")
  assert.equal(applyV2Replacements(messages, [{ span: transcript.spans[0], text: "short" }]), 1)
  assert.equal(messages[0].content, "short")
})

test("messages without textual parts keep their indices", () => {
  const messages: V2Message[] = [
    { role: "assistant", content: [{ type: "reasoning", text: prose }] },
    { role: "user", content: [{ type: "text", text: "current request" }] },
  ]
  const transcript = toPolicyTranscript(messages)

  assert.equal(transcript.messages.length, 2)
  assert.equal((transcript.messages[0].content as TextPart[]).length, 0)
  assert.deepEqual(
    transcript.spans.map((span) => ({ messageIndex: span.messageIndex, index: span.policyPartIndex })),
    [{ messageIndex: 1, index: 0 }],
  )
})
