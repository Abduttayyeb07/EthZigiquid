# API reference

Base path: `/api/v1`. JSON is used for commands and snapshots. Error responses always contain `code`, `message`, `suggestedAction`, `retryable`, and `requestId`.

## Control and state

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/state` | Complete current snapshot |
| `GET` | `/api/v1/events` | Server-sent `snapshot` events plus heartbeats |
| `POST` | `/api/v1/automation/start` | Paper scheduler endpoint; disabled in externally signed live mode |
| `POST` | `/api/v1/automation/stop` | Idempotently stop |
| `PATCH` | `/api/v1/settings` | Update one or more validated settings |
| `POST` | `/api/v1/quotes` | Request a 0x v2 firm quote for external signing |
| `POST` | `/api/v1/approvals/preflight` | Simulate an exact ZIG approval and enforce its USD gas ceiling |
| `POST` | `/api/v1/trades/record` | Verify a confirmed mainnet receipt and reconcile live statistics |

### Settings example

```json
{
  "intervalSeconds": 30,
  "gasThresholdUsd": 1,
  "slippageBps": 100,
  "maxPriceImpactBps": 300,
  "tradeAmountEth": "0.001",
  "minimumBalanceUsd": 10,
  "maxConsecutiveFailures": 3,
  "walletAddress": "0x0000000000000000000000000000000000000001"
}
```

Bounds are deliberately enforced: interval 5–86,400 seconds, slippage 1–2,000 bps, and price impact 1–5,000 bps.

### Quote request

Amounts are integer token base units.

```json
{
  "side": "buy",
  "amount": "1000000000000000",
  "taker": "0x0000000000000000000000000000000000000001",
  "slippageBps": 100
}
```

The caller must validate `liquidityAvailable`, all `issues`, the returned allowance spender, price impact, exact transaction gas, independent simulation, and signer policy. Never approve `transaction.to` merely because it appears in a response; use the spender explicitly returned by the allowance issue and limit approval amount.

## Platform endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness, uptime, version, mode |
| `GET` | `/ready` | Readiness based on at least one healthy RPC |
| `GET` | `/metrics` | Prometheus process and service metrics |

## Error taxonomy

Typed errors cover RPC exhaustion, timeout, revert, slippage, insufficient balances, nonce conflict, congestion, disconnected signer, high price impact, missing liquidity, incomplete simulation, invalid input, and unexpected internal failures.

Retries use bounded exponential backoff with jitter in a production queue worker. Reverts, invalid allowance targets, incomplete simulation, wallet policy denial, and insufficient funds are not blindly retried.
