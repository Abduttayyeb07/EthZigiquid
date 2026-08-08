"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Activity, Bot, Clock3, Fuel, Pause, Play, Radio, RefreshCcw, ShieldCheck, Terminal, Wallet, Zap } from "lucide-react";
import { toast } from "sonner";
import type { AutomationSettings, BotSnapshot, LogLevel, WalletBalances } from "@zig/shared";
import { api, clearControlToken, hasControlToken, setControlToken, type BuySimulation } from "@/lib/api";
import { useBotStore } from "@/store/bot";

// Keeps the router quote fresh without tying it to the state poll interval.
const QUOTE_REFRESH_MS = 30_000;

export function Dashboard() {
  const { snapshot, connected, setSnapshot, setConnected } = useBotStore();
  const [form, setForm] = useState({
    walletAddress: "",
    privateKey: "",
    tradeAmountEth: "0.001",
  });
  const [balances, setBalances] = useState<WalletBalances | null>(null);
  const [simulation, setSimulation] = useState<BuySimulation | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [walletEditedLocally, setWalletEditedLocally] = useState(false);
  const [amountEditedLocally, setAmountEditedLocally] = useState(false);
  const amountEditedLocallyRef = useRef(false);
  const pendingSavedAmountRef = useRef<string | null>(null);
  const latestSimulationKeyRef = useRef<string | null>(null);

  useEffect(() => setAuthenticated(hasControlToken()), []);
  const stateQuery = useQuery({
    queryKey: ["state", authenticated],
    queryFn: api.state,
    enabled: authenticated,
    refetchInterval: 2_000,
  });
  // This runs on every poll response. Fields the operator is currently editing
  // must be left alone, otherwise the poll overwrites input mid-keystroke.
  useEffect(() => {
    if (!stateQuery.data) return;
    setSnapshot(stateQuery.data);
    const serverAmount = stateQuery.data.settings.tradeAmountEth;
    const pendingSavedAmount = pendingSavedAmountRef.current;
    if (pendingSavedAmount && serverAmount === pendingSavedAmount) {
      pendingSavedAmountRef.current = null;
      amountEditedLocallyRef.current = false;
      setAmountEditedLocally(false);
    }
    const protectAmount =
      amountEditedLocallyRef.current ||
      amountEditedLocally ||
      Boolean(pendingSavedAmountRef.current);
    setForm((current) => ({
      ...current,
      walletAddress: walletEditedLocally ? current.walletAddress : stateQuery.data.settings.walletAddress ?? current.walletAddress,
      tradeAmountEth: protectAmount ? current.tradeAmountEth : serverAmount,
    }));
  }, [stateQuery.data, setSnapshot, walletEditedLocally, amountEditedLocally]);

  useEffect(() => setConnected(stateQuery.isSuccess), [setConnected, stateQuery.isSuccess]);

  const refreshBalances = useMutation({
    mutationFn: (walletAddress: string) => api.balances(walletAddress),
    onSuccess: (data) => setBalances(data),
    onError: (error) => toast.error(error.message),
  });

  const simulateBuy = useMutation({
    mutationFn: (input: { amountEth: string; slippageBps?: number }) => api.simulateBuy(input),
  });

  const startAutomation = useMutation({
    mutationFn: async () => {
      const walletAddress = form.walletAddress.trim();
      const privateKey = form.privateKey.trim();
      const tradeAmountEth = form.tradeAmountEth.trim();
      const signerMatches =
        snapshot?.signerConfigured &&
        snapshot.settings.walletAddress?.toLowerCase() === walletAddress.toLowerCase();
      if (!walletAddress) throw new Error("Wallet address is required.");
      if (!signerMatches && !privateKey) throw new Error("Private key is required for this wallet.");
      if (!isPositiveEthAmount(tradeAmountEth)) throw new Error("Trade amount must be greater than zero.");
      if (!signerMatches) await api.connectWallet({ walletAddress, privateKey });
      await api.settings({ tradeAmountEth });
      return api.start();
    },
    onSuccess: (data) => {
      setSnapshot(data);
      setBalances({
        walletAddress: data.settings.walletAddress ?? form.walletAddress,
        eth: data.statistics.ethBalance,
        zig: data.statistics.zigBalance,
        updatedAt: new Date().toISOString(),
      });
      setForm((current) => ({ ...current, privateKey: "" }));
      setWalletEditedLocally(false);
      // Start persists the amount before running, so the form is in sync again.
      pendingSavedAmountRef.current = null;
      amountEditedLocallyRef.current = false;
      setAmountEditedLocally(false);
      toast.success("Automation started");
    },
    onError: (error) => toast.error(error.message),
  });

  const stopAutomation = useMutation({
    mutationFn: () => api.stop(),
    onSuccess: (data) => {
      setSnapshot(data);
      setBalances(null);
      setForm((current) => ({
        ...current,
        walletAddress: "",
        privateKey: "",
      }));
      toast.success("Automation stopped and wallet credentials cleared");
    },
    onError: (error) => toast.error(error.message),
  });

  const clearWallet = useMutation({
    mutationFn: () => api.clearWallet(),
    onSuccess: (data) => {
      setSnapshot(data);
      setBalances(null);
      setWalletEditedLocally(false);
      setForm((current) => ({
        ...current,
        walletAddress: "",
        privateKey: "",
      }));
      toast.success("Wallet credentials cleared");
    },
    onError: (error) => toast.error(error.message),
  });

  const saveControls = useMutation({
    mutationFn: (settings: Partial<AutomationSettings>) => api.settings(settings),
    onSuccess: (data, variables) => {
      setSnapshot(data);
      // Only resync the amount when this save actually carried it. The cycle
      // controls share this mutation and must not revert an in-progress edit.
      if (variables.tradeAmountEth !== undefined) {
        const savedAmount = variables.tradeAmountEth;
        setForm((current) => ({ ...current, tradeAmountEth: savedAmount }));
        if (data.settings.tradeAmountEth === savedAmount) {
          pendingSavedAmountRef.current = null;
          amountEditedLocallyRef.current = false;
          setAmountEditedLocally(false);
        } else {
          pendingSavedAmountRef.current = savedAmount;
          amountEditedLocallyRef.current = true;
          setAmountEditedLocally(true);
        }
      }
      toast.success("Controls saved");
    },
    onError: (error) => toast.error(error.message),
  });

  useEffect(() => {
    if (!/^0x[a-fA-F0-9]{40}$/.test(form.walletAddress)) return;
    const timer = setTimeout(() => refreshBalances.mutate(form.walletAddress), 400);
    return () => clearTimeout(timer);
  }, [form.walletAddress]);

  // Depends on the slippage value rather than the whole snapshot. Depending on
  // the snapshot re-ran this on every 2s poll, firing a router quote per tick.
  const slippageBps = snapshot?.settings.slippageBps ?? null;
  useEffect(() => {
    const amount = form.tradeAmountEth.trim();
    if (slippageBps === null || !isPositiveEthAmount(amount)) {
      latestSimulationKeyRef.current = null;
      setSimulation(null);
      return;
    }
    const effectiveSlippage = Number.isFinite(slippageBps) ? slippageBps : 100;
    const quoteKey = `${amount}:${effectiveSlippage}`;
    latestSimulationKeyRef.current = quoteKey;
    const quote = () => simulateBuy.mutate(
      { amountEth: amount, slippageBps: effectiveSlippage },
      {
        onSuccess: (data) => {
          if (latestSimulationKeyRef.current === quoteKey) setSimulation(data);
        },
        onError: () => {
          if (latestSimulationKeyRef.current === quoteKey) setSimulation(null);
        },
      },
    );
    const debounce = setTimeout(quote, 350);
    const refresh = setInterval(quote, QUOTE_REFRESH_MS);
    return () => {
      clearTimeout(debounce);
      clearInterval(refresh);
    };
  }, [form.tradeAmountEth, slippageBps]);

  if (!authenticated) return <AccessGate onAuthenticated={() => setAuthenticated(true)} />;
  if (!snapshot) return <DashboardSkeleton />;
  const active = !["stopped", "error"].includes(snapshot.status);
  const signerMatches =
    snapshot.signerConfigured &&
    snapshot.settings.walletAddress?.toLowerCase() === form.walletAddress.trim().toLowerCase();
  const canStart =
    !startAutomation.isPending &&
    !stopAutomation.isPending &&
    Boolean(form.walletAddress.trim()) &&
    (Boolean(form.privateKey.trim()) || signerMatches) &&
    isPositiveEthAmount(form.tradeAmountEth.trim());
  const displayedEth = balances?.eth ?? snapshot.statistics.ethBalance;
  const displayedZig = balances?.zig ?? snapshot.statistics.zigBalance;
  const walletValue = simulation
    ? Number(displayedEth) * simulation.ethUsd + Number(displayedZig) * simulation.impliedZigUsd
    : null;
  const estimatedWalletUsd = walletValue !== null && Number.isFinite(walletValue) ? walletValue : null;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <div className="brand-mark"><Zap size={18} fill="currentColor" /></div>
            <div className="brand-copy">
              <span>ZIG Flow</span>
              <small>Liquidity automation</small>
            </div>
          </div>
          <nav className="console-tabs" aria-label="Dashboard sections">
            <a href="#automation" className="active"><span>Automation</span><i className={active ? "running" : ""} /></a>
            <a href="#wallet">Wallet</a>
            <a href="#activity">Activity</a>
            <a href="#network">Network</a>
          </nav>
          <div className="top-actions">
            <span className="environment">ETH MAINNET</span>
            <div className={`api-status ${connected ? "online" : ""}`}>
              <span className="pulse-dot" />
              {connected ? "API connected" : "Reconnecting"}
            </div>
          </div>
        </div>
      </header>

      <div className="workspace">
        <section className="content" id="automation">
          <div className="page-heading">
            <div>
              <p className="eyebrow">AUTOMATION CONSOLE</p>
              <h1>ETH to ZIG automation</h1>
              <p>Enter wallet address and private key, review balances, then start alternating buy and sell cycles.</p>
            </div>
            <div className="heading-actions">
              <button
                className="primary-button"
                disabled={active || !canStart}
                onClick={() => startAutomation.mutate()}
              >
                <Play size={16} fill="currentColor" />
                {startAutomation.isPending ? "Starting..." : "Start automation"}
              </button>
              <button
                className="stop-button"
                disabled={!active || stopAutomation.isPending}
                onClick={() => stopAutomation.mutate()}
              >
                <Pause size={16} fill="currentColor" />
                {stopAutomation.isPending ? "Stopping..." : "Stop automation"}
              </button>
            </div>
          </div>

          <StatusHero snapshot={snapshot} active={active} />

          <div className="bottom-grid wallet-grid" id="wallet">
            <section className="panel panel--wallet">
              <div className="panel-head"><div><Wallet size={17} /><span>Wallet access</span></div></div>
              <div className="wallet-access">
                <div className="wallet-access__intro">
                  <strong>Server-side execution</strong>
                  <span>Enter the wallet once, define how much ETH each buy cycle should spend, then run the bot from this dashboard.</span>
                </div>
                <div className="wallet-access__grid">
                  <label className="wallet-access__field wallet-access__field--wide">
                    <span>Wallet address</span>
                    <input value={form.walletAddress} onChange={(event) => {
                      setWalletEditedLocally(true);
                      setForm((current) => ({ ...current, walletAddress: event.target.value }));
                    }} placeholder="0x..." />
                  </label>
                  <label className="wallet-access__field wallet-access__field--wide">
                    <span>Private key</span>
                    <input value={form.privateKey} onChange={(event) => setForm((current) => ({ ...current, privateKey: event.target.value }))} placeholder="0x..." type="password" autoComplete="off" />
                  </label>
                  <div className="wallet-access__amount">
                    <div className="wallet-access__amount-copy">
                      <span>Trade amount per buy cycle</span>
                      <small>How much ETH the bot spends when it executes the ETH to ZIG buy leg.</small>
                    </div>
                    <div className="wallet-access__amount-input-wrap">
                      <div className="wallet-access__amount-input">
                        <input value={form.tradeAmountEth} onFocus={() => {
                          amountEditedLocallyRef.current = true;
                          setAmountEditedLocally(true);
                        }} onChange={(event) => {
                          amountEditedLocallyRef.current = true;
                          setAmountEditedLocally(true);
                          setForm((current) => ({ ...current, tradeAmountEth: event.target.value }));
                        }} inputMode="decimal" />
                        <strong>ETH</strong>
                      </div>
                      <small className="wallet-access__usd">
                        {simulation
                          ? `${formatUsd(simulation.amountInUsd)} at ${formatUsd(simulation.ethUsd)} / ETH`
                          : "Live USD value appears after the quote loads"}
                      </small>
                    </div>
                  </div>
                  <div className="wallet-access__simulation">
                    <div className="simulation-head">
                      <div>
                        <span>Buy simulation</span>
                        <small>Live Uniswap router quote</small>
                      </div>
                      <span className="simulation-live"><i /> Live</span>
                    </div>
                    {simulateBuy.isPending ? (
                      <div className="simulation-empty">
                        <span className="simulation-loader" />
                        <div>
                          <strong>Calculating live output...</strong>
                          <small>Checking the ETH to ZIG route and current pool price.</small>
                        </div>
                      </div>
                    ) : simulation ? (
                      <>
                        <div className="simulation-output">
                          <span>Estimated output</span>
                          <strong>{Number(simulation.estimatedZig).toFixed(4)} <small>ZIG</small></strong>
                        </div>
                        <div className="simulation-metrics">
                          <div>
                            <span>Trade value</span>
                            <strong>{formatUsd(simulation.amountInUsd)}</strong>
                          </div>
                          <div>
                            <span>Implied ZIG price</span>
                            <strong>{formatUsd(simulation.impliedZigUsd)}</strong>
                          </div>
                          <div>
                            <span>Minimum received</span>
                            <strong>{Number(simulation.minimumZig).toFixed(4)} ZIG</strong>
                          </div>
                        </div>
                        <p className="simulation-note">
                          Minimum output includes your {simulation.slippageBps} bps ({(simulation.slippageBps / 100).toFixed(2)}%) slippage limit.
                        </p>
                      </>
                    ) : (
                      <div className="simulation-empty">
                        <div>
                          <strong>Enter an ETH amount to preview the trade</strong>
                          <small>The quote updates automatically before automation starts.</small>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <div className="wallet-access__actions">
                  <button className="secondary-button" disabled={refreshBalances.isPending || !form.walletAddress.trim()} onClick={() => refreshBalances.mutate(form.walletAddress.trim())}>
                    <RefreshCcw size={16} /> {refreshBalances.isPending ? "Refreshing..." : "Refresh balances"}
                  </button>
                  <button className="secondary-button" disabled={active || clearWallet.isPending || (!snapshot.signerConfigured && !snapshot.settings.walletAddress && !form.walletAddress.trim())} onClick={() => clearWallet.mutate()}>
                    {clearWallet.isPending ? "Clearing..." : "Clear wallet"}
                  </button>
                  <button className="primary-button" disabled={saveControls.isPending} onClick={() => {
                    const tradeAmountEth = form.tradeAmountEth.trim() || snapshot.settings.tradeAmountEth;
                    if (!isPositiveEthAmount(tradeAmountEth)) {
                      toast.error("Trade amount must be greater than zero.");
                      return;
                    }
                    pendingSavedAmountRef.current = tradeAmountEth;
                    amountEditedLocallyRef.current = true;
                    setAmountEditedLocally(true);
                    setForm((current) => ({ ...current, tradeAmountEth }));
                    saveControls.mutate({ tradeAmountEth });
                  }}>
                    {saveControls.isPending ? "Saving..." : "Save amount"}
                  </button>
                </div>
                <div className="wallet-access__note">
                  <ShieldCheck size={16} />
                  <p>No browser wallet confirmation is needed. The backend signs after you save the wallet address and private key.</p>
                </div>
              </div>
            </section>

            <div className="wallet-side">
              <section className="panel panel--balances">
                <div className="panel-head">
                  <div><Activity size={17} /><span>Wallet balances</span></div>
                  <span className="balance-total-chip">{estimatedWalletUsd === null ? "Live snapshot" : formatUsd(estimatedWalletUsd)}</span>
                </div>
                <div className="balance-summary">
                  <div className="balance-summary__identity">
                    <i className={form.walletAddress ? "connected" : ""} />
                    <div>
                      <span>{form.walletAddress ? "Wallet connected" : "Wallet not configured"}</span>
                      <strong>{form.walletAddress ? shortAddress(form.walletAddress) : "Enter an address to begin"}</strong>
                    </div>
                  </div>
                  <small>{balances?.updatedAt ? `Updated at ${formatTime(balances.updatedAt)}` : "Balances update automatically"}</small>
                </div>
                <div className="stats-grid">
                  <article className="stat-card balance-card">
                    <div className="stat-icon blue"><Wallet size={18} /></div>
                    <span>ETH balance</span>
                    <strong>{displayedEth} <em>ETH</em></strong>
                    <small>{simulation ? formatUsd(Number(displayedEth) * simulation.ethUsd) : "USD value loads with a live quote"}</small>
                  </article>
                  <article className="stat-card balance-card">
                    <div className="stat-icon purple"><Activity size={18} /></div>
                    <span>ZIG balance</span>
                    <strong>{displayedZig} <em>ZIG</em></strong>
                    <small>{simulation ? formatUsd(Number(displayedZig) * simulation.impliedZigUsd) : "USD value loads with a live quote"}</small>
                  </article>
                </div>
              </section>

              <section className="panel guardrails-card">
                <div className="panel-head">
                  <div><ShieldCheck size={17} /><span>Automation guardrails</span></div>
                  <span className="guardrails-state">ENFORCED</span>
                </div>
                <div className="guardrail-list">
                  <div><i>1</i><p><strong>Buy ZIG</strong><span>Spend {form.tradeAmountEth || snapshot.settings.tradeAmountEth} ETH per buy leg.</span></p></div>
                  <div><i>2</i><p><strong>Sell exact output</strong><span>Sell only the ZIG confirmed from that buy before another buy.</span></p></div>
                  <div><i>3</i><p><strong>Check execution cost</strong><span>Skip while gas exceeds {formatUsd(snapshot.settings.gasThresholdUsd)}.</span></p></div>
                  <div><i>4</i><p><strong>Recover in place</strong><span>RPC or swap failures retry the pending leg without breaking order.</span></p></div>
                </div>
                <div className="guardrail-footer">
                  <span>Strict sequence</span>
                  <strong>BUY <b>--&gt;</b> SELL <b>--&gt;</b> BUY</strong>
                  <small>{snapshot.settings.slippageBps} bps slippage limit</small>
                </div>
              </section>
            </div>
          </div>

          <ControlBar snapshot={snapshot} onSave={(patch) => saveControls.mutate(patch)} saving={saveControls.isPending} />
          <Stats snapshot={snapshot} />

          <div className="bottom-grid activity-grid" id="activity">
            <LiveLogs snapshot={snapshot} />
            <div id="network"><RpcPanel snapshot={snapshot} /></div>
          </div>
        </section>
      </div>
    </main>
  );
}

function AccessGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  return (
    <main className="loading-screen access-gate">
      <div className="brand"><div className="brand-mark"><Zap size={18} /></div><span>ZIG Flow</span></div>
      <div className="access-card">
        <ShieldCheck size={24} />
        <h1>Operator access</h1>
        <p>Enter the private deployment control token to open the automation console.</p>
        <input value={token} onChange={(event) => setToken(event.target.value)} type="password" placeholder="Control token" autoComplete="off" />
        {error && <small>{error}</small>}
        <button className="primary-button" disabled={checking || token.trim().length === 0} onClick={async () => {
          setChecking(true);
          setError("");
          setControlToken(token);
          try {
            await api.state();
            onAuthenticated();
          } catch {
            clearControlToken();
            setError("Invalid control token or API unavailable.");
          } finally {
            setChecking(false);
          }
        }}>{checking ? "Verifying..." : "Open console"}</button>
      </div>
    </main>
  );
}

