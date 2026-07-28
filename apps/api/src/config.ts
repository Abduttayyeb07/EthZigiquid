import { z } from "zod";
import { resolve } from "node:path";

if (!process.env.NODE_ENV || process.env.NODE_ENV === "development") {
  try {
    process.loadEnvFile();
  } catch {
    try {
      process.loadEnvFile(resolve(process.cwd(), "..", "..", ".env"));
    } catch {
      // Production containers inject environment variables and do not mount .env.
    }
  }
}

const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().optional(),
);
const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().url().optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  HOST: z.string().default("0.0.0.0"),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  WEB_ORIGIN: z.string().url(),
  CONTROL_API_TOKEN: z.string().min(1),
  STATE_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  PERSIST_RUNTIME_STATE: z.enum(["true", "false"]).default("false"),
  EXECUTION_MODE: z.enum(["paper", "live"]).default("live"),
  DATABASE_URL: z.string(),
  ZIG_TOKEN_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .default("0xb2617246d0c6c0087f18703d576831899ca94f01"),
  UNISWAP_V2_ROUTER_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .default("0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"),
  WETH_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .default("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
  ALCHEMY_RPC_URL: optionalUrl,
  ETHERSCAN_API_KEY: optionalString,
  RPC_HTTP_URLS: z.string().default(
    "https://eth.llamarpc.com,https://ethereum.publicnode.com,https://rpc.ankr.com/eth,https://cloudflare-eth.com,https://eth-mainnet.public.blastapi.io,https://1rpc.io/eth,https://rpc.flashbots.net,https://endpoints.omniatech.io/v1/eth/mainnet/public",
  ),
  RPC_WS_URLS: z.string().default("wss://ethereum.publicnode.com,wss://eth.llamarpc.com"),
  ETH_RPC_URLS: optionalString,
  ETH_WS_URLS: optionalString,
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}

const env = parsed.data;
export const config = {
  ...env,
  trustProxy: env.TRUST_PROXY === "true",
  persistRuntimeState: env.PERSIST_RUNTIME_STATE === "true",
  rpcHttpUrls: [
    ...(env.ALCHEMY_RPC_URL ? [env.ALCHEMY_RPC_URL] : []),
    ...(env.ETH_RPC_URLS ?? env.RPC_HTTP_URLS).split(",").map((value) => value.trim()).filter(Boolean),
  ],
  rpcWsUrls: (env.ETH_WS_URLS ?? env.RPC_WS_URLS)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
} as const;
