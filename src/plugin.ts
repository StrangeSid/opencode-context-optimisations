/**
 * OpenCode V2 plugin entry point.
 *
 * Registers four capabilities, each independently configurable:
 *   - "context":  watermark-gated, transient request-lane compression
 *   - "compaction": pre-compress the transcript before the summarizer runs
 *   - "execute.after": optional incremental tool-output compression
 *   - context_expand: retrieve an original span stored by the request lane
 *
 * The plugin never edits system prompts, tool definitions, or persisted
 * history. Compression is transient and reapplied on every model call.
 */

import { Schema } from "effect"
import { Plugin } from "@opencode/plugin"

import { createHttpCompressor } from "./compressor.ts"
import { PLUGIN_ID } from "./constants.ts"
import { createExpandAnnotator, createExpandStore } from "./expand.ts"
import {
  createLruCache,
  optimizeTranscript,
  type CompressionBackend,
  type OptimizerOptions,
  type TextCache,
} from "./optimizer.ts"
import { findToolTextSlot, isProtectedTool } from "./tool-result.ts"
import type { V2ContentPart, V2Message } from "./v2.ts"
import { estimateRequestTokens, evaluateWatermark } from "./watermark.ts"

const DEFAULT_PROTECTED_TOOLS = [
  "write",
  "edit",
  "patch",
  "task",
  "todowrite",
  "question",
  "context_expand",
  "plan_*",
]

export interface ContextPluginConfig extends OptimizerOptions {
  /** Full URL of a warm sidecar's compress endpoint. */
  endpoint?: string
  /** Log one-line stats to stderr. Default false. */
  debug?: boolean
  /** Gate the request lane on estimated context pressure. Default true. */
  watermarkEnabled?: boolean
  /** Compress when estimated usage reaches this fraction of usable context. Default 0.7. */
  watermarkRatio?: number
  /** Reserved response tokens; defaults to 15% of the model limit, clamped to 1-16k. */
  outputReserveTokens?: number
  /** Pre-compress the transcript passed to the summarizer. Default true. */
  compactionEnabled?: boolean
  compactionProtectedTurns?: number
  compactionMinTokens?: number
  compactionBudgetTokens?: number
  compactionRate?: number
  compactionTimeoutMs?: number
  /** Incremental tool-output compression. Default false (unverified persistence). */
  toolOutputEnabled?: boolean
  toolMinTokens?: number
  toolBudgetTokens?: number
  toolRate?: number
  toolTimeoutMs?: number
  /** Exact tool names or trailing-* prefixes that are never compressed. */
  protectedTools?: string[]
  /** Register the retrieval tool and append markers. Default true. */
  expandToolEnabled?: boolean
  expandStoreMaxEntries?: number
  expandStoreMaxChars?: number
}

export interface PluginRuntime {
  /** Injected for tests or for a future embedded worker. */
  backend?: CompressionBackend
  cache?: TextCache
  inflight?: Map<string, Promise<string>>
  expandStore?: ReturnType<typeof createExpandStore>
  logger?: (message: string) => void
}

function numberOption(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function stringArrayOption(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === "string")
}