function StatusHero({ snapshot, active }: { snapshot: BotSnapshot; active: boolean }) {
  const statusLabel = snapshot.status.replaceAll("_", " ");
  return (
    <section className="status-hero">
      <div className="hero-orbit"><div className={`hero-icon ${active ? "active" : ""}`}><Bot size={27} /></div></div>
      <div className="hero-copy">
        <div className="status-line"><span className={`status-pill status-${snapshot.status}`}><i />{statusLabel}</span><span className="mode-pill">{snapshot.executionMode}</span></div>
        <h2>{snapshot.statusMessage}</h2>
        <p>The backend signs and submits swaps directly. Start begins alternating buy and sell cycles until you stop it.</p>
      </div>
      <div className="hero-metrics">
        <div><span>Current cycle</span><strong>#{snapshot.statistics.currentCycle}</strong></div>
        <div><span>Runtime</span><strong>{formatRuntime(snapshot.statistics.runtimeSeconds)}</strong></div>
        <div><span>Success rate</span><strong>{successRate(snapshot)}%</strong></div>
      </div>
    </section>
  );
}

function ControlBar({
  snapshot,
  onSave,
  saving,
}: {
  snapshot: BotSnapshot;
  onSave: (patch: Partial<AutomationSettings>) => void;
  saving: boolean;
}) {
  const [intervalSeconds, setIntervalSeconds] = useState(String(snapshot.settings.intervalSeconds));
  const [slippageBps, setSlippageBps] = useState(String(snapshot.settings.slippageBps));
  const [gasThresholdUsd, setGasThresholdUsd] = useState(String(snapshot.settings.gasThresholdUsd));

  useEffect(() => {
    setIntervalSeconds(String(snapshot.settings.intervalSeconds));
    setSlippageBps(String(snapshot.settings.slippageBps));
    setGasThresholdUsd(String(snapshot.settings.gasThresholdUsd));
  }, [snapshot.settings.gasThresholdUsd, snapshot.settings.intervalSeconds, snapshot.settings.slippageBps]);

  return (
    <section className="interval-bar cycle-controls">
      <div className="interval-label cycle-controls__header">
        <Clock3 size={17} />
        <div>
          <strong>Cycle controls</strong>
          <span>These control how often the bot runs, how much price movement it tolerates, and the maximum gas cost it will accept.</span>
        </div>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            intervalSeconds: Number(intervalSeconds),
            slippageBps: Number(slippageBps),
            gasThresholdUsd: Number(gasThresholdUsd),
          });
        }}
        className="cycle-controls__form"
      >
        <label className="cycle-controls__field">
          <span>Interval seconds</span>
          <small>Wait time between completed cycles</small>
          <input value={intervalSeconds} onChange={(event) => setIntervalSeconds(event.target.value)} inputMode="numeric" />
        </label>
        <label className="cycle-controls__field">
          <span>Slippage bps</span>
          <small>100 bps = 1% maximum price drift</small>
          <input value={slippageBps} onChange={(event) => setSlippageBps(event.target.value)} inputMode="numeric" />
        </label>
        <label className="cycle-controls__field">
          <span>Gas limit USD</span>
          <small>Skip the cycle if estimated gas is above this</small>
          <input value={gasThresholdUsd} onChange={(event) => setGasThresholdUsd(event.target.value)} inputMode="decimal" />
        </label>
        <div className="cycle-controls__actions">
          <button className="primary-button save-button" disabled={saving}>{saving ? "Saving..." : "Save controls"}</button>
        </div>
      </form>
    </section>
  );
}

