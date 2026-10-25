/**
 * Watermark estimation for the request lane.
 *
 * The V2 context event has no token-usage field and event.model has no limit.
 * The plugin therefore estimates the outgoing request from system parts, tool
 * schemas, and messages, and compares it with the model limit fetched through
 * ctx.model.list(). This is deliberately approximate: the gate only decides
 * whether to pay compression latency, and every compression still has its own
 * budget and fail-open path.
 */

import { estimateTokens } from "./classify.ts"
import type { V2ContentPart, V2Message } from "./v2.ts"

export interface ContextEstimateInput {
  system?: readonly { text?: string }[]
  tools?: Readonly<Record<string, unknown>>
  messages: readonly V2Message[]
}

export interface WatermarkOptions {
  /** Compress when estimated usage reaches this fraction of usable context. Default 0.7. */
  highRatio?: number
  /** Explicit tokens reserved for the response. Default 15% of the limit, clamped to 1-16k. */
  outputReserveTokens?: number
}

export interface WatermarkDecision {
  usedTokens: number
  contextLimit: number
  reserveTokens: number
  usableTokens: number
  ratio: number
  threshold: number
  shouldCompress: boolean
}

const DEFAULT_HIGH_RATIO = 0.7
const MIN_RESERVE_TOKENS = 1024
const MAX_RESERVE_TOKENS = 16_000
const DEFAULT_RESERVE_RATIO = 0.15
const MESSAGE_OVERHEAD_TOKENS = 4
const MEDIA_ESTIMATE_TOKENS = 100

function estimateJson(value: unknown): number {
  if (value === undefined || value === null) return 0
  if (typeof value === "string") return estimateTokens(value)
  try {
    const encoded = JSON.stringify(value)
    return typeof encoded === "string" ? estimateTokens(encoded) : 0
  } catch {
    return 0
  }
}

function estimateToolResult(value: unknown): number {
  if (typeof value === "string") return estimateTokens(value)
  if (Array.isArray(value)) {
    let total = 0
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue
      const record = entry as { type?: unknown; text?: unknown }
      if (record.type === "text" && typeof record.text === "string") {
        total += estimateTokens(record.text)
      } else if (record.type === "file") {
        total += 50
      }
    }
    return total
  }
  return estimateJson(value)
}

function estimatePart(part: V2ContentPart): number {
  if (typeof part.text === "string") return estimateTokens(part.text)
  if (part.type === "tool-call") return estimateJson(part.input)
  if (part.type === "tool-result" && part.result) {
    return estimateToolResult(part.result.value)
  }
  if (part.type === "media") return MEDIA_ESTIMATE_TOKENS
  return 0
}

function estimateMessage(message: V2Message): number {
  let total = MESSAGE_OVERHEAD_TOKENS
  if (typeof message.content === "string") {
    return total + estimateTokens(message.content)
  }
  if (!Array.isArray(message.content)) return total
  for (const part of message.content) {
    if (part && typeof part === "object") total += estimatePart(part)
  }
  return total
}

/**
 * Cheap estimate of the outgoing request size. It intentionally counts tool
 * schemas and tool-call inputs because those are part of the provider payload.
 */
export function estimateRequestTokens(input: ContextEstimateInput): number {
  let total = 0
  for (const part of input.system ?? []) {
    if (part && typeof part.text === "string") total += estimateTokens(part.text)
  }
  if (input.tools) total += estimateJson(input.tools)
  for (const message of input.messages) total += estimateMessage(message)
  return total
}

function resolveThreshold(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    return DEFAULT_HIGH_RATIO
  }
  return value
}

function resolveReserve(contextLimit: number, value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value)
  }
  const proportional = Math.floor(contextLimit * DEFAULT_RESERVE_RATIO)
  return Math.max(MIN_RESERVE_TOKENS, Math.min(MAX_RESERVE_TOKENS, proportional))
}

/**
 * Decide whether the request lane should run. Returns undefined when the model
 * limit is unusable; callers should then fall back to their configured default.
 */
export function evaluateWatermark(
  usedTokens: number,
  contextLimit: number,
  options: WatermarkOptions = {},
): WatermarkDecision | undefined {
  if (!Number.isFinite(contextLimit) || contextLimit <= 0) return undefined
  const used = Number.isFinite(usedTokens) && usedTokens > 0 ? Math.floor(usedTokens) : 0
  const reserve = Math.min(
    Math.max(0, Math.floor(contextLimit) - 1),
    resolveReserve(contextLimit, options.outputReserveTokens),
  )
  const usable = Math.max(1, Math.floor(contextLimit) - reserve)
  const ratio = used / usable
  const threshold = resolveThreshold(options.highRatio)

  return {
    usedTokens: used,
    contextLimit: Math.floor(contextLimit),
    reserveTokens: reserve,
    usableTokens: usable,
    ratio,
    threshold,
    shouldCompress: ratio >= threshold,
  }
}
