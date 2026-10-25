/**
 * Structural helpers for incremental tool-result compression.
 *
 * A V2 tool result can carry a plain string, a content array with text and
 * file entries, or a structured output. Only a single textual slot is replaced;
 * file attachments, metadata, and tool identity are preserved.
 */

export interface ToolTextEntry {
  type: string
  text?: string
  uri?: string
  mime?: string
  name?: string
}

export interface ToolResultLike {
  content?: string | readonly ToolTextEntry[]
  output?: unknown
  metadata?: unknown
}

export interface ToolTextSlot {
  text: string
  /** The index in a content array, or undefined for string content/output. */
  contentIndex?: number
  apply(result: ToolResultLike, text: string): ToolResultLike
}

function textEntries(content: readonly ToolTextEntry[]): Array<{ index: number; text: string }> {
  const entries: Array<{ index: number; text: string }> = []
  content.forEach((entry, index) => {
    if (entry && entry.type === "text" && typeof entry.text === "string") {
      entries.push({ index, text: entry.text })
    }
  })
  return entries
}

/**
 * Select the longest textual payload. Returns undefined when the result has no
 * compressible text slot.
 */
export function findToolTextSlot(result: ToolResultLike): ToolTextSlot | undefined {
  if (typeof result.content === "string") {
    return {
      text: result.content,
      apply(nextResult, text) {
        return { ...nextResult, content: text }
      },
    }
  }

  if (Array.isArray(result.content)) {
    const entries = textEntries(result.content)
    if (entries.length > 0) {
      let chosen = entries[0]
      for (const entry of entries) {
        if (entry.text.length > chosen.text.length) chosen = entry
      }
      return {
        text: chosen.text,
        contentIndex: chosen.index,
        apply(nextResult, text) {
          const content = nextResult.content
          if (!Array.isArray(content)) return { ...nextResult, content: text }
          return {
            ...nextResult,
            content: content.map((entry, index) =>
              index === chosen.index ? { ...entry, text } : entry,
            ),
          }
        },
      }
    }
  }

  if (typeof result.output === "string") {
    return {
      text: result.output,
      apply(nextResult, text) {
        return { ...nextResult, output: text }
      },
    }
  }

  return undefined
}

/** Exact match or a trailing-* prefix from the protected-tool list. */
export function isProtectedTool(tool: string, protectedTools: readonly string[]): boolean {
  for (const candidate of protectedTools) {
    if (candidate.endsWith("*")) {
      if (tool.startsWith(candidate.slice(0, -1))) return true
    } else if (tool === candidate) {
      return true
    }
  }
  return false
}
