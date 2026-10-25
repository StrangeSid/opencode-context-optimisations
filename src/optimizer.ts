/**
 * Orchestration for the request lane.
 *
 * This module is pure TypeScript. It adapts a V2 transcript, asks the policy
 * which spans are safe, compresses cache misses through a caller-supplied
 * backend, applies successful replacements in place, and returns measurable
 * stats. It never throws on a backend failure: a failed or slow compression
 * leaves the original text untouched.
 */

import { estimateTokens } from "./classify.ts"
import {
  findMissingLiterals,
  type LiteralOptions,
} from "./literals.ts"
import {
  selectLlmlinguaCandidates,
  type SelectionOptions,
} from "./policy.ts"
import {
  applyV2Replacements,
  policySpanKey,
  toPolicyTranscript,
  type V2Message,
  type V2Replacement,
  type V2TextSpan,
} from "./v2.ts"

export interface CompressionRequest {
  text: string
  rate: number
  modelId: string
  kind: "text" | "tool-result"
  /** Stable content key from the policy; useful for backend-side caching. */
  cacheKey: string
  toolName?: string
}

export interface CompressionBackend {
  compress(request: CompressionRequest): Promise<string>
}

export interface TextCache {
  get(key: string): string | undefined
  set(key: string, value: string): void
  readonly size: number
}

export interface OptimizerOptions extends SelectionOptions {
  /** Set false to skip the adapter/policy work entirely. Default true. */
  enabled?: boolean
  /** Per-candidate compression deadline. Default 1200 ms. */
  timeoutMs?: number
  /** LRU capacity when the caller does not supply a cache. Default 500. */
  cacheMaxEntries?: number
  /** Skip a result whose estimated size is at least this fraction of the input. Default 0.9. */
  maxCompressedRatio?: number
  /** Require paths, URLs, numbers, line references, and error codes to survive. Default true. */
  validateLiterals?: boolean
  /** Tune which literal classes are required. */
  literalOptions?: LiteralOptions
}

export interface OptimizerDeps {
  backend: CompressionBackend
  /** Reuse across hook invocations to get cache hits. */
  cache?: TextCache
  /** Optional per-key in-flight map shared across concurrent sessions. */
  inflight?: Map<string, Promise<string>>
  /**
   * Optional transform applied after validation. Used to append a retrieval
   * marker while leaving the raw compressed text in the cache.
   */
  onCompressed?: (event: {
    original: string
    compressed: string
    span: V2TextSpan
  }) => string
  now?: () => number
}

export interface OptimizerStats {
  enabled: boolean
  candidates: number
  compressed: number
  applied: number
  cacheHits: number
  failures: number
  skipped: number
  literalRejects: number
  rejected: number
  selectedTokens: number
  savedTokens: number
  latencyMs: number
  protectedFromIndex: number
}

const DEFAULT_TIMEOUT_MS = 1200
const DEFAULT_CACHE_ENTRIES = 500
const DEFAULT_MAX_COMPRESSED_RATIO = 0.9
const DEFAULT_RATE = 0.6
const DEFAULT_MODEL_ID = "llmlingua-2"

function resolveTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS
  }
  return Math.max(1, Math.floor(value))
}

function resolveCacheEntries(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CACHE_ENTRIES
  }
  return Math.max(0, Math.floor(value))
}

function resolveMaxCompressedRatio(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    return DEFAULT_MAX_COMPRESSED_RATIO
  }
  return value
}

function resolveRate(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    return DEFAULT_RATE
  }
  return value
}

function resolveModelId(value: string | undefined): string {
  return typeof value === "string" && value.trim().length > 0 ? value : DEFAULT_MODEL_ID
}

/**
 * Small insertion-ordered LRU. A limit of zero disables caching.
 */
export function createLruCache(maxEntries: number): TextCache {
  const limit = resolveCacheEntries(maxEntries)
  const entries = new Map<string, string>()

  return {
    get(key: string): string | undefined {
      const value = entries.get(key)
      if (value === undefined) return undefined
      entries.delete(key)
      entries.set(key, value)
      return value
    },
    set(key: string, value: string): void {
      if (limit === 0) return
      if (entries.has(key)) entries.delete(key)
      entries.set(key, value)
      while (entries.size > limit) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
    },
    get size(): number {
      return entries.size
    },
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("compression timed out"))
    }, timeoutMs)
    timer.unref?.()

    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function emptyStats(enabled: boolean, protectedFromIndex = 0): OptimizerStats {
  return {
    enabled,
    candidates: 0,
    compressed: 0,
    applied: 0,
    cacheHits: 0,
    failures: 0,
    skipped: 0,
    literalRejects: 0,
    rejected: 0,
    selectedTokens: 0,
    savedTokens: 0,
    latencyMs: 0,
    protectedFromIndex,
  }
}

