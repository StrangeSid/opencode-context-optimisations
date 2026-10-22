/**
 * Content classification for compression policy.
 *
 * LLMLingua is a token-dropping compressor. It is safe for redundant natural
 * language and destructive for code, diffs, JSON, logs and exact identifiers.
 * This module is deliberately conservative: when the signal is ambiguous it
 * returns "unknown" so callers can leave the text untouched.
 */

export type ContentKind =
  | "empty"
  | "json"
  | "diff"
  | "code"
  | "log"
  | "prose"
  | "unknown"

export interface Classification {
  kind: ContentKind
  confidence: number
  reasons: string[]
}

const CODE_LINE =
  /^\s*(import|export|const|let|var|function|class|interface|type|enum|return|if|else|for|while|switch|case|try|catch|throw|async|await|def|fn|pub|use|package|func|struct|impl)\b/

const LOG_LINE =
  /^\s*(\[?\d{4}-\d{2}-\d{2}[T ]|\[?(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\]?|[A-Za-z]+Error:|at\s+\S+\s+\(|npm (WARN|ERR!)|PASS\b|FAIL\b)/

const DIFF_LINE = /^(diff --git |index [0-9a-f]+\.\.|@@ -\d+|\+\+\+ |--- )/

const PATH_LIKE =
  /(?:^|[\s"'`(])(?:\.{0,2}\/|~\/|\/)[\w.@-]+\/[\w.@/-]+|[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|css|scss|json|yaml|yml|toml|md)\b/g

const FENCE = /```[\s\S]*?```/g

function linesOf(text: string): string[] {
  return text.split(/\r?\n/)
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 2) return false
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false
  if (trimmed.length > 200_000) return false
  try {
    const value = JSON.parse(trimmed)
    return value !== null && typeof value === "object"
  } catch {
    return false
  }
}

/**
 * Classify a single text part. This is a heuristic, not a parser: it is tuned
 * to answer one question — "is it safe to drop tokens here?" — not to describe
 * the content precisely.
 */
export function classifyText(text: string): Classification {
  const trimmed = text.trim()
  if (!trimmed) return { kind: "empty", confidence: 1, reasons: ["blank"] }

  const lines = linesOf(text)
  const nonBlank = lines.filter((line) => line.trim().length > 0)
  const total = Math.max(nonBlank.length, 1)

  if (looksLikeJson(text)) {
    return { kind: "json", confidence: 0.95, reasons: ["parses as JSON object/array"] }
  }

  const diffLines = nonBlank.filter((line) => DIFF_LINE.test(line)).length
  if (diffLines >= 2 && ratio(diffLines, total) >= 0.05) {
    return { kind: "diff", confidence: 0.9, reasons: [`${diffLines} diff markers`] }
  }

  const fenced = text.match(FENCE) ?? []
  const fencedChars = fenced.reduce((sum, block) => sum + block.length, 0)
  if (fenced.length >= 1 && fencedChars >= 40) {
    return {
      kind: "code",
      confidence: 0.9,
      reasons: [`${fenced.length} fenced block(s), ${fencedChars} chars`],
    }
  }

  const logLines = nonBlank.filter((line) => LOG_LINE.test(line)).length
  if (logLines >= 5 && ratio(logLines, total) >= 0.1) {
    return { kind: "log", confidence: 0.85, reasons: [`${logLines} log/stack lines`] }
  }

  const codeLines = nonBlank.filter((line) => CODE_LINE.test(line)).length
  const codePunctuation = (text.match(/[{}();=><]/g) ?? []).length
  const indented = nonBlank.filter((line) => /^\s{2,}\S/.test(line)).length
  const words = text.match(/[A-Za-z][A-Za-z'-]+/g)?.length ?? 0

  // Code is identified by structure, not by vocabulary. A high density of
  // braces/semicolons plus indentation or declaration lines is enough.
  const structural = codeLines + indented
  if (
    (codeLines >= 3 && ratio(structural, total) >= 0.15) ||
    (codePunctuation >= 12 && codePunctuation / Math.max(words, 1) >= 0.35 && indented >= 2)
  ) {
    return {
      kind: "code",
      confidence: 0.8,
      reasons: [`${codeLines} declaration lines`, `${indented} indented lines`],
    }
  }

  const paths = text.match(PATH_LIKE)?.length ?? 0
  const pathDensity = paths / Math.max(words, 1)
  if (paths >= 3 && pathDensity >= 0.08) {
    return {
      kind: "unknown",
      confidence: 0.6,
      reasons: [`${paths} path-like tokens; exact form may matter`],
    }
  }

  if (words >= 25) {
    return {
      kind: "prose",
      confidence: paths === 0 ? 0.85 : 0.7,
      reasons: [`${words} words`, `${paths} paths`],
    }
  }

  return { kind: "unknown", confidence: 0.3, reasons: ["too little natural-language signal"] }
}

/**
 * Whether token-level LLMLingua may be applied to this text.
 * Logs are intentionally false here: they need structural pruning, not token
 * classification. Prose with a few paths is still eligible, but callers should
 * consider path protection.
 */
export function isTokenCompressible(classification: Classification): boolean {
  return classification.kind === "prose" && classification.confidence >= 0.7
}

/**
 * Cheap, conservative token estimate used for watermarks and savings logs.
 * It is not a substitute for provider token counts.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[\u3000-\u9fff\uac00-\ud7af]/g) ?? []).length
  const other = text.length - cjk
  return Math.ceil(other / 4 + cjk / 1.5)
}
