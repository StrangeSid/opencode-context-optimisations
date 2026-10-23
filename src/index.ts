/**
 * Phase 1 core exports. The OpenCode V2 plugin entrypoint will be added once
 * the compressor worker and policy engine land (see FINDINGS.md §7).
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

export const PLUGIN_ID = "opencode-llmlingua"
