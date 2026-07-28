# Deployment and operations

## Environment variables

| Variable | Required | Notes |
|---|---:|---|
| `EXECUTION_MODE` | yes | `live` enables externally signed Ethereum mainnet swaps |
| `DATABASE_URL` | production | PostgreSQL connection; use TLS and a least-privilege role |
| `RPC_HTTP_URLS` | yes | Comma-separated fallback list |
| `ALCHEMY_RPC_URL` | recommended | Authenticated provider placed first |
| `ZEROX_API_KEY` | quote API | Server-side only |
| `ETHERSCAN_API_KEY` | optional | Verification fallback and explorer enrichment |
| `ZIG_TOKEN_ADDRESS` | yes | Ethereum ERC-20 address; verify independently |
| `WEB_ORIGIN` | yes | Exact CORS origin |
| `NEXT_PUBLIC_API_URL` | web build | Public API origin |
| `LOG_LEVEL` | no | Pino level |

## Docker ports

Containers continue to listen on `3000` (web) and `4000` (API). Docker publishes
them on configurable server ports so they do not conflict with other projects:

| Variable | Default | Purpose |
|---|---:|---|
| `WEB_HOST_PORT` | `18300` | Server port mapped to the web container |
| `API_HOST_PORT` | `18400` | Server port mapped to the API container |
| `DOCKER_BIND_ADDRESS` | `127.0.0.1` | Keep services private behind Nginx by default |
| `DOCKER_WEB_ORIGIN` | `http://localhost:18300` | Exact browser origin accepted by API CORS |
| `DOCKER_PUBLIC_API_URL` | `http://localhost:18400` | API URL compiled into the web application |

For an HTTPS deployment behind Nginx, use the real public origins:

```env
DOCKER_BIND_ADDRESS=127.0.0.1
WEB_HOST_PORT=18300
API_HOST_PORT=18400
DOCKER_WEB_ORIGIN=https://zig.example.com
DOCKER_PUBLIC_API_URL=https://api.zig.example.com
```

If the services must be reached directly by server IP without Nginx, set
`DOCKER_BIND_ADDRESS=0.0.0.0` and use that server IP in both public URLs. Do not
expose the API publicly until control endpoint authentication is implemented.

Do not place private keys, seed phrases, API secrets prefixed with `NEXT_PUBLIC_`, or raw signing material in `.env`. The Etherscan key provided during initial planning has been treated as exposed and is not committed; rotate it before use.

## Production topology

Run web and API as separate non-root, read-only containers behind TLS termination. Use managed PostgreSQL with encryption, authentication, backups, and private networking. Restrict outbound API traffic to approved RPC and observability destinations.

Deployment sequence:

1. Build immutable images in CI and produce an SBOM.
2. Scan dependencies and images; sign the images.
3. Apply database migrations from a one-shot job.
4. Deploy API with paper mode and verify `/health`, `/ready`, and `/metrics`.
5. Deploy web with the final public API URL baked in.
6. Run a paper-mode canary for at least one full operational window.
7. Enable a separately audited signer adapter for a limited canary wallet only.

## Monitoring

Alert on:

- No healthy RPC or RPC head lag.
- p95 RPC latency and error rate.
- Quote latency/error rate and liquidity failures.
- Scheduler failures, stalled cycles, and pending-sell recovery age.
- Transaction pending time, revert rate, and nonce gaps.
- Actual gas cost versus estimate.
- Balance below reserve or unexplained balance delta.
- Cycle throughput and success rate.
- API 5xx rate, event-loop lag, CPU, memory, and restart count.
- PostgreSQL connection saturation.

Prometheus scrapes `/metrics`; route structured Pino logs to a centralized sink. Hash wallet addresses and RPC credentials in telemetry where full values are unnecessary. Correlate cycle ID, trade ID, transaction hash, and request ID.

## Incident behavior

On a critical error, stop scheduling, preserve the original signed transaction and nonce state, and notify operators. Never create a replacement transaction until the pending nonce is reconciled across multiple providers. Manual stop prevents new submissions but cannot cancel an already broadcast transaction.

If the primary RPC fails before signing, request a new quote and simulate through a healthy provider. If it fails after signing, rebroadcast the exact same raw bytes. If receipt providers disagree, require quorum before moving to the next leg.

## Security checklist

- Store API credentials in a managed secret store and rotate regularly.
- Protect control endpoints with authenticated sessions and CSRF defense before internet exposure.
- Authorize every wallet and strategy; rate limiting is not authorization.
- Apply signer policies: chain ID, token allowlist, contract allowlist, max value, max gas, max daily notional, deadline, and human emergency stop.
- Use exact, short-lived allowances and revoke stale approvals.
- Validate aggregator response destinations against the provider's current official contract registry.
- Simulate the exact calldata at the latest block and reject incomplete results.
- Consider private transaction delivery such as Flashbots Protect after assessing inclusion and cancellation behavior.
- Commission independent application and signer audits.
- Back up PostgreSQL and regularly test restore procedures.

## Notifications

Implement notifications through a transactional outbox so bot start/stop, failure, high gas, low balance, RPC switch, and critical errors are delivered at least once. Slack/email/webhook adapters should never block the cycle worker and should redact wallet and transaction context according to policy.
