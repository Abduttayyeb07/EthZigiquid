# ZIG Flow

Server-side Ethereum automation that repeatedly:

1. Buys ZIG with a configured amount of ETH.
2. Sells the exact ZIG received back to ETH.
3. Waits for the configured interval and repeats.

The frontend collects the wallet address and private key once. The backend
verifies them, signs transactions, and executes swaps directly through the
Uniswap V2 router. No browser wallet confirmation is required.

## Safety behavior

- Every swap is quoted and simulated before broadcast.
- Gas, slippage, price impact, ETH reserve, and token balances are checked.
- Temporary RPC and liquidity failures retry with RPC failover.
- A failed sell is retried before another buy can run.
- An already-broadcast transaction is monitored across multiple RPC providers.
- Manual Stop prevents new submissions and clears the wallet address, private
  key, pending state, and balances from memory and PostgreSQL.
- Graceful container restarts preserve encrypted state so active automation can
  resume.

Manual Stop cannot cancel a transaction that was already broadcast.

## Local development

Requirements: Node.js 22+, npm, PostgreSQL, and Ethereum RPC access.

```powershell
copy .env.example .env
npm install
npm run dev
```

Default development URLs:

- Frontend: `http://localhost:3000`
- API: `http://localhost:4000`

Enter the value of `CONTROL_API_TOKEN` on the operator access screen.

## Required configuration

Set these values in `.env` before live use:

```env
CONTROL_API_TOKEN=choose-a-strong-private-token
STATE_ENCRYPTION_KEY=64-hex-characters
POSTGRES_PASSWORD=choose-a-url-safe-password
EXECUTION_MODE=live
ZIG_TOKEN_ADDRESS=0x...
RPC_HTTP_URLS=https://rpc-one.example,https://rpc-two.example
```

Generate an encryption key with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Docker deployment

```powershell
docker compose build
docker compose up -d
docker compose ps
```

Default host ports:

- Web: `18300`
- API: `18400`

Change them with `WEB_HOST_PORT` and `API_HOST_PORT`. Services bind to
`127.0.0.1` by default so they can sit safely behind Nginx or another reverse
proxy.

## Production warning

Use HTTPS before entering a funded wallet private key. Plain HTTP, including a
direct server IP over HTTP, exposes credentials in transit. Start with a
dedicated low-value wallet and verify the token, router, RPC endpoints, gas
limit, and trade amount before enabling live automation.

Useful checks before deployment:

```powershell
npm test
npm run lint
npm run typecheck
npm run build
npm audit --omit=dev
docker compose config
```

