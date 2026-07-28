import { Contract, formatUnits, type TransactionRequest } from "ethers";
import { AppError } from "../lib/errors.js";
import type { RpcManager } from "./rpc-manager.js";

const CHAINLINK_ETH_USD = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419";
const AGGREGATOR_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
];

export interface GasEstimate {
  gasLimit: bigint;
  maxFeePerGas: bigint;
  ethUsd: number;
  feeEth: number;
  feeUsd: number;
}

export class GasService {
  constructor(private readonly rpc: RpcManager) {}

  async estimate(transaction?: TransactionRequest): Promise<GasEstimate> {
    const [feeData, gasLimit, ethUsd] = await Promise.all([
      this.rpc.getFeeData(),
      transaction ? this.rpc.estimateGas(transaction) : Promise.resolve(250_000n),
      this.getEthUsdPrice(),
    ]);
    const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (!maxFeePerGas) throw new AppError("RPC_UNAVAILABLE", "No gas price was returned.");
    const feeEth = Number(formatUnits(gasLimit * maxFeePerGas, 18));
    return { gasLimit, maxFeePerGas, ethUsd, feeEth, feeUsd: feeEth * ethUsd };
  }

  async getEthUsdPrice(): Promise<number> {
    return this.rpc.withProvider(async (provider) => {
      const feed = new Contract(CHAINLINK_ETH_USD, AGGREGATOR_ABI, provider);
      const decimals = (await feed.getFunction("decimals").staticCall()) as bigint;
      const round = (await feed.getFunction("latestRoundData").staticCall()) as readonly unknown[];
      const answer = round[1];
      if (typeof answer !== "bigint" || answer <= 0n) {
        throw new AppError("RPC_UNAVAILABLE", "Chainlink ETH/USD returned an invalid value.");
      }
      return Number(formatUnits(answer, Number(decimals)));
    });
  }
}
