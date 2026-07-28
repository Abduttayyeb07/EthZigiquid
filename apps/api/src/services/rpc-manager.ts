import { JsonRpcProvider, type TransactionReceipt, type TransactionRequest } from "ethers";
import type { RpcHealth } from "@zig/shared";
import { AppError } from "../lib/errors.js";

const RPC_REQUEST_TIMEOUT_MS = 12_000;
const RECEIPT_POLL_INTERVAL_MS = 4_000;

interface RpcNode {
  url: string;
  provider: JsonRpcProvider;
  health: RpcHealth;
}

export class RpcManager {
  private readonly nodes: RpcNode[];
  private activeIndex = 0;

  constructor(urls: readonly string[]) {
    this.nodes = urls.map((url, index) => ({
      url,
      provider: new JsonRpcProvider(url, 1, { staticNetwork: true }),
      health: {
        url: redactRpcUrl(url),
        healthy: false,
        latencyMs: null,
        blockNumber: null,
        failures: 0,
        lastCheckedAt: null,
        active: index === 0,
      },
    }));
  }

  async withProvider<T>(operation: (provider: JsonRpcProvider) => Promise<T>): Promise<T> {
    const attempts = this.nodes.length;
    for (let offset = 0; offset < attempts; offset += 1) {
      const index = (this.activeIndex + offset) % attempts;
      const node = this.nodes[index];
      if (!node) continue;
      try {
        const result = await withTimeout(operation(node.provider), RPC_REQUEST_TIMEOUT_MS);
        this.select(index);
        return result;
      } catch {
        node.health.healthy = false;
        node.health.failures += 1;
      }
    }
    throw new AppError("RPC_UNAVAILABLE");
  }

  async estimateGas(transaction: TransactionRequest): Promise<bigint> {
    return this.withProvider((provider) => provider.estimateGas(transaction));
  }

  async simulate(transaction: TransactionRequest): Promise<string> {
    return this.withProvider((provider) => provider.call(transaction));
  }

  async getFeeData() {
    return this.withProvider((provider) => provider.getFeeData());
  }

  async getBalance(address: string): Promise<bigint> {
    return this.withProvider((provider) => provider.getBalance(address));
  }

  async getHealthyProvider(): Promise<JsonRpcProvider> {
    return this.withProvider(async (provider) => {
      await provider.getBlockNumber();
      return provider;
    });
  }

  async getTransactionReceipt(hash: string) {
    return this.withProvider((provider) => provider.getTransactionReceipt(hash));
  }

  async broadcastTransaction(signedTransaction: string) {
    return this.withProvider((provider) => provider.broadcastTransaction(signedTransaction));
  }

  async waitForTransactionReceipt(hash: string, signedTransaction: string): Promise<TransactionReceipt> {
    let pollCount = 0;
    while (true) {
      const results = await Promise.allSettled(
        this.nodes.map((node) =>
          withTimeout(node.provider.getTransactionReceipt(hash), RPC_REQUEST_TIMEOUT_MS),
        ),
      );

      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled") {
          const node = this.nodes[index];
          if (node) node.health.healthy = true;
          if (result.value) {
            this.select(index);
            return result.value;
          }
        } else {
          const node = this.nodes[index];
          if (node) {
            node.health.healthy = false;
            node.health.failures += 1;
          }
        }
      }

      pollCount += 1;
      if (pollCount % 5 === 0) {
        // Re-broadcasting identical signed bytes is idempotent. It helps when
        // the first provider accepted the transaction but did not propagate it.
        try {
          await this.broadcastTransaction(signedTransaction);
        } catch {
          // Receipt polling continues across every configured provider.
        }
      }
      await delay(RECEIPT_POLL_INTERVAL_MS);
    }
  }

  async healthCheck(): Promise<RpcHealth[]> {
    await Promise.allSettled(
      this.nodes.map(async (node, index) => {
        const started = performance.now();
        try {
          const blockNumber = await withTimeout(node.provider.getBlockNumber(), RPC_REQUEST_TIMEOUT_MS);
          node.health = {
            ...node.health,
            healthy: true,
            latencyMs: Math.round(performance.now() - started),
            blockNumber,
            lastCheckedAt: new Date().toISOString(),
            active: index === this.activeIndex,
          };
        } catch {
          node.health = {
            ...node.health,
            healthy: false,
            latencyMs: Math.round(performance.now() - started),
            failures: node.health.failures + 1,
            lastCheckedAt: new Date().toISOString(),
            active: index === this.activeIndex,
          };
        }
      }),
    );
    if (!this.nodes[this.activeIndex]?.health.healthy) {
      const healthyIndex = this.nodes.findIndex((node) => node.health.healthy);
      if (healthyIndex >= 0) this.select(healthyIndex);
    }
    return this.snapshot();
  }

  snapshot(): RpcHealth[] {
    return this.nodes.map((node) => ({ ...node.health }));
  }

  destroy(): void {
    for (const node of this.nodes) node.provider.destroy();
  }

  private select(index: number): void {
    this.activeIndex = index;
    this.nodes.forEach((node, nodeIndex) => {
      node.health.active = nodeIndex === index;
    });
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC request timed out after ${timeoutMs}ms`)), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactRpcUrl(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname === "/" ? "" : "/***";
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return "configured-rpc";
  }
}
