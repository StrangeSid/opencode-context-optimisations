# Roadmap

**Baseline:** `9009e83` (2026-10-25)  
**Status date:** 2026-10-27  
**Scope:** selective, reversible LLMLingua compression for OpenCode V2.

This roadmap is deliberately ordered by **evidence risk**, not by feature appeal. The compressor is already wired; the next work is to prove that OpenCode's runtime semantics and the prompt/token economics behave as assumed, then expand coverage.

---

## Current state

### Implemented and tested

- Conservative content classifier and aged selection policy.
- V2 `Message` / `ContentPart` / `ToolResultValue` adapter.
- Request lane with watermark gate, LRU, timeout, in-flight dedupe, literal post-check, expansion guard, and fail-open behavior.
- Compaction lane that pre-compresses the summarizer transcript and never sets `event.result`.
- Optional `tool.execute.after` lane with protected-tool matching.
- Reversible `context_expand` store/tool and `[ctx_expand:...]` markers.
- Optional warm Python HTTP worker.
- OpenCode Go A/B fact-retention harness.
- 74 unit tests, strict TypeScript, and documentation.

### Implemented but not verified in a live OpenCode session

- Whether `tool.execute.after` result replacement persists across V2 history.
- Whether nested `content[].text` and `tool-result.result.value` mutation is supported in every V2 build.
- Whether `ctx.model.list()` consistently returns the active model and usable limits.
- Whether the watermark estimate correlates closely enough with provider token usage.
- Whether compressed prefixes remain stable enough for provider prompt caching.
- Whether compaction-hook mutation reaches the summarizer as intended.

### Explicit non-goals

- Compressing code, diffs, JSON schemas, structured logs, errors, tool-call inputs, or the recent instruction window.
- Replacing OpenCode's native summarizer by default.
- Claiming a headline token reduction without a task-success evaluation.
- Sending real transcript data to a remote service for quality testing.

---

## Guiding principles

1. **Correctness beats compression ratio.** A missed compression is cheaper than a broken patch.
2. **Fail open, observably.** Every lane must leave the original text intact on timeout, error, malformed output, lost literal, or unsupported content.
3. **Preserve replay state.** Never mutate IDs, tool-call/tool-result pairing, reasoning, media, native provider metadata, or compaction checkpoints.
4. **Measure before default-on.** No lossy default is enabled without a repeatable quality gate.
5. **Keep the core pure and the host adapter thin.** Policy, adapter, optimizer, watermark, literals, and expand store remain testable without OpenCode or a model.

---

## Priority definitions

- **P0 — required before wider use.** Runtime correctness, privacy, or data-loss risk.
- **P1 — required for a credible release.** Measurement, quality gates, and operator ergonomics.
- **P2 — coverage wins.** More content classes and deterministic pruning.
- **P3 — scale and distribution.** Packaging, persistence, cross-platform, advanced lanes.

---

## Workstream 0 — Validate live V2 semantics (P0)

### 0.1 Verify `tool.execute.after` replacement persistence

**Why:** The tool lane is implemented but default-off because the V2 docs show replacement without stating that it is persisted.

**Work:**
- Enable the lane in a real session, replace a completed result with a unique marker, then inspect subsequent model requests and `ctx.session.context()`.
- Test completed, error, string-content, array-content, and file-content results.
- Record whether the replacement is persisted, transient, or dropped.

**Acceptance:** A documented answer with evidence; if replacement is transient, either document the lane as transient-only or remove it from the default path. Keep it off if behavior varies by provider.

### 0.2 Prove nested mutation is supported

**Why:** The adapter mutates `content[].text` and `tool-result.result.value`. Frozen objects would make the plugin silently fail open.

**Work:** Mutate a text part and a tool-result value, then inspect the outgoing HTTP body via a debug `http.request` clone or provider capture.

**Acceptance:** A note in `research/opencode-v2-hooks.md` and a regression guard; if mutation is unreliable, implement immutable message replacement while preserving class/prototype and replay fields.

### 0.3 Validate model-limit lookup

