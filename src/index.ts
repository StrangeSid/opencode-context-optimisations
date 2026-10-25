/**
 * Pure policy, adapter, and optimizer exports.
 *
 * The OpenCode plugin entry point is exported from the package's "./plugin"
 * subpath so importing the core does not load the OpenCode host runtime.
 */
export {
  classifyText,
  estimateTokens,
  isTokenCompressible,
  type Classification,
  type ContentKind,
} from "./classify.ts"

export {
  selectLlmlinguaCandidates,
  type Candidate,
  type PolicyMessage,
  type RejectReason,
  type RejectedPart,
  type SelectionOptions,
  type SelectionResult,
  type TextPart,
} from "./policy.ts"

export {
  applyV2Replacements,
  policySpanKey,
  toPolicyTranscript,
  type V2ContentPart,
  type V2Message,
  type V2Replacement,
  type V2TextSource,
  type V2TextSpan,
  type V2Transcript,
  type V2ToolResult,
} from "./v2.ts"

export {
  createLruCache,
  optimizeTranscript,
  type CompressionBackend,
  type CompressionRequest,
  type OptimizerDeps,
  type OptimizerOptions,
  type OptimizerStats,
  type TextCache,
} from "./optimizer.ts"

export {
  createHttpCompressor,
  type HttpCompressorOptions,
} from "./compressor.ts"

export {
  createExpandAnnotator,
  createExpandStore,
  type ExpandStore,
  type ExpandStoreOptions,
  type ReplacementAnnotator,
} from "./expand.ts"

export {
  extractProtectedLiterals,
  findMissingLiterals,
  type LiteralOptions,
} from "./literals.ts"

export {
  findToolTextSlot,
  isProtectedTool,
  type ToolResultLike,
  type ToolTextEntry,
  type ToolTextSlot,
} from "./tool-result.ts"

export {
  estimateRequestTokens,
  evaluateWatermark,
  type ContextEstimateInput,
  type WatermarkDecision,
  type WatermarkOptions,
} from "./watermark.ts"

export { PLUGIN_ID } from "./constants.ts"
