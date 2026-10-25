/**
 * Adapter between OpenCode V2 messages and the compression policy.
 *
 * V2 messages are class instances with a content-part array. Tool output is not
 * a plain text part: it lives in a tagged ToolResultValue. This module flattens
 * every eligible textual span into a PolicyMessage while retaining a precise
 * source pointer so a later replacement can put the compressed text back in the
 * right place without touching IDs, tool-call pairing, or non-text parts.
 *
 * The types are deliberately structural rather than importing @opencode/ai.
 * That keeps the policy and optimizer usable in tests and in non-OpenCode
 * callers, and avoids a hard runtime dependency on the host package.
 */

import type { PolicyMessage, TextPart } from "./policy.ts"

export interface V2ToolResult {
  type: string
  value?: unknown
}

export interface V2ContentPart {
  type: string
  text?: string | null
  id?: string
  name?: string
  namespace?: string
  input?: unknown
  result?: V2ToolResult
}

export interface V2Message {
  role: string
  content?: string | readonly V2ContentPart[]
  id?: string
}

export type V2TextSource =
  | { kind: "text"; partIndex: number }
  | {
      kind: "tool-result"
      partIndex: number
      resultType: "text" | "json" | "error" | "content"
      contentIndex?: number
    }

export interface V2TextSpan {
  messageIndex: number
  /** Index in the synthetic PolicyMessage content array, not the V2 part index. */
  policyPartIndex: number
  source: V2TextSource
  protected: boolean
  toolName?: string
}

export interface V2Transcript {
  messages: PolicyMessage[]
  spans: V2TextSpan[]
  byPolicyPart: Map<string, V2TextSpan>
}

export function policySpanKey(messageIndex: number, policyPartIndex: number): string {
  return `${messageIndex}:${policyPartIndex}`
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined) return ""
  if (value === null) return "null"
  if (typeof value === "object") {
    try {
      const encoded = JSON.stringify(value)
      if (typeof encoded === "string") return encoded
    } catch {
      // Fall through to String(); a cyclic object is not worth failing over.
    }
  }
  return String(value)
}

function contentTextEntries(value: unknown): Array<{ contentIndex: number; text: string }> {
  if (!Array.isArray(value)) return []
  const entries: Array<{ contentIndex: number; text: string }> = []
  value.forEach((entry, contentIndex) => {
    if (
      entry &&
      typeof entry === "object" &&
      (entry as { type?: unknown }).type === "text" &&
      typeof (entry as { text?: unknown }).text === "string"
    ) {
      entries.push({ contentIndex, text: (entry as { text: string }).text })
    }
  })
  return entries
}

/**
 * Convert V2 messages into policy messages plus source spans.
 *
 * Every input message produces exactly one output message (even if it has no
 * textual parts) so messageIndex remains meaningful to the caller.
 */
export function toPolicyTranscript(messages: readonly V2Message[]): V2Transcript {
  const policyMessages: PolicyMessage[] = []
  const spans: V2TextSpan[] = []
  const byPolicyPart = new Map<string, V2TextSpan>()

  messages.forEach((message, messageIndex) => {
    const policyContent: TextPart[] = []

    const add = (
      text: string,
      source: V2TextSource,
      protectedText: boolean,
      toolName?: string,
    ): void => {
      if (!text) return
      const policyPartIndex = policyContent.length
      const part: TextPart = { type: "text", text }
      if (protectedText) part.protected = true
      policyContent.push(part)

      const span: V2TextSpan = {
        messageIndex,
        policyPartIndex,
        source,
        protected: protectedText,
      }
      if (toolName) span.toolName = toolName
      spans.push(span)
      byPolicyPart.set(policySpanKey(messageIndex, policyPartIndex), span)
    }

    if (typeof message.content === "string") {
      add(message.content, { kind: "text", partIndex: 0 }, false)
    } else if (Array.isArray(message.content)) {
      message.content.forEach((part, partIndex) => {
        if (!part || typeof part !== "object") return

        if (part.type === "text" && typeof part.text === "string") {
          add(part.text, { kind: "text", partIndex }, false)
          return
        }

        if (part.type !== "tool-result" || !part.result) return
        const result = part.result
        const toolName = typeof part.name === "string" ? part.name : undefined

        if (result.type === "text") {
          add(
            stringifyValue(result.value),
            { kind: "tool-result", partIndex, resultType: "text" },
            false,
            toolName,
          )
          return
        }

        if (result.type === "json") {
          // JSON is never token compressed; protected makes that explicit even
          // if the classifier would otherwise see prose inside a JSON string.
          add(
            stringifyValue(result.value),
            { kind: "tool-result", partIndex, resultType: "json" },
            true,
            toolName,
          )
          return
        }

        if (result.type === "error") {
          // Errors are exact diagnostics; they are visible to stats but can
          // never become compression candidates.
          add(
            stringifyValue(result.value),
            { kind: "tool-result", partIndex, resultType: "error" },
            true,
            toolName,
          )
          return
        }

        if (result.type === "content") {
          for (const entry of contentTextEntries(result.value)) {
            add(
              entry.text,
              {
                kind: "tool-result",
                partIndex,
                resultType: "content",
                contentIndex: entry.contentIndex,
              },
              false,
              toolName,
            )
          }
        }
      })
    }

    const policyMessage: PolicyMessage = {
      role: message.role,
      content: policyContent,
    }
    if (typeof message.id === "string") policyMessage.id = message.id
    policyMessages.push(policyMessage)
  })

  return { messages: policyMessages, spans, byPolicyPart }
}

export interface V2Replacement {
  span: V2TextSpan
  text: string
}

/**
 * Apply compressed text to the exact source span. Changes are transient: V2
 * history is rebuilt for every model call, so callers must reapply them.
 *
 * Returns the number of spans that were actually replaced.
 */
export function applyV2Replacements(
  messages: readonly V2Message[],
  replacements: Iterable<V2Replacement>,
): number {
  let applied = 0

  for (const { span, text } of replacements) {
    const message = messages[span.messageIndex]
    if (!message) continue
    const source = span.source

    if (source.kind === "text") {
      if (typeof message.content === "string") {
        message.content = text
        applied += 1
        continue
      }
      if (!Array.isArray(message.content)) continue
      const part = message.content[source.partIndex]
      if (part && part.type === "text") {
        part.text = text
        applied += 1
      }
      continue
    }

    if (!Array.isArray(message.content)) continue
    const part = message.content[source.partIndex]
    if (!part || part.type !== "tool-result" || !part.result) continue
    const result = part.result

    if (source.resultType === "text" && result.type === "text") {
      result.value = text
      applied += 1
      continue
    }

    if (source.resultType === "content" && result.type === "content") {
      if (source.contentIndex === undefined || !Array.isArray(result.value)) continue
      const entry = result.value[source.contentIndex]
      if (
        entry &&
        typeof entry === "object" &&
        (entry as { type?: unknown }).type === "text" &&
        typeof (entry as { text?: unknown }).text === "string"
      ) {
        const target = entry as { text: string }
        target.text = text
        applied += 1
      }
    }
  }

  return applied
}
