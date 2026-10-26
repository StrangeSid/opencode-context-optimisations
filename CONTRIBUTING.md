# Contributing to opencode-context-optimisations

Thank you for your interest in contributing. This project provides selective, cache-aware context compression for OpenCode V2 coding agents under the GNU General Public License v3.0 (`GPL-3.0-or-later`).

---

## Guiding Principles

1. **Safety over compression ratio:** Never drop tokens from code, unified diffs, JSON schemas, error traces, or recent user instructions. A missed compression opportunity is minor; broken syntax or lost error lines cause silent agent failures.
2. **Determinism:** Content classification and candidate selection must be pure, repeatable, and bounded.
3. **Prefix-cache stability:** Upstream provider KV-caching (OpenAI/Anthropic prompt caching) is prioritized. Never rewrite static system instructions or tool definitions.

---

## Development Setup

### Prerequisites

- Node.js >= 22.0.0 with built-in TypeScript type stripping (the test script runs `tests/*.test.ts` directly; use a recent 22.x or newer release)
- Npm >= 10.0.0
- (Optional) Python 3.12+ with a virtual environment for the LLMLingua worker or benchmark harnesses

### Setup Instructions

```bash
# 1. Clone the repository
git clone https://github.com/StrangeSid/opencode-context-optimisations.git
cd opencode-context-optimisations

# 2. Install dependencies
npm install

# 3. Verify tests and TypeScript compilation
npm test
npm run typecheck

# 4. Optional: run the OpenCode Go quality harness
cp .env.example .env       # add OC_GO_KEY; .env is gitignored
.venv-worker/bin/python python/llmlingua_worker.py --port 8765 &
npm run eval:quality -- --runs 1
```

Never commit `.env` or an API key. The repository ignores `.env` and `.env.*`
except `.env.example`.

---

## Project Structure

- `src/classify.ts`: Fast heuristic classifier identifying content kind and token compressibility.
- `src/policy.ts`: Pure selection policy determining eligible messages and enforcing token budgets.
- `src/v2.ts`: Structural adapter for OpenCode V2 messages, content parts, and tool-result values.
- `src/optimizer.ts`: LRU, in-flight dedupe, timeout, literal validation, annotation, expansion guard, and in-place replacement.
- `src/watermark.ts`: Request-size estimation and context-pressure gate.
- `src/literals.ts`: Path/URL/number/line/error preservation post-check.
- `src/expand.ts`: Bounded original-text store and retrieval markers.
- `src/tool-result.ts`: Tool-result text extraction and protected-tool matching.
- `src/compressor.ts`: HTTP client for the optional warm sidecar.
- `src/plugin.ts`: OpenCode V2 context, compaction, tool-output, and `context_expand` wiring.
- `src/index.ts`: Pure public API exports. The host plugin is exported from `./plugin`.
- `tests/`: Node test runner test suites (`tests/*.test.ts`).
- `python/`: Optional LLMLingua HTTP worker and its sidecar-only requirements.
- `research/eval_quality.mjs`: OpenCode Go A/B fact-retention harness.
- `ROADMAP.md`: Prioritized workstreams, milestones, issue-sized tasks, and decision gates.
- `docs/`: Architectural specifications, API reference, and decision records.
- `research/`: Experimental benchmark scripts, raw data, and upstream hook audits.

---

## Where to Start

Pick an issue-sized task from [ROADMAP.md](./ROADMAP.md). The M1 runtime
validation tasks (tool-hook persistence, nested mutation, model-limit lookup,
token-estimate error, prompt-cache stability) are the highest-value work.
Smaller first contributions are listed at the end of the roadmap.

---

## Submitting Pull Requests

1. **Branch Naming:** Use clear branch prefixes:
   - `feat/feature-name`
   - `fix/bug-fix`
   - `docs/documentation-update`
   - `perf/optimization-name`
2. **Test Coverage:** Every bug fix or new rule must include coverage in the relevant suite: classifier (`tests/classify.test.ts`), policy (`tests/policy.test.ts`), V2 adapter (`tests/v2.test.ts`), optimizer/cache/literals/fail-open (`tests/optimizer.test.ts`), sidecar protocol (`tests/compressor.test.ts`), expand store (`tests/expand.test.ts`), literals (`tests/literals.test.ts`), tool results (`tests/tool-result.test.ts`), watermark (`tests/watermark.test.ts`), or plugin lanes (`tests/plugin.test.ts`).
3. **Type Checking:** All code must compile cleanly under strict mode without emitting compiler errors:
   ```bash
   npm run typecheck
   ```
4. **Style Guidelines:**
   - Preserve existing code patterns and formatting (no semicolons, 2-space indentation, strict TypeScript types).
   - Don't add heavy external runtime dependencies to `dependencies`. Pure algorithms and lightweight standard library features are preferred.
5. **Commit Messages:** Follow conventional commits:
   - `feat(...)`: New feature
   - `fix(...)`: Bug fix
   - `docs(...)`: Documentation changes
   - `test(...)`: Adding or modifying tests
   - `refactor(...)`: Code refactoring without behavioral change

---

## License

By contributing to this project, you agree that your contributions will be licensed under the **GNU General Public License v3.0** (`GPL-3.0-or-later`).