**Why:** The watermark depends on `ctx.model.list()`. Matching `event.model.id` against `ModelInfo.id` / `modelID` is inferred, not proven across providers.

**Work:** Log matched models for primary, subagent, variant, and title/compaction requests. Test a model with `limit.input` absent and one with an alias/variant.

**Acceptance:** A model-limit lookup table and a fallback test. If lookup is unreliable, add an explicit per-model config map.

### 0.4 Compare estimated tokens with provider usage

**Why:** The watermark is a heuristic. A 20–30% estimate error could trigger too early or too late.

**Work:** Collect at least 20 real requests across providers; compare `estimateRequestTokens()` before dispatch with `tokens.input` after response. Report median and p95 error.

**Acceptance:** Error documented; if p95 error exceeds 25%, add a provider-usage path using the latest assistant token record or make the watermark configurable per model.

### 0.5 Measure prompt-cache stability

**Why:** The value proposition depends on a stable compressed prefix.

**Work:** Instrument cache-hit/cache-write fields across turns with the plugin on and off; look for prefix churn after LRU eviction, worker restart, or model-rate changes.

**Acceptance:** A short report with hit-rate deltas. If eviction causes churn, add a persistent cache and/or a stable per-message mapping.

### 0.6 Verify compaction hook ordering and native compaction

**Why:** The compaction lane assumes its mutation reaches the summarizer, and native provider compaction may bypass `ctx.session.hook("compaction")`. The current lane only precompresses; it does not set `event.result`.

**Work:** Log hook invocation, `event.result` presence, and summarizer input for summary and native compaction modes. Test manual and automatic compaction.

**Acceptance:** A documented ordering/native-bypass matrix. If native compaction bypasses the hook, say so in the docs and keep the lane explicitly scoped to summary compaction.

---

## Workstream 1 — Measurement and quality gates (P0/P1)

### 1.1 Broaden the quality harness

**Current:** Three fact questions, one synthetic transcript, one model. The harness supports repeated runs (`--runs`) and has been exercised with two repetitions.

**Work:**
- Add fixtures for: prose-heavy research, code-heavy sessions, long logs, JSON/MCP output, multi-turn corrections, negations, and exact identifiers.
- Add a judging rubric (task continuity, key facts, fidelity, noise, size) beside deterministic fact checks.
- Support multiple models and report per-model results.
- Wire the existing `--strict` mode into CI and make it fail on any retained-fact regression.

**Acceptance:** At least 12 fixtures × 2 variants × 2 models; results stored as JSON; a repeatable command.

### 1.2 Add a task-success benchmark

**Why:** Fact recall is necessary but not sufficient. A coding agent can fail despite retaining the fact.

**Work:** Build 10–20 small repository tasks where the correct patch depends on old context. Run native vs compressed context with a frozen model. Score compilation, tests, and patch correctness.

**Acceptance:** A baseline table with confidence intervals; no default-on if the compressed arm regresses task success.

### 1.3 Add telemetry without content leakage

**Work:** Record per-call: lane, candidate count, compressed count, literal rejects, cache hit/miss, latency, timeout/error, estimated tokens in/out, and actual provider usage when available. Never log raw text by default.

**Acceptance:** A `/context-optimisations stats` command or debug JSONL; counters survive multiple sessions; docs explain how to enable it.

---

## Workstream 2 — Deterministic pruning and coverage (P2)

### 2.1 Free-pruning lane

Add a zero-model, lossless-or-near-lossless stage before LLMLingua:

- ANSI stripping.
- Consecutive duplicate line collapse.
- Repeated tool-call output dedupe (same tool + canonical input + same output hash).
- Head/tail retention for huge logs, with all error/warning lines preserved.
- Optional minified JSON only when a parser validates it.

**Acceptance:** Deterministic; no model call; each transform has golden tests and a documented token delta.

### 2.2 Structured log and diff reducers

- Parse common test/build log formats; keep summary, failures, and stack frames.
- Keep unified-diff hunk headers, paths, and changed lines; prune context lines.
- Never reorder lines.

