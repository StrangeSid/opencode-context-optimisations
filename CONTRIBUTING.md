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

- Node.js >= 22.0.0
- Npm >= 10.0.0
- (Optional) Python 3.12+ with virtual environment for running local benchmark harnesses

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
```

---

## Project Structure

- `src/classify.ts`: Fast heuristic classifier identifying content kind and token compressibility.
- `src/policy.ts`: Pure selection policy determining eligible messages and enforcing token budgets.
- `src/index.ts`: Public API exports.
- `tests/`: Node test runner test suites (`tests/*.test.ts`).
- `docs/`: Architectural specifications and decision records.
- `research/`: Experimental benchmark scripts, raw data, and upstream hook audits.

---

## Submitting Pull Requests

1. **Branch Naming:** Use clear branch prefixes:
   - `feat/feature-name`
   - `fix/bug-fix`
   - `docs/documentation-update`
   - `perf/optimization-name`
2. **Test Coverage:** Every bug fix or new classification rule must include test coverage in `tests/classify.test.ts` or `tests/policy.test.ts`.
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
