# API Reference

`opencode-context-optimisations` exports pure, deterministic classification and selection policy modules.

---

## Content Classification (`src/classify.ts`)

### `classifyText(text: string): Classification`

Analyzes an input string using heuristic regular expressions and structural checks to determine its content kind.

#### Parameters
- `text`: `string` — The input string to classify.

#### Returns
- `Classification`:
  - `kind`: `ContentKind` — One of `"empty" | "json" | "diff" | "code" | "log" | "prose" | "unknown"`
  - `confidence`: `number` — Confidence score between `0.0` and `1.0`
  - `reasons`: `string[]` — Diagnostic explanations of the matched heuristics

#### Example
```typescript
import { classifyText } from "opencode-context-optimisations"

const result = classifyText("export async function loadConfig(path: string): Promise<Config> {}")
console.log(result.kind) // "code"
console.log(result.confidence) // 1.0
```

---

### `isTokenCompressible(classification: Classification): boolean`

Determines whether a classified text chunk is safe for token-dropping compression (such as LLMLingua).

#### Parameters
- `classification`: `Classification` — A classification result returned by `classifyText`.

#### Returns
- `boolean` — `true` only if `classification.kind === "prose"` and `confidence >= 0.7`. Returns `false` for code, diffs, JSON, logs, empty text, or ambiguous content.

---

### `estimateTokens(text: string): number`

Provides a fast, zero-dependency token count estimate. Uses whitespace character length approximation for Latin scripts and individual character counts for CJK ideographs.

#### Parameters
- `text`: `string` — The text to estimate.

#### Returns
- `number` — Estimated token count (integer >= 0).

---

## Policy Engine (`src/policy.ts`)

### `selectLlmlinguaCandidates(messages: PolicyMessage[], options?: SelectionOptions): SelectionResult`

Pure, deterministic candidate selection engine. Identifies messages in conversation history eligible for token-level pruning according to strict safety boundaries.

#### Parameters
- `messages`: `PolicyMessage[]` — The array of message objects from OpenCode's conversation transcript.
- `options`: `SelectionOptions` *(optional)*:
  - `protectedTurns`: `number` *(default: 2)* — Number of most recent user turns to keep completely verbatim.
  - `minTokens`: `number` *(default: 400)* — Minimum estimated token threshold for a chunk to be considered.
  - `budgetTokens`: `number` *(default: 2000)* — Maximum cumulative token budget to allocate to compression candidates.
  - `allowUserProse`: `boolean` *(default: false)* — Whether to allow compression of stale user prose.
  - `includeToolProse`: `boolean` *(default: true)* — Whether to allow compression of stale tool results classified as pure natural language.
  - `modelId`: `string` *(default: "llmlingua-2")* — Model identifier embedded into the cache key.
  - `rate`: `number` *(default: 0.6)* — Compression target rate embedded into the cache key.

#### Returns
- `SelectionResult`:
  - `candidates`: `Candidate[]` — Eligible text parts, sorted oldest-first, fitting within `budgetTokens`.
  - `rejected`: `RejectedPart[]` — Record of rejected messages with associated reasons (`"system" | "recent" | "role" | "non-text" | "content" | "small" | "budget"`).
  - `protectedFromIndex`: `number` — Message index boundary separating the protected recent turns from historical context.
  - `selectedTokens`: `number` — Total estimated tokens across all approved candidates.

#### Example
```typescript
import { selectLlmlinguaCandidates } from "opencode-context-optimisations"

const { candidates, selectedTokens } = selectLlmlinguaCandidates(transcript, {
  protectedTurns: 2,
  minTokens: 400,
  budgetTokens: 2000
})

for (const candidate of candidates) {
  console.log(`Candidate at message ${candidate.messageIndex}: ${candidate.tokens} tokens, cacheKey: ${candidate.cacheKey}`)
}
```