export function resolvePluginConfig(
  raw: Readonly<Record<string, unknown>> = {},
): ContextPluginConfig {
  return {
    enabled: raw.enabled !== false,
    debug: raw.debug === true,
    endpoint:
      typeof raw.endpoint === "string" && raw.endpoint.trim().length > 0
        ? raw.endpoint.trim()
        : undefined,
    protectedTurns: numberOption(raw.protectedTurns),
    minTokens: numberOption(raw.minTokens),
    budgetTokens: numberOption(raw.budgetTokens),
    allowUserProse: raw.allowUserProse === true,
    includeToolProse: raw.includeToolProse !== false,
    modelId: stringOption(raw.modelId),
    rate: numberOption(raw.rate),
    timeoutMs: numberOption(raw.timeoutMs),
    cacheMaxEntries: numberOption(raw.cacheMaxEntries),
    maxCompressedRatio: numberOption(raw.maxCompressedRatio),
    validateLiterals: raw.validateLiterals !== false,
    watermarkEnabled: raw.watermarkEnabled !== false,
    watermarkRatio: numberOption(raw.watermarkRatio),
    outputReserveTokens: numberOption(raw.outputReserveTokens),
    compactionEnabled: raw.compactionEnabled !== false,
    compactionProtectedTurns: numberOption(raw.compactionProtectedTurns),
    compactionMinTokens: numberOption(raw.compactionMinTokens),
    compactionBudgetTokens: numberOption(raw.compactionBudgetTokens),
    compactionRate: numberOption(raw.compactionRate),
    compactionTimeoutMs: numberOption(raw.compactionTimeoutMs),
    toolOutputEnabled: raw.toolOutputEnabled === true,
    toolMinTokens: numberOption(raw.toolMinTokens),
    toolBudgetTokens: numberOption(raw.toolBudgetTokens),
    toolRate: numberOption(raw.toolRate),
    toolTimeoutMs: numberOption(raw.toolTimeoutMs),
    protectedTools: stringArrayOption(raw.protectedTools),
    expandToolEnabled: raw.expandToolEnabled !== false,
    expandStoreMaxEntries: numberOption(raw.expandStoreMaxEntries),
    expandStoreMaxChars: numberOption(raw.expandStoreMaxChars),
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build the plugin definition. Exported separately so tests can inject a fake
 * backend, cache, or expand store.
 */
export function createContextPlugin(runtime: PluginRuntime = {}) {
  return Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
      const config = resolvePluginConfig(ctx.options)

      if (config.enabled === false) return

      const backend =
        runtime.backend ??
        (config.endpoint
          ? createHttpCompressor({
              endpoint: config.endpoint,
              timeoutMs: config.timeoutMs,
            })
          : undefined)

      // No transport means no compression and no extra tools.
      if (!backend) return

      const cache = runtime.cache ?? createLruCache(config.cacheMaxEntries ?? 500)
      const inflight = runtime.inflight ?? new Map<string, Promise<string>>()
      const expandStore =
        config.expandToolEnabled !== false
          ? (runtime.expandStore ??
            createExpandStore({
              maxEntries: config.expandStoreMaxEntries,
              maxChars: config.expandStoreMaxChars,
            }))
          : undefined
      const onCompressed = expandStore
        ? createExpandAnnotator(expandStore)
        : undefined
      const deps = {
        backend,
        cache,
        inflight,
        ...(onCompressed ? { onCompressed } : {}),
      }
      const log =
        runtime.logger ??
        ((message: string) => {
          console.warn(message)
        })

      const modelLimits = new Map<string, number | null>()
      const getContextLimit = async (model: {
        readonly id: string
        readonly providerID: string
      }): Promise<number | undefined> => {
        const key = model.providerID + "\0" + model.id
        if (modelLimits.has(key)) return modelLimits.get(key) ?? undefined
        try {
          const result = await ctx.model.list()
          const info = result.data.find(
            (entry) =>
              entry.providerID === model.providerID &&
              (entry.modelID === model.id || entry.id === model.id),
          )
          const limit = info ? (info.limit.input ?? info.limit.context) : undefined
          const value =
            typeof limit === "number" && Number.isFinite(limit) && limit > 0
              ? limit
              : null
          modelLimits.set(key, value)
          return value ?? undefined
        } catch (error) {
          modelLimits.set(key, null)
          if (config.debug) {
            log("[opencode-llmlingua] model limit lookup failed: " + errorDetail(error))
          }
          return undefined
        }
      }

      await ctx.session.hook("context", async (event) => {
        try {
          if (config.watermarkEnabled !== false) {
            const limit = await getContextLimit(event.model)
            if (limit !== undefined) {
              const used = estimateRequestTokens({
                system: event.system,
                tools: event.tools,
                messages: event.messages,
              })
              const decision = evaluateWatermark(used, limit, {
                highRatio: config.watermarkRatio,
                outputReserveTokens: config.outputReserveTokens,
              })
              if (!decision?.shouldCompress) {
                if (config.debug) {
                  log(
                    "[opencode-llmlingua] watermark skipped: " +
                      JSON.stringify(decision ?? {}),
                  )
                }
                return
              }
              if (config.debug) {
                log(
                  "[opencode-llmlingua] watermark pass: " +
                    JSON.stringify(decision),
                )
              }
            }
          }

          const stats = await optimizeTranscript(event.messages, config, deps)
          if (config.debug) {
            log("[opencode-llmlingua] context " + JSON.stringify(stats))
          }
        } catch (error) {
          if (config.debug) {
            log("[opencode-llmlingua] context failed: " + errorDetail(error))
          }
        }
      })

      if (config.compactionEnabled !== false) {
        await ctx.session.hook("compaction", async (event) => {
          if (event.result) return
          try {
            const stats = await optimizeTranscript(event.messages, {
              ...config,
              protectedTurns: config.compactionProtectedTurns ?? config.protectedTurns,
              minTokens: config.compactionMinTokens ?? config.minTokens,
              budgetTokens: config.compactionBudgetTokens ?? 8000,
              rate: config.compactionRate ?? 0.7,
              timeoutMs: config.compactionTimeoutMs ?? 12_000,
            }, deps)
            if (config.debug) {
              log("[opencode-llmlingua] compaction " + JSON.stringify(stats))
            }
          } catch (error) {
            if (config.debug) {
              log("[opencode-llmlingua] compaction failed: " + errorDetail(error))
            }
          }
        })
      }

      if (config.toolOutputEnabled === true) {
        const protectedTools = config.protectedTools ?? DEFAULT_PROTECTED_TOOLS
        await ctx.tool.hook("execute.after", async (event) => {
          if (event.status !== "completed") return
          if (isProtectedTool(event.tool, protectedTools)) return

          const slot = findToolTextSlot(event.result)
          if (!slot) return

          const toolMessage: V2Message = {
            role: "tool",
            content: [
              {
                type: "tool-result",
                id: event.id,
                name: event.tool,
                result: { type: "text", value: slot.text },
              },
            ],
          }
          const current: V2Message = { role: "user", content: "current request" }

          try {
            const stats = await optimizeTranscript([toolMessage, current], {
              ...config,
              protectedTurns: 1,
              minTokens: config.toolMinTokens ?? 300,
              budgetTokens: config.toolBudgetTokens ?? 2000,
              rate: config.toolRate ?? 0.6,
              timeoutMs: config.toolTimeoutMs ?? 1200,
            }, deps)
            if (stats.compressed === 0) return

            const content = toolMessage.content as V2ContentPart[]
            const compressed = content[0]?.result?.value
            if (typeof compressed !== "string") return

            event.result = slot.apply(event.result, compressed) as typeof event.result
            if (config.debug) {
              log("[opencode-llmlingua] tool " + event.tool + " " + JSON.stringify(stats))
            }
          } catch (error) {
            if (config.debug) {
              log("[opencode-llmlingua] tool failed: " + errorDetail(error))
            }
          }
        })
      }

      if (expandStore) {
        await ctx.tool.transform((editor) => {
          if (editor.get("context_expand")) return
          editor.add({
            name: "context_expand",
            description:
              "Retrieve the original text behind a compressed context span. " +
              "Use the handle from a [ctx_expand:...] marker; optionally pass a query to search lines.",
            input: Schema.Struct({
              handle: Schema.String,
              query: Schema.optional(Schema.String),
            }),
            execute: async (args) => {
              const text = expandStore.search(args.handle, args.query)
              if (text === undefined) {
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: "Unknown context handle: " + args.handle,
                    },
                  ],
                }
              }
              return {
                content: [{ type: "text" as const, text }],
                metadata: { handle: args.handle },
              }
            },
          })
        })
      }
    },
  })
}

export default createContextPlugin()
