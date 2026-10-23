# ADR 0001: Selective Prose Compression Over Whole-Transcript Pruning

## Status
Accepted

## Context
Initial implementations of prompt compression (e.g., `evermeer/context-optimizer`) attempted to compress prompt contexts globally using LLMLingua. When applied blindly to agentic coding transcripts, this caused severe regressions:
1. Programming languages rely on exact structural tokens (braces, punctuation, indentation, identifiers). LLMLingua-2 BERT classifiers frequently drop closing braces and keywords, producing syntax errors (`TS1005` in TypeScript).
2. Diagnostic logs and stack traces collapse into unreadable single-line blocks, stripping timestamps and error locations.
3. Natural language statements with negation qualifiers ("do not delete X") lose important words, inverting agent intent.
4. Mutating early prompt blocks continuously breaks provider prompt caching (OpenAI/Anthropic KV prefix caching), increasing costs and latency.

## Decision
We restrict token-level SLM compression (LLMLingua) to **stale, natural-language prose only**:
- System messages, prompt instructions, and tool definitions are permanently protected to preserve upstream prompt-cache hits.
- Code, diffs, JSON schemas, and structured logs are strictly filtered out by a conservative heuristic classifier (`classifyText`).
- The most recent *N* user turns (default: 2) remain untouched to preserve current developer intent and immediate context.
- Compressed chunks are memoized by a deterministic SHA-256 content key (`policy_version + model + rate + text`) so history isn't recompressed on every turn.
- A hard token budget (default: 2,000 tokens) is allocated oldest-first.

## Consequences
### Positive
- Zero syntax corruption on source code or diff hunks.
- Upstream prompt caching remains stable across conversation turns.
- Transparent fail-open behavior: unknown or ambiguous content is never mutated.
- Deterministic and verifiable through unit testing without requiring live LLM calls.

### Negative
- Overall session token reduction from LLMLingua is limited to natural-language prose segments (10–30% of total transcript tokens in code-heavy sessions).
- CLI outputs and JSON arrays must be handled by separate, dedicated deterministic engines (RTK and Headroom/SmartCrusher) rather than a single universal model.