function Stats({ snapshot }: { snapshot: BotSnapshot }) {
  const s = snapshot.statistics;
  const cards = [
    { label: "Completed cycles", value: s.totalCycles.toLocaleString(), sub: `Current #${s.currentCycle}`, icon: Bot, tone: "purple" },
    { label: "Wallet balance", value: `${s.ethBalance} ETH`, sub: `${s.zigBalance} ZIG`, icon: Wallet, tone: "blue" },
    { label: "Network fee", value: s.currentGasUsd === null ? "-" : `$${s.currentGasUsd.toFixed(2)}`, sub: `$${s.totalGasUsd.toFixed(2)} spent total`, icon: Fuel, tone: "orange" },
    { label: "Transactions", value: s.totalTransactions.toLocaleString(), sub: `${s.failedSwaps} failed / ${s.successfulSwaps} successful`, icon: Activity, tone: "green" },
  ];
  return <div className="stats-grid">{cards.map(({ icon: Icon, ...card }) => (
    <article className="stat-card" key={card.label}>
      <div className={`stat-icon ${card.tone}`}><Icon size={18} /></div>
      <span>{card.label}</span><strong>{card.value}</strong><small>{card.sub}</small>
    </article>
  ))}</div>;
}

function LiveLogs({ snapshot }: { snapshot: BotSnapshot }) {
  const [filter, setFilter] = useState<LogLevel | "all">("all");
  const logs = useMemo(() => snapshot.logs.filter((log) => filter === "all" || log.level === filter).slice(0, 18), [filter, snapshot.logs]);
  return (
    <section className="panel logs-panel">
      <div className="panel-head"><div><Terminal size={17} /><span>Live activity</span><i className="live-dot" /></div><div className="filters">
        {(["all", "info", "warning", "error", "success"] as const).map((level) => <button className={filter === level ? "active" : ""} key={level} onClick={() => setFilter(level)}>{level}</button>)}
      </div></div>
      <div className="log-stream">
        {logs.map((log) => <div className="log-row" key={log.id}><time>{formatTime(log.timestamp)}</time><span className={`log-mark ${log.level}`} /> <p>{log.message}</p></div>)}
        {!logs.length && <div className="empty">No log entries match this filter.</div>}
      </div>
    </section>
  );
}