**Acceptance:** Golden-file tests for Vitest/Jest/pytest/tsc/git diff; code consumers can still read line numbers.

### 2.3 Tool-aware policies

- Per-tool budgets and protected tools.
- `read` behavior: skip code, allow prose/docs, preserve paths.
- `grep`/`glob`: keep file paths and counts; prune repetition.
- MCP JSON: schema-aware compaction, not token dropping.

**Acceptance:** A tool policy matrix and tests for each high-volume tool.

### 2.4 Model-aware rates and budgets

Allow rate/budget profiles by provider/model and by content kind. Expose a conservative default profile and a research profile.

**Acceptance:** Config validation; a profile table in docs; no silent reuse across profiles (cache key includes the profile).

---

## Workstream 3 — Durability, safety, and operations (P1/P2)

### 3.1 Persistent expand store

**Why:** The current store is in-memory; a restart loses handles.

**Work:** Add an opt-in, bounded, encrypted-at-rest store (or a documented plaintext mode) with TTL and redaction hooks. Prefer `ctx.storage` only if its scope and size limits are suitable; otherwise use a plugin-owned cache directory with 0700 permissions.

**Acceptance:** Handles survive restart; total size bounded; secrets redaction documented; no transcript content written by default.

### 3.2 Cache lifecycle and eviction

- Add TTL and max-byte limits.
- Evict on compaction/checkpoint replacement.
- Persist only ciphertext or hashed content if enabled.
- Include tool name, profile, and compressor model in the key where behavior differs.

**Acceptance:** Tests for TTL, size eviction, compaction invalidation, and profile isolation.

### 3.3 Concurrency and multi-session behavior

- Ensure one worker queue and bounded in-flight requests.
- Add per-session cache isolation where required.
- Handle worker restart without blocking model dispatch.
- Add a circuit breaker and health check.

**Acceptance:** A two-session concurrency test; no unbounded queue; worker restart test.

### 3.4 Fail-open audit

Fuzz the hook inputs: missing fields, frozen objects, cyclic values, huge texts, malformed schemas, unknown roles, duplicate IDs, and Unicode edge cases. Every failure must leave the original request usable.

**Acceptance:** A fuzz suite and a documented failure matrix.

---

## Workstream 4 — Packaging and distribution (P3)

- Publish a real package with a build step instead of exporting TypeScript source.
- Add a versioned config schema and validation errors.
- Add install/uninstall for the Python worker, or ship an ONNX/JS backend.
- Add CI: Node 22/24, macOS/Linux, typecheck, tests, worker protocol smoke test.
- Add a release checklist, changelog, and signed release artifacts.
- Add a TUI/command surface for stats, enable/disable, and `context_expand` debugging.
- Evaluate a Rust/ONNX worker to remove the Python runtime.

**Acceptance:** `npm pack` installs cleanly; worker setup is one documented command; CI is green on both OS targets.

---

## Workstream 5 — Advanced lanes (only after P0 evidence)

### 5.1 Compaction modes

- Keep `precompress` as default.
- Add `augment` only if the hook can append to a native summary.
- Add `replace` only with an explicit opt-in and a quality gate; it skips the host summarizer and is the highest-risk mode.
- Verify native compaction hook behavior before claiming support.

### 5.2 Content-aware `force_tokens`

Use LLMLingua's forced-token mechanism for a bounded set of identifiers, paths, and error codes. Measure the quality/latency trade-off; do not assume it replaces the post-check.

### 5.3 Response/output steering

Evaluate a terse-output system instruction separately from input compression. Keep code untouched; test whether output-token savings justify behavior changes.

---

## Milestones

### M1 — Runtime truth (P0)

Complete workstream 0. Deliver a validated runtime note, a model-limit table, a mutation/persistence verdict, and a token-error report.

**Exit:** all six open V2 assumptions have evidence; tool lane default decision is documented.

### M2 — Measurable quality (P0/P1)

