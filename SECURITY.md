# Security Policy

## Supported Versions

Only the latest release and the current `main` branch receive security patches.

| Version | Supported          |
| ------- | ------------------ |
| `0.0.x` | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability or sensitive information handling flaw within this repository, please report it privately:

1. **Don't create a public issue.**
2. Open a private security advisory through GitHub's Security Advisory tab on the repository, or contact the maintainers directly.
3. Include details of the vulnerability, reproduction steps, and potential impact.

You'll receive an acknowledgment within 48 hours, followed by a status update once the issue is validated.

## Local sidecar

`python/llmlingua_worker.py` binds to `127.0.0.1` by default and has no authentication. Do not expose it on a public interface or share the port with untrusted processes. Compression requests contain transcript text; treat worker requests, the plugin's in-memory cache, and debug output as sensitive.

## Credentials and evaluation

`OC_GO_KEY` is read from the gitignored `.env` file. Never commit `.env`, paste the key into an issue, or include it in logs. The repository ignores `.env` and `.env.*` except `.env.example`.

`research/eval_quality.mjs` sends its synthetic transcript and questions to the configured OpenCode Go endpoint. It does not read the OpenCode session database, but the request still leaves the machine. Use the synthetic fixture or review your data-retention expectations before pointing it at production transcript data.
