/**
 * HTTP transport for a warm compression sidecar.
 *
 * The sidecar contract is intentionally tiny so the worker can be Python,
 * Node/ONNX, or a test double:
 *
 *   POST <endpoint>
 *   {"text": "...", "rate": 0.6, "model": "llmlingua-2", "kind": "tool-result"}
 *   -> {"text": "..."}
 *
 * The optimizer imposes the real deadline and fail-open behavior. This client
 * also uses AbortSignal.timeout so an abandoned socket does not linger.
 */

import type { CompressionBackend, CompressionRequest } from "./optimizer.ts"

export interface HttpCompressorOptions {
  /** Full URL, for example http://127.0.0.1:8765/compress. */
  endpoint: string
  timeoutMs?: number
  fetch?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 1200

function resolveTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS
  }
  return Math.max(1, Math.floor(value))
}

function responseText(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined
  const record = body as Record<string, unknown>
  if (typeof record.text === "string") return record.text
  if (typeof record.compressed === "string") return record.compressed
  return undefined
}

export function createHttpCompressor(options: HttpCompressorOptions): CompressionBackend {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeoutMs = resolveTimeout(options.timeoutMs)
  const endpoint = options.endpoint

  return {
    async compress(request: CompressionRequest): Promise<string> {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: request.text,
          rate: request.rate,
          model: request.modelId,
          kind: request.kind,
          ...(request.toolName ? { tool: request.toolName } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (!response.ok) {
        throw new Error("compressor HTTP " + response.status)
      }

      const body: unknown = await response.json()
      const text = responseText(body)
      if (typeof text !== "string" || text.trim().length === 0) {
        throw new Error("compressor response missing text")
      }
      return text
    },
  }
}