Complete 1.1–1.3. Quality harness covers at least 12 fixtures and two models; telemetry exists; a strict regression gate is available.

**Exit:** a published quality report and a clear default-on recommendation.

### M3 — Coverage (P2)

Add free pruning, log/diff reducers, and tool-aware policies. Re-run the quality harness after each.

**Exit:** deterministic pruning reduces tokens without a measured quality delta.

### M4 — Durable and distributable (P3)

Persistent/cold cache, packaged install, CI, cross-platform worker setup, and release docs.

**Exit:** a release candidate that can be installed by someone who is not the author.

---

## Issue-sized backlog

| ID | Task | Priority | Depends on | Acceptance |
|---|---|---|---|---|
| RT-01 | Live `tool.execute.after` persistence test | P0 | — | Verdict + regression test |
| RT-02 | Nested mutation test across providers | P0 | — | Verdict + adapter fallback if needed |
| RT-03 | Model-limit lookup across variants | P0 | — | Lookup table + fallback |
| RT-04 | Estimate vs provider token error report | P0 | RT-03 | p50/p95 report |
| RT-05 | Prompt-cache stability measurement | P0 | RT-04 | Hit-rate report |
| RT-06 | Compaction ordering/native bypass test | P0 | — | Ordering matrix + docs |
| QL-01 | Expand harness to 12 fixtures | P1 | — | JSON results + docs |
| QL-02 | Add rubric judge | P1 | QL-01 | Deterministic checks + rubric |
| QL-03 | 10-task coding benchmark | P1 | QL-01 | Task-success table |
| QL-04 | Stats JSONL + `stats` command | P1 | — | Counters, no raw text |
| PR-01 | ANSI/duplicate/head-tail prune | P2 | — | Golden tests |
| PR-02 | Log reducer | P2 | PR-01 | Golden tests |
| PR-03 | Diff reducer | P2 | PR-01 | Golden tests |
| PR-04 | Tool policy matrix | P2 | — | Per-tool tests |
| DS-01 | Persistent expand store | P2 | RT-01 | Restart test + privacy note |
| DS-02 | TTL/byte-bounded cache | P2 | — | Eviction tests |
| DS-03 | Concurrency + circuit breaker | P2 | — | Two-session test |
| PK-01 | Build + `npm pack` | P3 | — | Install test |
| PK-02 | CI matrix | P3 | PK-01 | Green CI |
| PK-03 | Worker install/uninstall | P3 | PK-01 | One-command setup |
| AD-01 | Compaction `replace` mode | P3 | QL-03 | Opt-in + quality gate |

---

## Decision gates

1. **No default-on for the tool lane** until RT-01 is resolved and a provider matrix is documented.
2. **No default-on for aggressive rates** until QL-03 shows no task-success regression.
3. **No persistent transcript cache by default** until DS-01's privacy model is documented.
4. **No compaction replacement mode** until the native-vs-replace quality comparison is published.
5. **No headline savings claim** without actual provider token counts and a stated session mix.

---

## Open questions

- Does `ctx.model.list()` include disabled models, aliases, and subagent models consistently?
- Does `tool.execute.after` replacement persist, and is it provider-independent?
- Is `ctx.session.context()` safe to call inside a `context` hook without recursion or deadlock?
- Does native compaction bypass `ctx.session.hook("compaction")`?
- What is the exact scope and size limit of `ctx.storage`?
- Can the worker be bundled as an optional ONNX sidecar without a Python install?
- Which provider cache semantics should the plugin target first (Anthropic, OpenAI, Gemini)?
- How should redaction work for paths, tokens, and environment variables in expand storage?

---

## Good first contributions

1. Add a fixture to `research/eval_quality.mjs` for a new content class.
2. Add a golden test for ANSI/duplicate-line pruning.
3. Add a model-limit fallback test for `limit.input` absent.
4. Add a tool-policy case for `grep` or `read`.
5. Improve the `context_expand` query output format and add tests.
6. Reproduce the M3 Pro benchmark on another machine and record the delta.

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for setup and test expectations.