/**
 * Process one outgoing request.
 *
 * The input messages are mutated only for spans that the policy approved and
 * the backend compressed successfully. Everything else stays byte-identical.
 */
export async function optimizeTranscript(
  messages: readonly V2Message[],
  options: OptimizerOptions,
  deps: OptimizerDeps,
): Promise<OptimizerStats> {
  const now = deps.now ?? Date.now
  const started = now()

  if (options.enabled === false) {
    return emptyStats(false)
  }

  const transcript = toPolicyTranscript(messages)
  const selection = selectLlmlinguaCandidates(transcript.messages, options)
  const cache = deps.cache ?? createLruCache(resolveCacheEntries(options.cacheMaxEntries))
  const inflight = deps.inflight ?? new Map<string, Promise<string>>()
  const timeoutMs = resolveTimeout(options.timeoutMs)
  const maxCompressedRatio = resolveMaxCompressedRatio(options.maxCompressedRatio)
  const rate = resolveRate(options.rate)
  const modelId = resolveModelId(options.modelId)

  let compressed = 0
  let cacheHits = 0
  let failures = 0
  let skipped = 0
  let literalRejects = 0
  let savedTokens = 0
  const replacements: V2Replacement[] = []

  for (const candidate of selection.candidates) {
    const span: V2TextSpan | undefined = transcript.byPolicyPart.get(
      policySpanKey(candidate.messageIndex, candidate.partIndex ?? -1),
    )
    if (!span) {
      skipped += 1
      continue
    }

    let text: string | undefined = cache.get(candidate.cacheKey)

    if (text !== undefined && text.trim().length === 0) {
      // A custom cache could return an invalid value; never apply it.
      skipped += 1
      continue
    }

    if (text !== undefined) {
      cacheHits += 1
    } else {
      let pending = inflight.get(candidate.cacheKey)
      const ownsRequest = pending === undefined

      if (!pending) {
        pending = Promise.resolve().then(() =>
          deps.backend.compress({
            text: candidate.text,
            rate,
            modelId,
            kind: span.source.kind === "text" ? "text" : "tool-result",
            cacheKey: candidate.cacheKey,
            ...(span.toolName ? { toolName: span.toolName } : {}),
          }),
        )
        inflight.set(candidate.cacheKey, pending)
      }

      try {
        text = await withTimeout(pending, timeoutMs)
        if (typeof text !== "string" || text.trim().length === 0) {
          throw new Error("compressor returned empty text")
        }
      } catch {
        failures += 1
        continue
      } finally {
        if (ownsRequest) inflight.delete(candidate.cacheKey)
      }
    }

    if (text === undefined) {
      skipped += 1
      continue
    }

    if (options.validateLiterals !== false) {
      const missing = findMissingLiterals(
        candidate.text,
        text,
        options.literalOptions,
      )
      if (missing.length > 0) {
        literalRejects += 1
        skipped += 1
        continue
      }
    }

    const annotated = deps.onCompressed
      ? deps.onCompressed({
          original: candidate.text,
          compressed: text,
          span,
        })
      : text

    if (annotated.trim().length === 0) {
      skipped += 1
      continue
    }

    const finalTokens = estimateTokens(annotated)
    if (finalTokens >= Math.ceil(candidate.tokens * maxCompressedRatio)) {
      skipped += 1
      continue
    }

    cache.set(candidate.cacheKey, text)
    replacements.push({ span, text: annotated })
    compressed += 1
    savedTokens += Math.max(0, candidate.tokens - finalTokens)
  }

  const applied = applyV2Replacements(messages, replacements)

  return {
    enabled: true,
    candidates: selection.candidates.length,
    compressed,
    applied,
    cacheHits,
    failures,
    skipped,
    literalRejects,
    rejected: selection.rejected.length,
    selectedTokens: selection.selectedTokens,
    savedTokens,
    latencyMs: now() - started,
    protectedFromIndex: selection.protectedFromIndex,
  }
}
