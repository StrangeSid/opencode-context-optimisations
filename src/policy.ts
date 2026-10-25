/**
 * Selection policy for the LLMLingua request lane.
 *
 * The compressor is allowed to see only *old, natural-language* text. Everything
 * else stays byte-identical: system prompts, tool schemas, the last N user
 * turns, code, diffs, JSON, logs, errors, and non-text parts.
 *
 * This module is pure and deterministic. It does not call LLMLingua and does not
 * mutate the transcript; it returns the candidate parts a caller may compress.
 */

import { createHash } from "node:crypto"

import {
  classifyText,
  estimateTokens,
  isTokenCompressible,
  type Classification,
} from "./classify.ts"

export interface TextPart {
  type: string
  text?: string
  /**
   * Set by a caller that has already decided this span must never be token
   * compressed (for example an error tool result). The policy rejects it
   * without consulting the classifier.
   */
  protected?: boolean
  [key: string]: unknown
}

export interface PolicyMessage {
  role: string
  content?: string | TextPart[]
  id?: string
  [key: string]: unknown
}

export interface SelectionOptions {
  /** Number of most recent user turns to keep verbatim. Minimum 1. Default 2. */
  protectedTurns?: number
  /** Do not bother with parts below this token estimate. Default 400. */
  minTokens?: number
  /** Upper bound for all selected candidates. Default 2000 tokens. */
  budgetTokens?: number
  /** Old user prose is off by default: it often contains requirements. */
  allowUserProse?: boolean
  /** Old tool prose (web pages, docs, search results) is eligible by default. */
  includeToolProse?: boolean
  /** Included in the cache key so a model/rate change cannot reuse stale output. */
  modelId?: string
  /** Included in the cache key. Default 0.6. */
  rate?: number
}

export type RejectReason =
  | "system"
  | "recent"
  | "role"
  | "non-text"
  | "content"
  | "small"
  | "budget"

export interface Candidate {
  messageIndex: number
  /** `null` when the message content is a plain string. */
  partIndex: number | null
  role: string
  text: string
  tokens: number
  /** User turns between this message and the current request. 0 = current turn. */
  ageTurns: number
  classification: Classification
  cacheKey: string
}

export interface RejectedPart {
  messageIndex: number
  partIndex: number | null
  reason: RejectReason
  detail?: string
}

export interface SelectionResult {
  candidates: Candidate[]
  rejected: RejectedPart[]
  /** Index of the first message in the protected tail, or messages.length. */
  protectedFromIndex: number
  selectedTokens: number
}

const POLICY_VERSION = "llmlingua-lane-v1"
const DEFAULT_PROTECTED_TURNS = 2
const DEFAULT_MIN_TOKENS = 400
const DEFAULT_BUDGET_TOKENS = 2000
const DEFAULT_RATE = 0.6
const DEFAULT_MODEL_ID = "llmlingua-2"

function cacheKey(text: string, modelId: string, rate: number): string {
  return createHash("sha256")
    .update(POLICY_VERSION)
    .update("\0")
    .update(modelId)
    .update("\0")
    .update(String(rate))
    .update("\0")
    .update(text)
    .digest("hex")
}

interface PolicyTextPart {
  partIndex: number | null
  text: string
  protected: boolean
}

function textParts(message: PolicyMessage): PolicyTextPart[] {
  if (typeof message.content === "string") {
    return [{ partIndex: null, text: message.content, protected: false }]
  }
  if (!Array.isArray(message.content)) return []

  const parts: PolicyTextPart[] = []
  message.content.forEach((part, partIndex) => {
    if (
      part &&
      typeof part === "object" &&
      part.type === "text" &&
      typeof part.text === "string"
    ) {
      parts.push({
        partIndex,
        text: part.text,
        protected: part.protected === true,
      })
    }
  })
  return parts
}

function userTurnBoundary(messages: PolicyMessage[], protectedTurns: number): number {
  const userIndexes: number[] = []
  messages.forEach((message, index) => {
    if (message.role === "user") userIndexes.push(index)
  })
  // No user turn means there is no safe "old" region: protect everything.
  if (userIndexes.length === 0) return 0
  const keep = Math.max(1, Math.floor(protectedTurns))
  return userIndexes[Math.max(0, userIndexes.length - keep)]
}

function resolveInteger(value: number | undefined, fallback: number, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.floor(value))
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
 * Select the parts that may be passed to LLMLingua.
 *
 * Candidates are returned oldest-first so a caller with a token budget spends it
 * on the least recent context. Rejections are returned for observability.
 *
 * Non-finite numeric options fall back to their defaults instead of disabling a
 * safety gate. This matters for NaN, where comparisons are always false.
 */
