#!/usr/bin/env python3
"""Benchmark LLMLingua-2 on CPU for per-turn context compression.

Measures:
  * separate import + model-load time
  * cold (first call) and warm per-config compression latency
  * compression ratio / token counts for prose, build logs, TypeScript, and 8k prose
  * fresh-process (spawn + import + load + compress) vs warm in-process compress

Everything is deterministic and self-contained.  The Hugging Face cache is kept
inside .venv-bench/hf-cache so the experiment does not write outside the repo.

Usage:
  .venv-bench/bin/python research/bench_llmlingua.py
  .venv-bench/bin/python research/bench_llmlingua.py --runs 3 --out research/bench.json
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import os
import platform
import re
import statistics
import subprocess
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
VENV_DIR = PROJECT_ROOT / ".venv-bench"
HF_CACHE = VENV_DIR / "hf-cache"
DEFAULT_OUT = PROJECT_ROOT / "research" / "bench.json"

# Keep every artifact inside the allowed directories.
os.environ.setdefault("HF_HOME", str(HF_CACHE))
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

MODEL_NAME = "microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank"
RATES = (0.8, 0.6, 0.35)
DEFAULT_RUNS = 3  # 1 cold + 2 warm


# --------------------------------------------------------------------------
# Input corpora (synthetic but representative, deterministic)
# --------------------------------------------------------------------------

PROSE_PARAGRAPHS = [
    "Context compression is the practice of reducing the number of tokens an "
    "agent sends to a language model without discarding the information needed "
    "to complete the current task. A coding agent accumulates a large amount of "
    "material during a session: user requests, tool definitions, file reads, "
    "shell output, test failures, and its own previous reasoning. Most of that "
    "material is useful when it first arrives but becomes stale quickly. Left "
    "unmanaged, the prompt grows until it is expensive, slow, and eventually "
    "impossible to fit inside the model's window.",

    "A typical coding agent spends most of its context budget on tool output. "
    "Build logs are especially wasteful because they repeat compiler banners, "
    "package manager warnings, and progress lines while only a few lines carry "
    "the actual error. Source files are dense and usually worth keeping intact. "
    "Prose from documentation sits somewhere in between: individual sentences "
    "are compressible, but removing the wrong clause can invert the meaning. A "
    "good policy therefore treats different content types differently instead "
    "of applying one global compression rate to the entire transcript.",

    "There are two broad families of compression methods. Extractive methods "
    "select spans or tokens from the original text and keep them verbatim. "
    "Abstractive methods rewrite the text, which can achieve higher ratios but "
    "risks hallucinating details that were never present. Token-classification "
    "approaches sit in the middle: a small model scores each token as worth "
    "keeping or dropping, and the retained tokens are copied directly from the "
    "input. Because nothing is paraphrased, identifiers, file paths, and error "
    "messages survive unchanged whenever the classifier decides to keep them.",

    "LLMLingua-2 reframes prompt compression as a token classification problem. "
    "A BERT-sized encoder is fine-tuned on compression demonstrations, where "
    "each token is labeled keep or drop according to whether a downstream model "
    "can still answer questions after extraction. At inference time the encoder "
    "produces a probability for every token, and the compressor keeps the "
    "highest-scoring tokens until the requested rate is reached. The approach "
    "is task-agnostic, language-agnostic in the multilingual variant, and much "
    "faster than earlier iterative compression methods that called a generator "
    "many times.",

    "Compression is not free. Even a small encoder must tokenize the input, run "
    "a forward pass, rank every token, and rebuild the string. On a laptop CPU "
    "that cost is dominated by the forward pass and scales with sequence length. "
    "The economics only work when the saved prompt tokens are more expensive "
    "than the compression work, or when compression keeps a session inside a "
    "hard context limit. For an interactive agent that compresses on every "
    "turn, latency matters as much as ratio: adding several seconds to each "
    "request is unacceptable even if the resulting prompt is much shorter.",

    "Evaluation is the hard part. A compression ratio measured in characters "
    "says nothing about whether the result is still usable. Teams typically "
    "check downstream task accuracy, exact preservation of code and identifiers, "
    "and the fraction of critical lines that survive. Spot checks are valuable "
    "because aggregate metrics hide catastrophic failures, such as a dropped "
    "negation or a truncated stack trace. Any deployment should log before and "
    "after samples, monitor task success, and keep an uncompressed fallback for "
    "inputs that the compressor mangles.",

    "Agent frameworks complicate the picture because they rebuild the prompt on "
    "every turn. System instructions, tool schemas, and the current plan are "
    "usually stable, while new observations arrive at the end of a growing "
    "transcript. A compression layer can exploit that structure by caching the "
    "compressed form of stable prefixes and only reprocessing the newest "
    "messages. Doing so turns an expensive whole-context pass into a much "
    "smaller incremental one. It also creates an invalidation problem: when an "
    "earlier message is edited or a tool result is replaced, every cached "
    "prefix after that point must be recomputed, so the cache key has to "
    "include a content hash rather than a turn counter.",

    "A second design decision is what to compress. Compressing tool schemas or "
    "system instructions saves tokens on every turn, but a mistake there breaks "
    "the agent for the whole session. Compressing old observations is safer "
    "because the model rarely revisits them, yet it may still need an exact "
    "path or error code later. The safest default is to leave the head and tail "
    "of the transcript intact and compress only the middle, where stale tool "
    "output dominates. That policy preserves recent instructions and the "
    "current task while still removing the bulk of redundant material.",
]

SECTION_LEADS = [
    "The first observation concerns interactive latency and how users perceive it.",
    "A second theme is the difference between static prompts and evolving transcripts.",
    "Teams often underestimate how much repetition appears in ordinary tool output.",
    "The following notes focus on extraction quality rather than raw compression ratio.",
    "Operational experience adds several constraints that benchmarks rarely capture.",
    "An important caveat is that token counts depend on the model's tokenizer.",
    "Caching and warm starts change the economics more than the model architecture.",
    "Security and privacy considerations also constrain where compression can run.",
    "Long sessions expose failure modes that short evaluations never trigger.",
    "Finally, the decision should be based on end-to-end task success, not ratios alone.",
]


def build_prose_text() -> str:
    return "\n\n".join(PROSE_PARAGRAPHS)


def build_long_prose_text() -> str:
    """~8k-token variant: same themes, varied section leads and wording."""
    sections: list[str] = []
    for i, lead in enumerate(SECTION_LEADS, start=1):
        rotated = [PROSE_PARAGRAPHS[(j + i) % len(PROSE_PARAGRAPHS)]
                   for j in range(len(PROSE_PARAGRAPHS))]
        intro = (
            f"Section {i}. {lead} In this pass the working set was capped at "
            f"{1500 + i * 250} tokens and the compressor was asked to retain "
            f"roughly {55 + i}% of the input. The notes below record what "
            f"survived and what was lost."
        )
        sections.append(intro + "\n\n" + "\n\n".join(rotated))
    return "\n\n".join(sections)


LOG_LINES = [
    "2026-10-22T09:{mm:02d}:{ss:02d}.{ms:03d}Z INFO  build    [{step:02d}/{total}] compiling src/features/context/module_{i:02d}.ts",
    "2026-10-22T09:{mm:02d}:{ss:02d}.{ms:03d}Z DEBUG esbuild  resolve ../../packages/shared/src/tokens.ts -> packages/shared/dist/tokens.js",
    "npm WARN deprecated inflight@1.0.6: This module is not supported, and leaks memory. Do not use it.",
    "npm WARN config production Use `--omit=dev` instead of `--production`.",
    "> opencode-context-optimisations@0.3.0 build",
    "> tsc -p tsconfig.build.json && esbuild src/index.ts --bundle --platform=node --outfile=dist/index.js",
    "src/context/compressor.ts({line},{col}): warning TS6133: 'options' is declared but its value is never read.",
    "src/context/telemetry.ts({line},{col}): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.",
    "    at compressPrompt (/workspace/opencode-context-optimisations/src/context/compressor.ts:{line}:{col})",
    "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
    "    at async runTurn (/workspace/opencode-context-optimisations/src/agent/turn.ts:{line}:{col})",
    "Error: connect ECONNREFUSED 127.0.0.1:11434",
    "    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1595:16) {",
    "  errno: -61,",
    "  code: 'ECONNREFUSED',",
    "  syscall: 'connect',",
    "  address: '127.0.0.1',",
    "  port: 11434",
    "}",
    " ✓ tests/context/compressor.test.ts > compresses prose at rate 0.6 ({dur}ms)",
    " ✓ tests/context/compressor.test.ts > preserves fenced code blocks ({dur}ms)",
    " ✗ tests/context/compressor.test.ts > keeps stack traces intact ({dur}ms)",
    "   AssertionError: expected compressed output to contain 'ECONNREFUSED'",
    "    expected: 'ECONNREFUSED'",
    "    received: 'connect refused'",
    " ✓ tests/context/tokenizer.test.ts > counts tokens without specials ({dur}ms)",
    "stderr | tests/agent/turn.test.ts > retries transient tool failures",
    "Warning: A vi.mock factory has been hoisted; consider using vi.hoisted().",
    "Test Files  {passed} passed | {failed} failed ({total_files})",
    "     Tests  {passed_tests} passed | {failed_tests} failed ({total_tests})",
    "  Start at  09:{mm:02d}:{ss:02d}",
    "  Duration  {dur}.{ms:03d}s (transform {dur}ms, setup 412ms, collect 1.21s, tests 3.42s)",
    "webpack 5.94.0 compiled with 2 warnings in 1843 ms",
    "asset dist/index.js {kb}.{frac} KiB [emitted] [minimized] (name: main)",
    "orphan modules 412 KiB [orphan] 128 modules",
    "runtime modules 2.31 KiB 10 modules",
    "cacheable modules 1.84 MiB",
    "  modules by path ./node_modules/ 1.51 MiB 214 modules",
    "  modules by path ./src/ 338 KiB 47 modules",
    "Linting 214 files with 8 threads...",
    "✔ 212 files clean, 2 files with warnings",
    "✖ 2 problems (0 errors, 2 warnings)",
    "  src/context/metrics.ts:41:7  warning  'start' is assigned a value but never used  @typescript-eslint/no-unused-vars",
    "  src/context/metrics.ts:88:3  warning  Unexpected console statement  no-console",
    "Browserslist: browsers data (caniuse-lite) is 3 months old. Run npx update-browserslist-db@latest.",
    "vite v5.4.8 building for production...",
    "✓ {modules} modules transformed.",
    "dist/assets/index-{hash}.js  {kb}.{frac} kB │ gzip: 71.2 kB",
    "(!) Some chunks are larger than 500 kB after minification. Consider using dynamic import().",
    "PASS  src/context/__tests__/pipeline.test.ts",
    "  ● Console",
    "    console.warn",
    "      [compressor] rate 0.35 removed 4812 of 8000 tokens",
    "  ✓ fragments the transcript into cache-stable prefixes (241 ms)",
    "  ✓ falls back to the uncompressed prompt on timeout (118 ms)",
    "  ○ skipped preserves trailing whitespace",
    "ℹ tests 182",
    "ℹ suites 24",
    "ℹ pass 181",
    "ℹ fail 1",
    "ℹ cancelled 0",
    "ℹ skipped 1",
    "ℹ todo 0",
    "ℹ duration_ms 8421.337",
]


LOG_FIELD_RE = re.compile(r"\{([a-z_]+)(?::[^}]*)?\}")


def _fmt_log_line(template: str, **values) -> str:
    """Format only lines whose brace fields are all known placeholders.

    Some log lines contain literal braces (JS object dumps, stack frames), so a
    bare str.format() would fail or silently mangle them.
    """
    fields = LOG_FIELD_RE.findall(template)
    if any(field not in values for field in fields):
        return template
    try:
        return template.format(**values)
    except (KeyError, IndexError, ValueError):
        return template


def build_log_text() -> str:
    lines: list[str] = []
    for i in range(240):
        template = LOG_LINES[i % len(LOG_LINES)]
        lines.append(
            _fmt_log_line(
                template,
                mm=12 + (i // 60) % 48,
                ss=i % 60,
                ms=(i * 37) % 1000,
                step=(i % 64) + 1,
                total=64,
                i=i,
                line=40 + (i % 120),
                col=3 + (i % 40),
                dur=40 + (i * 13) % 900,
                passed=180 + (i % 3),
                failed=i % 2,
                total_files=24,
                passed_tests=180 + (i % 3),
                failed_tests=i % 2,
                total_tests=182,
                kb=180 + (i % 90),
                frac=(i * 7) % 1000,
                modules=1200 + (i % 400),
                hash=f"{(i * 2654435761) % (16 ** 8):08x}",
            )
        )
    return "\n".join(lines)


TS_HEADER = '''import { createHash } from "node:crypto";

export type CompressionRate = 0.8 | 0.6 | 0.35;

export interface CompressionOptions {
  rate: CompressionRate;
  preserve?: readonly string[];
  maxTokens?: number;
}

export interface CompressionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  ratio: number;
  checksum: string;
}

const DEFAULT_PRESERVE = ["```", "\\n", "TODO", "throw new Error"] as const;

export function checksum(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function assertNever(value: never): never {
  throw new Error(`unexpected value: ${String(value)}`);
}
'''


def build_typescript_text() -> str:
    blocks = [TS_HEADER]
    for i in range(18):
        blocks.append(
            f'''
export class ContextCompressor{i} {{
  private readonly cache = new Map<string, CompressionResult>();
  private readonly preserve: readonly string[];

  constructor(private readonly options: CompressionOptions) {{
    this.preserve = options.preserve ?? DEFAULT_PRESERVE;
  }}

  public async compress(input: string): Promise<CompressionResult> {{
    const cached = this.cache.get(input);
    if (cached !== undefined) {{
      return cached;
    }}

    const inputTokens = countTokens(input);
    const target = Math.floor(inputTokens * this.options.rate);
    const lines = input.split("\\n");
    const kept: string[] = [];

    for (const line of lines) {{
      if (kept.length >= target) {{
        break;
      }}
      if (this.preserve.some((token) => line.includes(token))) {{
        kept.push(line);
        continue;
      }}
      if (line.trim().length > 0 && !line.startsWith("npm WARN")) {{
        kept.push(line);
      }}
    }}

    const text = kept.join("\\n");
    const outputTokens = countTokens(text);
    const result: CompressionResult = {{
      text,
      inputTokens,
      outputTokens,
      ratio: inputTokens === 0 ? 1 : outputTokens / inputTokens,
      checksum: checksum(text),
    }};
    this.cache.set(input, result);
    return result;
  }}
}}

export function countTokens(text: string): number {{
  return text.trim().length === 0 ? 0 : Math.ceil(text.length / 4);
}}

export async function compressBatch{i}(
  inputs: readonly string[],
  options: CompressionOptions,
): Promise<readonly CompressionResult[]> {{
  const compressor = new ContextCompressor{i}(options);
  const results: CompressionResult[] = [];
  for (const input of inputs) {{
    if (input.length > 1_000_000) {{
      throw new Error("input exceeds the 1 MB safety limit");
    }}
    results.push(await compressor.compress(input));
  }}
  return results;
}}
'''
        )
    return "".join(blocks)


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def token_count(tokenizer, text: str) -> int:
    try:
        return len(tokenizer(text, add_special_tokens=False, truncation=False)["input_ids"])
    except Exception:
        return max(1, round(len(text) / 4))


def fit_to_tokens(tokenizer, text: str, target: int, kind: str) -> str:
    """Select whole lines/paragraphs up to ~target tokens.

    Never decode truncated token IDs: the BERT tokenizer inserts spaces around
    punctuation, which would turn code and log timestamps into mangled text and
    make the benchmark unrepresentative.  Selecting whole chunks preserves the
    original bytes.
    """
    sep = "\n" if kind in ("code", "log") else "\n\n"
    chunks = [c for c in text.split(sep) if c.strip()]
    selected: list[str] = []
    limit = int(target * 1.03)
    for chunk in chunks:
        candidate = selected + [chunk]
        used = token_count(tokenizer, sep.join(candidate))
        if selected and used > limit:
            break
        selected = candidate
        if used >= target:
            break
    return sep.join(selected).strip()


INPUT_MARKERS = {
    "prose_1k": ["token classification", "compression", "not ", "without "],
    "build_log_2k": ["ECONNREFUSED", "error TS2345", "AssertionError", "tests 182", "PASS"],
    "typescript_1k": [
        "export interface CompressionOptions",
        "export class ContextCompressor",
        "createHash",
        "throw new Error",
        "async compress",
    ],
    "prose_8k": ["token classification", "compression", "not ", "without "],
}


def make_inputs(tokenizer) -> dict[str, dict]:
    builders = {
        "prose_1k": ("prose", 1000, build_prose_text()),
        "build_log_2k": ("log", 2000, build_log_text()),
        "typescript_1k": ("code", 1000, build_typescript_text()),
        "prose_8k": ("prose", 8000, build_long_prose_text()),
    }
    inputs: dict[str, dict] = {}
    for name, (kind, target, raw) in builders.items():
        text = fit_to_tokens(tokenizer, raw, target, kind)
        inputs[name] = {
            "kind": kind,
            "target_tokens": target,
            "text": text,
            "chars": len(text),
            "tokens": token_count(tokenizer, text),
            "lines": text.count("\n") + 1,
            "markers": INPUT_MARKERS[name],
        }
    return inputs


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def du_kb(path: Path) -> int:
    try:
        out = subprocess.run(
            ["du", "-sk", str(path)], capture_output=True, text=True, check=True
        ).stdout
        return int(out.split()[0])
    except Exception:
        total = 0
        for root, _dirs, files in os.walk(path):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
        return total // 1024


def package_versions() -> dict[str, str]:
    from importlib.metadata import PackageNotFoundError, version

    versions = {}
    for pkg in ("llmlingua", "torch", "transformers", "tokenizers", "huggingface-hub", "numpy"):
        try:
            versions[pkg] = version(pkg)
        except PackageNotFoundError:
            versions[pkg] = "not-installed"
    return versions


def load_compressor():
    """Import heavy deps and load the model; returns (compressor, timings)."""
    t0 = time.perf_counter()
    from llmlingua import PromptCompressor  # noqa: PLC0415
    import torch  # noqa: PLC0415

    import_s = time.perf_counter() - t0
    threads = torch.get_num_threads()

    t1 = time.perf_counter()
    compressor = PromptCompressor(
        model_name=MODEL_NAME,
        use_llmlingua2=True,
        device_map="cpu",
    )
    load_s = time.perf_counter() - t1
    return compressor, {
        "import_s": import_s,
        "load_s": load_s,
        "torch_threads": threads,
    }


NEGATIONS = (" not ", " never ", " without ", " cannot ", "n't ")


def compress_once(compressor, tokenizer, text: str, rate: float,
                  markers: list[str] | None = None) -> dict:
    t0 = time.perf_counter()
    result = compressor.compress_prompt(text, rate=rate)
    wall_s = time.perf_counter() - t0
    output = result["compressed_prompt"]
    in_tokens = token_count(tokenizer, text)
    out_tokens = token_count(tokenizer, output)
    low_in, low_out = text.lower(), output.lower()
    markers = markers or []
    return {
        "wall_s": wall_s,
        "in_tokens": in_tokens,
        "out_tokens": out_tokens,
        "in_chars": len(text),
        "out_chars": len(output),
        "ratio": out_tokens / in_tokens if in_tokens else 0.0,
        "output_sha": sha(output),
        "reported_origin_tokens": result.get("origin_tokens"),
        "reported_compressed_tokens": result.get("compressed_tokens"),
        "reported_ratio": result.get("ratio"),
        "markers_total": len(markers),
        "markers_kept": [m for m in markers if m in output],
        "negations_in": sum(low_in.count(w) for w in NEGATIONS),
        "negations_out": sum(low_out.count(w) for w in NEGATIONS),
        "sample_output": output,
    }


def env_info() -> dict:
    chip = ""
    try:
        chip = subprocess.run(
            ["sysctl", "-n", "machdep.cpu.brand_string"],
            capture_output=True, text=True, check=False,
        ).stdout.strip()
    except Exception:
        pass
    mem_bytes = None
    try:
        mem_bytes = int(subprocess.run(
            ["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, check=True
        ).stdout.strip())
    except Exception:
        pass
    return {
        "timestamp": now_iso(),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "chip": chip,
        "cpu_count": os.cpu_count(),
        "memory_gb": round(mem_bytes / 1024 ** 3, 2) if mem_bytes else None,
        "python": sys.version.split()[0],
        "python_executable": sys.executable,
        "model": MODEL_NAME,
        "hf_home": str(HF_CACHE),
        "rates": list(RATES),
    }


# --------------------------------------------------------------------------
# Main benchmark
# --------------------------------------------------------------------------


def run_benchmark(args) -> int:
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    t_start = time.perf_counter()

    payload: dict = {
        "meta": {**env_info(), "runs_per_config": args.runs},
        "status": "starting",
        "load": {},
        "install_footprint": {},
        "latency": [],
        "process": {},
        "examples": {},
        "errors": [],
    }

    def save() -> None:
        out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))

    try:
        compressor, timings = load_compressor()
        payload["load"] = {
            **timings,
            "ready_from_process_start_s": time.perf_counter() - t_start,
        }
        tokenizer = compressor.tokenizer
        payload["meta"]["versions"] = package_versions()
        payload["meta"]["tokenizer_class"] = type(tokenizer).__name__
        payload["install_footprint"] = {
            "venv_kb": du_kb(VENV_DIR),
            "site_packages_kb": du_kb(VENV_DIR / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages"),
            "hf_cache_kb": du_kb(HF_CACHE),
            "hf_cache_files": sum(len(files) for _, _, files in os.walk(HF_CACHE)),
        }
        payload["status"] = "loaded"
        save()
        print(f"loaded {MODEL_NAME} in {timings['load_s']:.2f}s "
              f"(import {timings['import_s']:.2f}s, threads {timings['torch_threads']})",
              flush=True)

        inputs = make_inputs(tokenizer)
        payload["inputs"] = {
            name: {k: v for k, v in info.items() if k != "text"} | {"sha": sha(info["text"])[:16]}
            for name, info in inputs.items()
        }
        save()

        for name, info in inputs.items():
            for rate in RATES:
                runs = []
                for run_idx in range(args.runs):
                    runs.append(compress_once(
                        compressor, tokenizer, info["text"], rate, info["markers"]
                    ))
                    payload["latency"].append({
                        "input": name,
                        "kind": info["kind"],
                        "target_tokens": info["target_tokens"],
                        "actual_input_tokens": info["tokens"],
                        "rate": rate,
                        "run": run_idx,
                        "cold": run_idx == 0,
                        **{k: v for k, v in runs[-1].items() if k != "sample_output"},
                    })
                warm = [r["wall_s"] for r in runs[1:]] or [runs[0]["wall_s"]]
                warm_median = statistics.median(warm)
                entry = {
                    "input": name,
                    "kind": info["kind"],
                    "target_tokens": info["target_tokens"],
                    "input_tokens": runs[0]["in_tokens"],
                    "input_chars": runs[0]["in_chars"],
                    "rate": rate,
                    "cold_ms": round(runs[0]["wall_s"] * 1000, 1),
                    "warm_median_ms": round(warm_median * 1000, 1),
                    "warm_min_ms": round(min(warm) * 1000, 1),
                    "warm_max_ms": round(max(warm) * 1000, 1),
                    "output_tokens": runs[-1]["out_tokens"],
                    "output_chars": runs[-1]["out_chars"],
                    "ratio": round(runs[-1]["ratio"], 4),
                    "reported_ratio": runs[-1]["reported_ratio"],
                    "output_sha": runs[-1]["output_sha"],
                    "deterministic_warm": len({r["output_sha"] for r in runs[1:]}) <= 1,
                    "markers_kept": runs[-1]["markers_kept"],
                    "markers_total": runs[-1]["markers_total"],
                    "negations_in": runs[-1]["negations_in"],
                    "negations_out": runs[-1]["negations_out"],
                }
                payload.setdefault("summary", []).append(entry)
                if rate in (0.6, 0.35):
                    payload["examples"][f"{name}@{rate}"] = {
                        "before": info["text"][:1800],
                        "after": runs[-1]["sample_output"][:12000],
                        "full_output_chars": runs[-1]["out_chars"],
                        "full_output_sha": runs[-1]["output_sha"],
                    }
                print(f"  {name:14s} rate={rate:<4} cold={entry['cold_ms']:8.1f}ms "
                      f"warm={entry['warm_median_ms']:8.1f}ms "
                      f"tokens {entry['input_tokens']}->{entry['output_tokens']} "
                      f"({entry['ratio']:.3f})", flush=True)
                save()

        if not args.skip_process:
            payload["process"] = benchmark_process(args.runs, inputs["prose_1k"]["text"])
            save()

        payload["status"] = "complete"
    except Exception as exc:  # noqa: BLE001
        import traceback
        payload["status"] = "failed"
        payload["errors"].append({"error": repr(exc), "traceback": traceback.format_exc()})
        save()
        print(f"FAILED: {exc!r}", file=sys.stderr)
        traceback.print_exc()
        return 1

    save()
    print_table(payload)
    print(f"\nraw results: {out_path}")
    return 0


def benchmark_process(runs: int, text: str) -> dict:
    """Spawn fresh Python processes that load + compress, vs warm in-process."""
    env = os.environ.copy()
    env["HF_HOME"] = str(HF_CACHE)
    env["HF_HUB_OFFLINE"] = "1"
    env["TRANSFORMERS_OFFLINE"] = "1"
    rate = 0.6
    children = []
    for i in range(max(2, runs)):
        t0 = time.perf_counter()
        proc = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--child", "--rate", str(rate)],
            input=text,
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
        wall_s = time.perf_counter() - t0
        child = None
        for line in proc.stdout.splitlines():
            if line.startswith("BENCH_JSON "):
                child = json.loads(line[len("BENCH_JSON "):])
        if child is None:
            return {
                "error": f"child failed rc={proc.returncode}",
                "stderr": proc.stderr[-4000:],
                "stdout": proc.stdout[-1000:],
            }
        child["wall_s"] = wall_s
        child["returncode"] = proc.returncode
        children.append(child)
        print(f"  cold process run {i + 1}: {wall_s * 1000:.0f}ms "
              f"(import {child['import_s'] * 1000:.0f}ms, "
              f"load {child['load_s'] * 1000:.0f}ms, "
              f"compress {child['compress_s'] * 1000:.0f}ms)", flush=True)
    walls = [c["wall_s"] for c in children[1:]] or [c["wall_s"] for c in children]
    return {
        "rate": rate,
        "input": "prose_1k",
        "children": children,
        "cold_wall_median_s": statistics.median(walls),
        "cold_wall_min_s": min(walls),
        "cold_wall_max_s": max(walls),
    }


def run_child(rate: float) -> int:
    text = sys.stdin.read()
    t0 = time.perf_counter()
    compressor, timings = load_compressor()
    t_loaded = time.perf_counter()
    result = compressor.compress_prompt(text, rate=rate)
    t_done = time.perf_counter()
    sys.stdout.write("BENCH_JSON " + json.dumps({
        **timings,
        "compress_s": t_done - t_loaded,
        "internal_total_s": t_done - t0,
        "in_chars": len(text),
        "out_chars": len(result["compressed_prompt"]),
        "output_sha": sha(result["compressed_prompt"]),
    }) + "\n")
    return 0


def print_table(payload: dict) -> None:
    summary = payload.get("summary", [])
    if not summary:
        return
    print("\n### Latency and compression (CPU)\n")
    print("| input | in tok | rate | cold ms | warm median ms | out tok | keep | markers | chars in→out |")
    print("|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    for row in summary:
        print(
            f"| {row['input']} | {row['input_tokens']} | {row['rate']} | "
            f"{row['cold_ms']:.0f} | {row['warm_median_ms']:.0f} | "
            f"{row['output_tokens']} | {row['ratio']:.3f} | "
            f"{len(row['markers_kept'])}/{row['markers_total']} | "
            f"{row['input_chars']}→{row['output_chars']} |"
        )
    proc = payload.get("process") or {}
    if proc.get("cold_wall_median_s"):
        print("\n### Fresh process vs warm compression\n")
        print("| path | median ms |")
        print("|---|---:|")
        print(f"| spawn + import + load + compress (offline) | {proc['cold_wall_median_s'] * 1000:.0f} |")
        children = proc["children"]
        load_ms = statistics.median(c["load_s"] for c in children) * 1000
        import_ms = statistics.median(c["import_s"] for c in children) * 1000
        print(f"| model load only (offline child) | {load_ms:.0f} |")
        print(f"| import only (offline child) | {import_ms:.0f} |")
        print(f"| model load, online parent (incl. HF checks) | {payload['load']['load_s'] * 1000:.0f} |")
        warm = next(
            (r["warm_median_ms"] for r in summary
             if r["input"] == "prose_1k" and r["rate"] == 0.6),
            None,
        )
        if warm is not None:
            print(f"| warm compress (prose_1k @ 0.6) | {warm:.0f} |")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=DEFAULT_RUNS,
                        help=f"runs per config, first is cold (default {DEFAULT_RUNS})")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="raw JSON output path")
    parser.add_argument("--skip-process", action="store_true",
                        help="skip fresh-process experiment")
    parser.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--rate", type=float, default=0.6, help=argparse.SUPPRESS)
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args()
    if args.child:
        return run_child(args.rate)
    return run_benchmark(args)


if __name__ == "__main__":
    raise SystemExit(main())
