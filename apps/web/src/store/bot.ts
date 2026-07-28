import { create } from "zustand";
import type { BotSnapshot } from "@zig/shared";

interface BotStore {
  snapshot: BotSnapshot | null;
  connected: boolean;
  setSnapshot: (snapshot: BotSnapshot) => void;
  setConnected: (connected: boolean) => void;
}

export const useBotStore = create<BotStore>((set) => ({
  snapshot: null,
  connected: false,
  setSnapshot: (snapshot) => set({ snapshot, connected: true }),
  setConnected: (connected) => set({ connected }),
}));