export function selectLlmlinguaCandidates(
  messages: PolicyMessage[],
  options: SelectionOptions = {},
): SelectionResult {
  // protectedTurns is allowed to be 1 as an explicit advanced override; the
  // documented default remains 2. A non-finite value falls back to the default.
  const protectedTurns = resolveInteger(
    options.protectedTurns,
    DEFAULT_PROTECTED_TURNS,
    1,
  )
  const minTokens = resolveInteger(options.minTokens, DEFAULT_MIN_TOKENS, 0)
  const budgetTokens = resolveInteger(options.budgetTokens, DEFAULT_BUDGET_TOKENS, 0)
  const allowUserProse = options.allowUserProse === true
  const includeToolProse = options.includeToolProse !== false
  const modelId = resolveModelId(options.modelId)
  const rate = resolveRate(options.rate)
  const protectedFromIndex = userTurnBoundary(messages, protectedTurns)

  const rejected: RejectedPart[] = []
  const eligible: Candidate[] = []

  messages.forEach((message, messageIndex) => {
    if (messageIndex >= protectedFromIndex) {
      for (const part of textParts(message)) {
        rejected.push({
          messageIndex,
          partIndex: part.partIndex,
          reason: "recent",
        })
      }
      return
    }

    if (message.role === "system") {
      for (const part of textParts(message)) {
        rejected.push({ messageIndex, partIndex: part.partIndex, reason: "system" })
      }
      return
    }

    if (message.role === "user" && !allowUserProse) {
      for (const part of textParts(message)) {
        rejected.push({ messageIndex, partIndex: part.partIndex, reason: "role" })
      }
      return
    }

    if (message.role === "tool" && !includeToolProse) {
      for (const part of textParts(message)) {
        rejected.push({ messageIndex, partIndex: part.partIndex, reason: "role" })
      }
      return
    }

    if (
      message.role !== "user" &&
      message.role !== "assistant" &&
      message.role !== "tool"
    ) {
      for (const part of textParts(message)) {
        rejected.push({ messageIndex, partIndex: part.partIndex, reason: "role" })
      }
      return
    }

    const parts = textParts(message)
    if (parts.length === 0) {
      rejected.push({ messageIndex, partIndex: null, reason: "non-text" })
      return
    }

    for (const part of parts) {
      if (part.protected) {
        rejected.push({
          messageIndex,
          partIndex: part.partIndex,
          reason: "content",
          detail: "protected",
        })
        continue
      }

      const classification = classifyText(part.text)
      if (!isTokenCompressible(classification)) {
        rejected.push({
          messageIndex,
          partIndex: part.partIndex,
          reason: "content",
          detail: classification.kind,
        })
        continue
      }

      const tokens = estimateTokens(part.text)
      if (tokens < minTokens) {
        rejected.push({
          messageIndex,
          partIndex: part.partIndex,
          reason: "small",
          detail: `${tokens} < ${minTokens}`,
        })
        continue
      }

      // Age is the number of user turns after this message. The current turn is
      // already excluded by protectedFromIndex; this is for diagnostics/sorting.
      let ageTurns = 0
      for (let i = messageIndex + 1; i < messages.length; i += 1) {
        if (messages[i].role === "user") ageTurns += 1
      }

      eligible.push({
        messageIndex,
        partIndex: part.partIndex,
        role: message.role,
        text: part.text,
        tokens,
        ageTurns,
        classification,
        cacheKey: cacheKey(part.text, modelId, rate),
      })
    }
  })

  eligible.sort((a, b) => {
    if (a.ageTurns !== b.ageTurns) return b.ageTurns - a.ageTurns
    if (a.messageIndex !== b.messageIndex) return a.messageIndex - b.messageIndex
    return (a.partIndex ?? -1) - (b.partIndex ?? -1)
  })

  const candidates: Candidate[] = []
  let selectedTokens = 0
  for (const candidate of eligible) {
    if (selectedTokens + candidate.tokens > budgetTokens) {
      rejected.push({
        messageIndex: candidate.messageIndex,
        partIndex: candidate.partIndex,
        reason: "budget",
        detail: `${selectedTokens} + ${candidate.tokens} > ${budgetTokens}`,
      })
      continue
    }
    candidates.push(candidate)
    selectedTokens += candidate.tokens
  }

  return {
    candidates,
    rejected,
    protectedFromIndex,
    selectedTokens,
  }
}
