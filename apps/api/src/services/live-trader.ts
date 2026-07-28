import {
  Contract,
  Wallet,
  formatUnits,
  parseUnits,
  type JsonRpcProvider,
  type TransactionReceipt,
  type TransactionRequest,
} from "ethers";
import type { WalletBalances } from "@zig/shared";
import { AppError } from "../lib/errors.js";
import type { GasService } from "./gas-service.js";
import type { RpcManager } from "./rpc-manager.js";

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
] as const;

const UNISWAP_V2_ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)",
  "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory amounts)",
  "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)",
] as const;

export interface WalletBalanceSnapshot extends WalletBalances {
  ethRaw: bigint;
  zigRaw: bigint;
}

export interface ExecutedSwap {
  side: "buy" | "sell";
  hash: string;
  soldRaw: string;
  receivedRaw: string;
  gasUsd: number;
  gasEth: number;
  quotedOutRaw: string;
  minOutRaw: string;
}

export interface BuySimulation {
  amountInEth: string;
  amountInUsd: number;
  ethUsd: number;
  estimatedZig: string;
  impliedZigUsd: number;
  minimumZig: string;
  slippageBps: number;
}

export class LiveTrader {
  private readonly zigContract: string;
  private readonly routerAddress: string;
  private readonly wethAddress: string;

  constructor(
    private readonly rpc: RpcManager,
    private readonly gas: GasService,
    zigTokenAddress: string,
    routerAddress: string,
    wethAddress: string,
  ) {
    this.zigContract = zigTokenAddress;
    this.routerAddress = routerAddress;
    this.wethAddress = wethAddress;
  }

  async verifyCredentials(walletAddress: string, privateKey: string): Promise<string> {
    const wallet = new Wallet(normalizePrivateKey(privateKey));
    if (wallet.address.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new AppError("INVALID_REQUEST", "The private key does not match the provided wallet address.", 400);
    }
    return wallet.address;
  }

  async getBalances(walletAddress: string): Promise<WalletBalanceSnapshot> {
    return this.rpc.withProvider(async (provider) => this.readBalances(provider, walletAddress));
  }

  async simulateBuy(amountEth: string, slippageBps: number): Promise<BuySimulation> {
    const amountInRaw = this.parseEthAmount(amountEth);
    const [quotedOutRaw, ethUsd] = await Promise.all([
      this.rpc.withProvider(async (provider) =>
        this.quoteAmountOut(provider, amountInRaw.toString(), [this.wethAddress, this.zigContract]),
      ),
      this.gas.getEthUsdPrice(),
    ]);
    const minimumZigRaw = applySlippage(quotedOutRaw, slippageBps);
    const estimatedZig = formatUnits(BigInt(quotedOutRaw), 18);
    const amountInUsd = Number(amountEth) * ethUsd;
    return {
      amountInEth: amountEth,
      amountInUsd,
      ethUsd,
      estimatedZig,
      impliedZigUsd: Number(estimatedZig) > 0 ? amountInUsd / Number(estimatedZig) : 0,
      minimumZig: formatUnits(BigInt(minimumZigRaw), 18),
      slippageBps,
    };
  }

