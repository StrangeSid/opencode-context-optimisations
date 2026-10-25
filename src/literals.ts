/**
 * Protected-literal validation for lossy compression.
 *
 * LLMLingua can drop numbers, paths, URLs, and error codes. Before accepting a
 * compressed span we extract high-value literals from the original and require
 * them to survive verbatim. This is a conservative post-check; it does not try
 * to protect every identifier.
 */

export interface LiteralOptions {
  includePaths?: boolean
  includeUrls?: boolean
  includeNumbers?: boolean
  includeLineReferences?: boolean
  includeErrorCodes?: boolean
  /** Maximum literals checked per span. Default 200. */
  maxLiterals?: number
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'\])]+/g
const PATH_PATTERN =
  /(?:^|[\s"'\x60(])((?:(?:\.{0,2}\/|~\/|\/)?(?:[\w.@-]+\/)*[\w.@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|css|scss|json|yaml|yml|toml|md|sh|sql|proto))|(?:(?:\.{0,2}\/|~\/|\/)[\w.@-]+(?:\/[\w.@-]+)+))\b/g
const LINE_REFERENCE_PATTERN = /\b(?:line|lines|L)\s*\d+(?:\s*[-–]\s*\d+)?\b|:[0-9]{1,6}\b/g
const ERROR_CODE_PATTERN = /\b(?:TS\d{4,}|HTTP\s?\d{3}|E[A-Z]{2,}\d*|SQLSTATE\s?\w+)\b/g
const NUMBER_PATTERN = /\b\d+(?:\.\d+)?\b/g

function cleanLiteral(value: string): string {
  return value.replace(/[.,;:!?]+$/, "").trim()
}

function matches(pattern: RegExp, text: string, group = 0): string[] {
  const result: string[] = []
  for (const match of text.matchAll(pattern)) {
    const value = group > 0 ? match[group] : match[0]
    if (typeof value !== "string") continue
    const cleaned = cleanLiteral(value)
    if (cleaned) result.push(cleaned)
  }
  return result
}

/**
 * Extract the literals that must survive compression. The order is
 * paths/URLs/error codes first, then line references and numbers.
 */
export function extractProtectedLiterals(
  text: string,
  options: LiteralOptions = {},
): string[] {
  if (!text) return []
  const found: string[] = []

  if (options.includeUrls !== false) found.push(...matches(URL_PATTERN, text))
  if (options.includePaths !== false) found.push(...matches(PATH_PATTERN, text, 1))
  if (options.includeErrorCodes !== false) found.push(...matches(ERROR_CODE_PATTERN, text))
  if (options.includeLineReferences !== false) {
    found.push(...matches(LINE_REFERENCE_PATTERN, text))
  }
  if (options.includeNumbers !== false) found.push(...matches(NUMBER_PATTERN, text))

  const unique = [...new Set(found)]
  const limit = options.maxLiterals ?? 200
  return unique.slice(0, Math.max(0, limit))
}

/**
 * Return protected literals present in the original but absent from the
 * compressed text. An empty array means the result is safe to apply.
 */
export function findMissingLiterals(
  original: string,
  compressed: string,
  options: LiteralOptions = {},
): string[] {
  const literals = extractProtectedLiterals(original, options)
  if (literals.length === 0) return []
  return literals.filter((literal) => !compressed.includes(literal))
}
