/**
 * Reversible storage for compressed spans.
 *
 * The request lane only has an escape hatch if the model can ask for the
 * original text. We store originals by a deterministic content handle and
 * append a compact marker to the compressed text. The context_expand tool
 * resolves that marker or searches the stored text.
 */

import { createHash } from "node:crypto"

export interface ExpandStoreOptions {
  /** Maximum number of originals retained. Default 200. */
  maxEntries?: number
  /** Maximum total characters retained. Default 1,000,000. */
  maxChars?: number
  /** Maximum lines returned for a query search. Default 40. */
  maxQueryLines?: number
  /** Maximum characters returned by a single lookup. Default 20,000. */
  maxReturnChars?: number
}

export interface ExpandStore {
  /** Returns a handle, or undefined when the text is too large to store. */
  add(text: string): string | undefined
  get(handle: string): string | undefined
  search(handle: string, query?: string): string | undefined
  readonly size: number
  readonly chars: number
}

export type ReplacementAnnotator = (event: {
  original: string
  compressed: string
}) => string

const DEFAULT_MAX_ENTRIES = 200
const DEFAULT_MAX_CHARS = 1_000_000
const DEFAULT_MAX_QUERY_LINES = 40
const DEFAULT_MAX_RETURN_CHARS = 20_000

function positiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback
  }
  return Math.floor(value)
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + "\n...[truncated]"
}

export function createExpandStore(options: ExpandStoreOptions = {}): ExpandStore {
  const maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES)
  const maxChars = positiveInteger(options.maxChars, DEFAULT_MAX_CHARS)
  const maxQueryLines = positiveInteger(options.maxQueryLines, DEFAULT_MAX_QUERY_LINES)
  const maxReturnChars = positiveInteger(options.maxReturnChars, DEFAULT_MAX_RETURN_CHARS)

  const entries = new Map<string, { text: string; hash: string }>()
  let totalChars = 0

  const evict = (): void => {
    while (entries.size > maxEntries || totalChars > maxChars) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      const removed = entries.get(oldest)
      if (removed) totalChars -= removed.text.length
      entries.delete(oldest)
    }
  }

  const makeHandle = (hash: string): string => {
    for (const length of [12, 16, 24, 32, 64]) {
      const candidate = "ctx_" + hash.slice(0, length)
      const existing = entries.get(candidate)
      if (!existing || existing.hash === hash) return candidate
    }
    return ""
  }

  const lookup = (handle: string): string | undefined => {
    const entry = entries.get(handle)
    if (!entry) return undefined
    entries.delete(handle)
    entries.set(handle, entry)
    return entry.text
  }

  return {
    add(text: string): string | undefined {
      if (!text || text.length > maxChars) return undefined
      const hash = createHash("sha256").update(text).digest("hex")
      const handle = makeHandle(hash)
      if (!handle) return undefined
      const existing = entries.get(handle)
      if (existing) {
        // Refresh recency without changing the retained text.
        entries.delete(handle)
        entries.set(handle, existing)
        return handle
      }
      entries.set(handle, { text, hash })
      totalChars += text.length
      evict()
      return entries.has(handle) ? handle : undefined
    },

    get: lookup,

    search(handle: string, query?: string): string | undefined {
      const text = lookup(handle)
      if (text === undefined) return undefined
      const term = query?.trim()
      if (!term) return clip(text, maxReturnChars)

      const matches: string[] = []
      const lines = text.split(/\r?\n/)
      const lower = term.toLowerCase()
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].toLowerCase().includes(lower)) {
          matches.push("L" + (index + 1) + ": " + lines[index])
          if (matches.length >= maxQueryLines) break
        }
      }
      if (matches.length === 0) {
        return "No line matched " + JSON.stringify(term) + " in " + handle + "\n\n" + clip(text, maxReturnChars)
      }
      return clip(matches.join("\n"), maxReturnChars)
    },

    get size(): number {
      return entries.size
    },

    get chars(): number {
      return totalChars
    },
  }
}

/**
 * Create the optimizer callback that stores originals and appends a compact
 * retrieval marker. The marker is deterministic for identical original text.
 */
export function createExpandAnnotator(store: ExpandStore): ReplacementAnnotator {
  return ({ original, compressed }) => {
    const handle = store.add(original)
    if (!handle) return compressed
    return compressed + "\n[ctx_expand:" + handle + "]"
  }
}