function RpcPanel({ snapshot }: { snapshot: BotSnapshot }) {
  const healthyRpcs = snapshot.rpcHealth.filter((rpc) => rpc.healthy);
  const activeRpc = healthyRpcs.find((rpc) => rpc.active);
  return (
    <section className="panel rpc-panel">
      <div className="panel-head"><div><Radio size={17} /><span>RPC network</span></div><span className="healthy-count">{healthyRpcs.length} healthy</span></div>
      <div className="rpc-list">
        {healthyRpcs.slice(0, 6).map((rpc) => <div className="rpc-row" key={rpc.url}>
          <span className="rpc-dot healthy" />
          <div><strong>{rpc.url.replace("https://", "")}</strong><small>{rpc.active ? "Active provider" : "Standby"}</small></div>
          <span className="latency">{rpc.latencyMs === null ? "-" : `${rpc.latencyMs}ms`}</span>
        </div>)}
        {!healthyRpcs.length && <div className="empty">Waiting for a healthy RPC...</div>}
      </div>
      <div className="rpc-footer">
        <ShieldCheck size={17} />
        <div>
          <strong>Automatic failover enabled</strong>
          <span>{activeRpc ? `${activeRpc.url.replace("https://", "")} is handling requests.` : "The next healthy endpoint will be selected automatically."}</span>
        </div>
      </div>
    </section>
  );
}

function DashboardSkeleton() {
  return <main className="loading-screen"><div className="brand"><div className="brand-mark"><Zap size={18} /></div><span>ZIG Flow</span></div><div className="loader" /><p>Connecting to the automation service...</p></main>;
}

function shortAddress(address: string) { return `${address.slice(0, 6)}...${address.slice(-4)}`; }
function formatTime(value: string) { return new Date(value).toLocaleTimeString([], { hour12: false }); }
function formatRuntime(seconds: number) { const h = Math.floor(seconds / 3600); const m = Math.floor((seconds % 3600) / 60); return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }
function formatUsd(value: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: value < 1 ? 4 : 2, maximumFractionDigits: value < 1 ? 4 : 2 }).format(value); }
function successRate(snapshot: BotSnapshot) { const { successfulSwaps, failedSwaps } = snapshot.statistics; return successfulSwaps + failedSwaps === 0 ? "100.0" : ((successfulSwaps / (successfulSwaps + failedSwaps)) * 100).toFixed(1); }
function isPositiveEthAmount(value: string) {
  return /^\d+(\.\d{1,18})?$/.test(value) && value.replace(".", "").replace(/^0+/, "").length > 0;
}