  async executeSwap(input: {
    side: "buy" | "sell";
    walletAddress: string;
    privateKey: string;
    amountRaw: string;
    slippageBps: number;
    gasThresholdUsd: number;
    maxPriceImpactBps: number;
    minimumBalanceUsd: number;
    shouldContinue?: (() => boolean) | undefined;
  }): Promise<ExecutedSwap> {
    const provider = await this.rpc.getHealthyProvider();
    const router = new Contract(this.routerAddress, UNISWAP_V2_ROUTER_ABI, provider);
    let before = await this.readBalances(provider, input.walletAddress);
    assertExecutionContinues(input.shouldContinue);
    const deadline = BigInt(Math.floor(Date.now() / 1_000) + 600);
    const path = input.side === "buy" ? [this.wethAddress, this.zigContract] : [this.zigContract, this.wethAddress];
    const quotedOutRaw = await this.quoteAmountOut(provider, input.amountRaw, path);
    const roundTripRaw = await this.quoteAmountOut(provider, quotedOutRaw, [...path].reverse());
    const priceImpactBps = Number(
      ((BigInt(input.amountRaw) - BigInt(roundTripRaw)) * 10_000n) / BigInt(input.amountRaw),
    );
    assertExecutionContinues(input.shouldContinue);
    if (priceImpactBps > input.maxPriceImpactBps) {
      throw new AppError(
        "PRICE_IMPACT_HIGH",
        `Estimated round-trip impact ${priceImpactBps} bps exceeds ${input.maxPriceImpactBps} bps.`,
        409,
      );
    }
    const minOutRaw = applySlippage(quotedOutRaw, input.slippageBps);

    if (input.side === "buy") {
      const ethUsd = await this.gas.getEthUsdPrice();
      const remainingRaw = before.ethRaw - BigInt(input.amountRaw);
      const remainingUsd = Number(formatUnits(remainingRaw > 0n ? remainingRaw : 0n, 18)) * ethUsd;
      if (remainingUsd < input.minimumBalanceUsd) {
        throw new AppError(
          "INSUFFICIENT_ETH",
          `The trade would leave ${remainingUsd.toFixed(2)} USD in ETH, below the ${input.minimumBalanceUsd.toFixed(2)} USD reserve.`,
          409,
        );
      }
    }

    if (input.side === "sell") {
      if (before.zigRaw < BigInt(input.amountRaw)) {
        throw new AppError(
          "INSUFFICIENT_ZIG",
          `Wallet balance is below the locked sell amount of ${input.amountRaw} base units.`,
          409,
        );
      }
      await this.ensureApproval({
        privateKey: input.privateKey,
        owner: input.walletAddress,
        spender: this.routerAddress,
        amountRaw: input.amountRaw,
        gasThresholdUsd: input.gasThresholdUsd,
        shouldContinue: input.shouldContinue,
      });
      assertExecutionContinues(input.shouldContinue);
      // Approval consumes ETH gas. Use a fresh baseline so approval cost is
      // not incorrectly subtracted from the swap's reported ETH proceeds.
      before = await this.readBalances(provider, input.walletAddress);
    }

    const transactionResponse = input.side === "buy"
      ? await this.sendBuy({
          privateKey: input.privateKey,
          router,
          walletAddress: input.walletAddress,
          amountInRaw: input.amountRaw,
          minOutRaw,
          path,
          deadline,
          gasThresholdUsd: input.gasThresholdUsd,
          shouldContinue: input.shouldContinue,
        })
      : await this.sendSell({
          privateKey: input.privateKey,
          router,
          walletAddress: input.walletAddress,
          amountInRaw: input.amountRaw,
          minOutRaw,
          path,
          deadline,
          gasThresholdUsd: input.gasThresholdUsd,
          shouldContinue: input.shouldContinue,
        });

    const receipt = transactionResponse.receipt;
    if (!receipt || receipt.status !== 1) throw new AppError("SWAP_REVERTED", undefined, 409);
    const after = await this.readBalances(provider, input.walletAddress);
    const receivedRaw = input.side === "buy"
      ? clampBigint(after.zigRaw - before.zigRaw).toString()
      : computeEthReceived(before.ethRaw, after.ethRaw, receipt).toString();

    return {
      side: input.side,
      hash: transactionResponse.hash,
      soldRaw: input.amountRaw,
      receivedRaw,
      gasUsd: transactionResponse.gasEstimate.feeUsd,
      gasEth: transactionResponse.gasEstimate.feeEth,
      quotedOutRaw,
      minOutRaw,
    };
  }

  parseEthAmount(value: string): bigint {
    try {
      return parseUnits(value, 18);
    } catch {
      throw new AppError("INVALID_REQUEST", "Trade amount must be a valid ETH decimal value.", 400);
    }
  }

  private async quoteAmountOut(provider: JsonRpcProvider, amountInRaw: string, path: string[]): Promise<string> {
    const router = new Contract(this.routerAddress, UNISWAP_V2_ROUTER_ABI, provider);
    try {
      const amounts = (await router.getFunction("getAmountsOut").staticCall(BigInt(amountInRaw), path)) as bigint[];
      const result = amounts.at(-1);
      if (!result || result <= 0n) throw new Error("empty quote");
      return result.toString();
    } catch {
      throw new AppError("LIQUIDITY_UNAVAILABLE", "Uniswap V2 could not quote the configured ETH/ZIG path.", 409);
    }
  }

  private async sendBuy(input: {
    privateKey: string;
    router: Contract;
    walletAddress: string;
    amountInRaw: string;
    minOutRaw: string;
    path: string[];
    deadline: bigint;
    gasThresholdUsd: number;
    shouldContinue?: (() => boolean) | undefined;
  }) {
    const populated = await input.router.getFunction("swapExactETHForTokens").populateTransaction(
      BigInt(input.minOutRaw),
      input.path,
      input.walletAddress,
      input.deadline,
      { value: BigInt(input.amountInRaw) },
    );
    const transaction: TransactionRequest = {
      from: input.walletAddress,
      to: this.routerAddress,
      data: populated.data,
      value: BigInt(input.amountInRaw),
    };
    const gasEstimate = await this.assertGasWithinThreshold(transaction, input.gasThresholdUsd);
    assertExecutionContinues(input.shouldContinue);
    const submitted = await this.submitTransaction(input.privateKey, {
      ...transaction,
      gasLimit: gasEstimate.gasLimit,
      maxFeePerGas: gasEstimate.maxFeePerGas,
    });
    return {
      ...submitted,
      gasEstimate,
    };
  }

  private async sendSell(input: {
    privateKey: string;
    router: Contract;
    walletAddress: string;
    amountInRaw: string;
    minOutRaw: string;
    path: string[];
    deadline: bigint;
    gasThresholdUsd: number;
    shouldContinue?: (() => boolean) | undefined;
  }) {
    const populated = await input.router.getFunction("swapExactTokensForETH").populateTransaction(
      BigInt(input.amountInRaw),
      BigInt(input.minOutRaw),
      input.path,
      input.walletAddress,
      input.deadline,
    );
    const transaction: TransactionRequest = {
      from: input.walletAddress,
      to: this.routerAddress,
      data: populated.data,
      value: 0n,
    };
    const gasEstimate = await this.assertGasWithinThreshold(transaction, input.gasThresholdUsd);
    assertExecutionContinues(input.shouldContinue);
    const submitted = await this.submitTransaction(input.privateKey, {
      ...transaction,
      gasLimit: gasEstimate.gasLimit,
      maxFeePerGas: gasEstimate.maxFeePerGas,
    });
    return {
      ...submitted,
      gasEstimate,
    };
  }

  private async assertGasWithinThreshold(transaction: TransactionRequest, gasThresholdUsd: number) {
    const gasEstimate = await this.gas.estimate(transaction);
    if (gasEstimate.feeUsd > gasThresholdUsd) {
      throw new AppError(
        "NETWORK_CONGESTION",
        `Estimated fee is $${gasEstimate.feeUsd.toFixed(2)}; configured limit is $${gasThresholdUsd.toFixed(2)}.`,
        409,
      );
    }
    await this.rpc.simulate(transaction);
    return gasEstimate;
  }

  private async ensureApproval(input: {
    privateKey: string;
    owner: string;
    spender: string;
    amountRaw: string;
    gasThresholdUsd: number;
    shouldContinue?: (() => boolean) | undefined;
  }): Promise<void> {
    const current = await this.rpc.withProvider(async (provider) => {
      const token = new Contract(this.zigContract, ERC20_ABI, provider);
      return token.getFunction("allowance").staticCall(input.owner, input.spender) as Promise<bigint>;
    });
    const required = BigInt(input.amountRaw);
    if (current >= required) return;

    const approvalTx = await this.rpc.withProvider(async (provider) => {
      const token = new Contract(this.zigContract, ERC20_ABI, provider);
      return token.getFunction("approve").populateTransaction(input.spender, required);
    });
    const transaction: TransactionRequest = {
      from: input.owner,
      to: this.zigContract,
      data: approvalTx.data,
      value: 0n,
    };
    const gasEstimate = await this.assertGasWithinThreshold(transaction, input.gasThresholdUsd);
    assertExecutionContinues(input.shouldContinue);
    const submitted = await this.submitTransaction(input.privateKey, {
      ...transaction,
      gasLimit: gasEstimate.gasLimit,
      maxFeePerGas: gasEstimate.maxFeePerGas,
    });
    const receipt = submitted.receipt;
    if (!receipt || receipt.status !== 1) throw new AppError("SWAP_REVERTED", "Token approval failed.", 409);
  }

  private async submitTransaction(privateKey: string, transaction: TransactionRequest) {
    const signedTransaction = await this.rpc.withProvider(async (provider) => {
      const signer = new Wallet(normalizePrivateKey(privateKey), provider);
      const populated = await signer.populateTransaction(transaction);
      return signer.signTransaction(populated);
    });
    const response = await this.rpc.broadcastTransaction(signedTransaction);
    const receipt = await this.rpc.waitForTransactionReceipt(response.hash, signedTransaction);
    return { hash: response.hash, receipt };
  }

  private async readBalances(provider: JsonRpcProvider, walletAddress: string): Promise<WalletBalanceSnapshot> {
    const token = new Contract(this.zigContract, ERC20_ABI, provider);
    const [ethRaw, zigRaw] = await Promise.all([
      provider.getBalance(walletAddress),
      token.getFunction("balanceOf").staticCall(walletAddress) as Promise<bigint>,
    ]);
    return {
      walletAddress,
      ethRaw,
      zigRaw,
      eth: Number(formatUnits(ethRaw, 18)).toFixed(6),
      zig: Number(formatUnits(zigRaw, 18)).toFixed(6),
      updatedAt: new Date().toISOString(),
    };
  }
}

function applySlippage(amountOutRaw: string, slippageBps: number): string {
  const amount = BigInt(amountOutRaw);
  const min = (amount * BigInt(Math.max(0, 10_000 - slippageBps))) / 10_000n;
  return (min > 0n ? min : 1n).toString();
}

function normalizePrivateKey(value: string): string {
  return value.startsWith("0x") ? value : `0x${value}`;
}

function computeEthReceived(before: bigint, after: bigint, receipt: TransactionReceipt): bigint {
  const effectiveGasPrice = receipt.gasPrice ?? 0n;
  const fee = receipt.gasUsed * effectiveGasPrice;
  return clampBigint(after + fee - before);
}

function clampBigint(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

function assertExecutionContinues(shouldContinue?: () => boolean): void {
  if (shouldContinue && !shouldContinue()) {
    throw new AppError("INVALID_REQUEST", "Execution stopped before transaction submission.", 409);
  }
}
