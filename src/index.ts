import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  Contract,
  FetchRequest,
  JsonRpcProvider,
  WebSocketProvider,
  formatEther,
  isAddress,
  type Log
} from "ethers";

const USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CHAIN_ID = 56n;

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address account) view returns (uint256)"
] as const;

type WalletConfig = {
  label: string;
  address: string;
};

type SavedState = {
  lastProcessedBlock: number;
};

type TransferAlert = {
  direction: "Inflow" | "Outflow";
  wallet: WalletConfig;
  amount: string;
  symbol: string;
  from: string;
  to: string;
  transactionHash: string;
  blockNumber: number;
};

type IndexedTransfer = {
  blockNumber: string;
  timeStamp?: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  tokenDecimal?: string;
  tokenSymbol?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    chat: {
      id: number | string;
    };
    text?: string;
  };
};

type IndexedApiConfig = {
  name: string;
  apiKey: string;
  baseUrl: string;
  chainId?: string;
};

type RpcProvider = {
  getBlockNumber(): Promise<number>;
  getBalance(address: string): Promise<bigint>;
  getLogs(filter: Parameters<JsonRpcProvider["getLogs"]>[0]): Promise<Log[]>;
};

class RateLimitedProvider implements RpcProvider {
  private nextRequestAt = 0;

  constructor(
    private readonly provider: JsonRpcProvider,
    private readonly minDelayMs: number
  ) {}

  async getBlockNumber(): Promise<number> {
    await this.waitForSlot();
    return this.provider.getBlockNumber();
  }

  async getBalance(address: string): Promise<bigint> {
    await this.waitForSlot();
    return this.provider.getBalance(address);
  }

  async getLogs(filter: Parameters<JsonRpcProvider["getLogs"]>[0]): Promise<Log[]> {
    await this.waitForSlot();
    return this.provider.getLogs(filter);
  }

  private async waitForSlot(): Promise<void> {
    if (this.minDelayMs <= 0) return;

    const now = Date.now();
    const waitMs = Math.max(0, this.nextRequestAt - now);
    this.nextRequestAt = Math.max(now, this.nextRequestAt) + this.minDelayMs;

    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getTelegramChatIds(): string[] {
  const multiValue = process.env.TELEGRAM_CHAT_IDS?.trim();
  const singleValue = process.env.TELEGRAM_CHAT_ID?.trim();
  const rawValue = multiValue || singleValue;
  if (!rawValue) {
    throw new Error("Missing required environment variable: TELEGRAM_CHAT_IDS or TELEGRAM_CHAT_ID");
  }

  const chatIds = rawValue
    .split(",")
    .map((chatId) => chatId.trim())
    .filter(Boolean);

  if (chatIds.length === 0) {
    throw new Error("TELEGRAM_CHAT_IDS must contain at least one chat ID");
  }

  return [...new Set(chatIds)];
}

function optionalNumberEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return parsed;
}

function optionalBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["true", "1", "yes", "y"].includes(value)) return true;
  if (["false", "0", "no", "n"].includes(value)) return false;
  throw new Error(`${name} must be true or false`);
}

function getRpcUrls(): string[] {
  const multiValue = process.env.BSC_RPC_URLS?.trim();
  const singleValue = process.env.BSC_RPC_URL?.trim();
  const rawValue =
    multiValue ||
    singleValue ||
    "https://bsc-mainnet.gateway.tatum.io,https://bsc-rpc.publicnode.com,https://bnb-mainnet.g.alchemy.com/public,https://bsc-dataseed.bnbchain.org";

  const urls = rawValue
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

  if (urls.length === 0) {
    throw new Error("BSC_RPC_URLS must contain at least one RPC URL");
  }

  return urls;
}

function getWsUrls(): string[] {
  const rawValue = process.env.BSC_WS_URLS?.trim() || "wss://bsc-rpc.publicnode.com";
  const urls = rawValue
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

  if (urls.length === 0) {
    throw new Error("BSC_WS_URLS must contain at least one WebSocket URL");
  }

  return urls;
}

function getIndexedApiConfig(): IndexedApiConfig | null {
  const bscScanApiKey = process.env.BSCSCAN_API_KEY?.trim();
  if (bscScanApiKey) {
    return {
      name: "BscScan",
      apiKey: bscScanApiKey,
      baseUrl: "https://api.bscscan.com/api"
    };
  }

  const etherscanApiKey = process.env.ETHERSCAN_API_KEY?.trim();
  if (etherscanApiKey) {
    return {
      name: "Etherscan V2",
      apiKey: etherscanApiKey,
      baseUrl: "https://api.etherscan.io/v2/api",
      chainId: "56"
    };
  }

  return null;
}

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

function parseWatchedWallets(value: string): WalletConfig[] {
  const wallets = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.lastIndexOf("=");
      if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
        throw new Error(
          "WATCHED_WALLETS entries must use Label=0xAddress format, separated by commas"
        );
      }

      const label = entry.slice(0, separatorIndex).trim();
      const address = entry.slice(separatorIndex + 1).trim();

      if (!label) {
        throw new Error("WATCHED_WALLETS contains an empty wallet label");
      }

      if (!isAddress(address)) {
        throw new Error(`WATCHED_WALLETS contains invalid address: ${address}`);
      }

      return { label, address };
    });

  if (wallets.length === 0) {
    throw new Error("WATCHED_WALLETS must contain at least one wallet");
  }

  return wallets;
}

function addressToTopic(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatTokenAmount(rawValue: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = rawValue / base;
  const fraction = rawValue % base;
  const fractionText = fraction.toString().padStart(decimals, "0");
  const trimmedFraction = fractionText.replace(/0+$/, "").slice(0, 6);

  return trimmedFraction ? `${whole}.${trimmedFraction}` : whole.toString();
}

function formatDisplayAmount(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  const trimmedFraction = fraction.replace(/0+$/, "").slice(0, 8);
  return trimmedFraction ? `${whole}.${trimmedFraction}` : whole;
}

async function readState(path: string): Promise<SavedState | null> {
  try {
    const content = await readFile(path, "utf8");
    const parsed = JSON.parse(content) as Partial<SavedState>;
    if (typeof parsed.lastProcessedBlock !== "number") return null;
    return { lastProcessedBlock: parsed.lastProcessedBlock };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

async function writeState(path: string, state: SavedState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function sendTelegramMessage(
  token: string,
  chatId: string,
  message: string,
  timeoutMs: number,
  retries: number
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= Math.max(1, retries); attempt += 1) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true
        })
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Telegram sendMessage failed: ${response.status} ${body}`);
      }

      return;
    } catch (error) {
      lastError = error;
      if (attempt < Math.max(1, retries)) {
        console.warn(`Telegram send failed (${attempt}/${retries}): ${formatError(error)}`);
        await sleep(1000 * attempt);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function safeSendTelegramMessage(
  token: string,
  chatId: string,
  message: string,
  timeoutMs: number,
  retries: number,
  label: string
): Promise<void> {
  try {
    await sendTelegramMessage(token, chatId, message, timeoutMs, retries);
  } catch (error) {
    console.warn(`Telegram ${label} skipped: ${formatError(error)}`);
  }
}

async function sendTelegramBroadcast(
  token: string,
  chatIds: string[],
  message: string,
  timeoutMs: number,
  retries: number
): Promise<void> {
  for (const chatId of chatIds) {
    await sendTelegramMessage(token, chatId, message, timeoutMs, retries);
  }
}

async function safeSendTelegramBroadcast(
  token: string,
  chatIds: string[],
  message: string,
  timeoutMs: number,
  retries: number,
  label: string
): Promise<void> {
  for (const chatId of chatIds) {
    await safeSendTelegramMessage(token, chatId, message, timeoutMs, retries, `${label} to ${chatId}`);
  }
}

async function main(): Promise<void> {
  const telegramToken = requiredEnv("TELEGRAM_BOT_TOKEN");
  const telegramChatIds = getTelegramChatIds();
  const telegramTimeoutMs = optionalNumberEnv("TELEGRAM_TIMEOUT_MS", 20_000);
  const telegramRetries = optionalNumberEnv("TELEGRAM_RETRIES", 3);
  const telegramCommandsEnabled = optionalBooleanEnv("TELEGRAM_COMMANDS_ENABLED", true);
  const telegramCommandPollIntervalMs = optionalNumberEnv("TELEGRAM_COMMAND_POLL_INTERVAL_MS", 5000);
  const watchedWallets = parseWatchedWallets(requiredEnv("WATCHED_WALLETS"));
  const rpcUrls = getRpcUrls();
  const wsUrls = getWsUrls();
  const useWebSocket = optionalBooleanEnv("USE_WEBSOCKET", false);
  const logWebSocketDecodedSummary = optionalBooleanEnv("LOG_WEBSOCKET_DECODED_SUMMARY", true);
  const webSocketDecodedSummaryIntervalMs = optionalNumberEnv(
    "WEBSOCKET_DECODED_SUMMARY_INTERVAL_MS",
    30_000
  );
  const rpcTimeoutMs = optionalNumberEnv("RPC_TIMEOUT_MS", 10_000);
  const rpcMinDelayMs = optionalNumberEnv("RPC_MIN_DELAY_MS", 400);
  const symbol = process.env.TOKEN_SYMBOL?.trim() || "USDT";
  const decimals = optionalNumberEnv("TOKEN_DECIMALS", 18);
  const indexedApi = getIndexedApiConfig();
  const pollIntervalMs = optionalNumberEnv("POLL_INTERVAL_MS", 10_000);
  const confirmations = optionalNumberEnv("CONFIRMATIONS", 1);
  const maxBlockRange = optionalNumberEnv("MAX_BLOCK_RANGE", 5);
  const maxBacklogBlocks = optionalNumberEnv("MAX_BACKLOG_BLOCKS", 25);
  const stateFile = process.env.STATE_FILE?.trim() || "/app/data/state.json";
  const alertIncoming = optionalBooleanEnv("ALERT_INCOMING", true);
  const alertOutgoing = optionalBooleanEnv("ALERT_OUTGOING", true);
  const alertOnStartup = optionalBooleanEnv("ALERT_ON_STARTUP", true);
  const sendTestAlertsOnStartup = optionalBooleanEnv("SEND_TEST_ALERTS_ON_STARTUP", false);
  const logScanProgress = optionalBooleanEnv("LOG_SCAN_PROGRESS", true);
  const sendRecentRealAlertsOnStartup = optionalBooleanEnv(
    "SEND_RECENT_REAL_ALERTS_ON_STARTUP",
    false
  );
  const recentRealAlertLookbackBlocks = optionalNumberEnv("RECENT_REAL_ALERT_LOOKBACK_BLOCKS", 5000);
  const recentRealAlertBlockRange = optionalNumberEnv("RECENT_REAL_ALERT_BLOCK_RANGE", 50);
  const recentRealAlertMaxPerWallet = optionalNumberEnv("RECENT_REAL_ALERT_MAX_PER_WALLET", 3);
  const alertWhenNoRecentRealTransfers = optionalBooleanEnv(
    "ALERT_WHEN_NO_RECENT_REAL_TRANSFERS",
    true
  );
  const verifyBlock = process.env.VERIFY_BLOCK?.trim()
    ? optionalNumberEnv("VERIFY_BLOCK", 0)
    : null;
  const verifyToBlock = process.env.VERIFY_TO_BLOCK?.trim()
    ? optionalNumberEnv("VERIFY_TO_BLOCK", 0)
    : verifyBlock;
  const startFromLatestOnBoot = optionalBooleanEnv("START_FROM_LATEST_ON_BOOT", true);

  if (!alertIncoming && !alertOutgoing) {
    throw new Error("At least one of ALERT_INCOMING or ALERT_OUTGOING must be true");
  }

  console.log("Starting BSC USDT monitor...");
  console.log(`Configured wallets: ${watchedWallets.map((wallet) => wallet.label).join(", ")}`);
  console.log(`Trying ${rpcUrls.length} RPC endpoint(s)`);

  const { provider, rpcUrl } = await connectProvider(rpcUrls, rpcTimeoutMs);
  const rateLimitedProvider = new RateLimitedProvider(provider, rpcMinDelayMs);

  const usdt = new Contract(USDT_ADDRESS, ERC20_ABI, provider);
  console.log(`Connected to BSC RPC. Using token metadata: ${symbol}, decimals=${decimals}`);

  const walletByAddress = new Map(
    watchedWallets.map((wallet) => [normalizeAddress(wallet.address), wallet])
  );
  const walletTopics = watchedWallets.map((wallet) => addressToTopic(wallet.address));

  const currentBlock = await withTimeout(
    rateLimitedProvider.getBlockNumber(),
    rpcTimeoutMs,
    "latest block request timed out"
  );
  const savedState = startFromLatestOnBoot ? null : await readState(stateFile);
  let lastProcessedBlock =
    startFromLatestOnBoot
      ? Math.max(0, currentBlock - confirmations)
      : savedState?.lastProcessedBlock ?? Math.max(0, currentBlock - confirmations);

  await writeState(stateFile, { lastProcessedBlock });

  console.log(`Watching ${symbol} transfers on BSC mainnet`);
  console.log(`RPC: ${rpcUrl}`);
  console.log(`Wallets: ${watchedWallets.map((wallet) => wallet.label).join(", ")}`);
  console.log(`Telegram chat IDs: ${telegramChatIds.join(", ")}`);
  console.log(`Starting after block ${lastProcessedBlock}`);
  if (useWebSocket) {
    console.log(`WebSocket live endpoint(s): ${wsUrls.join(", ")}`);
    console.log(`Will subscribe: all ${symbol} Transfer events on ${USDT_ADDRESS}`);
    console.log(
      `Will filter locally for wallets: ${watchedWallets
        .map((wallet) => `${wallet.label}=${wallet.address}`)
        .join(", ")}`
    );
  }

  if (verifyBlock !== null && verifyToBlock !== null) {
    await verifyHistoricalRange({
      provider: rateLimitedProvider,
      usdt,
      telegramToken,
      telegramChatIds,
      telegramTimeoutMs,
      telegramRetries,
      walletByAddress,
      walletTopics,
      symbol,
      decimals,
      fromBlock: verifyBlock,
      toBlock: verifyToBlock,
      alertIncoming,
      alertOutgoing,
      rpcTimeoutMs
    });
    return;
  }

  const commandPoller = telegramCommandsEnabled
    ? startTelegramCommandPoller({
        provider: rateLimitedProvider,
        usdt,
        telegramToken,
        allowedChatIds: telegramChatIds,
        telegramTimeoutMs,
        telegramRetries,
        pollIntervalMs: telegramCommandPollIntervalMs,
        watchedWallets,
        walletByAddress,
        walletTopics,
        symbol,
        decimals,
        alertIncoming,
        alertOutgoing,
        rpcTimeoutMs
      })
    : null;

  if (commandPoller) {
    console.log("Telegram commands enabled: /verify <block> [toBlock]");
  }

  if (alertOnStartup) {
    const startupMessage = [
      "<b>BSC USDT monitor started</b>",
      "",
      `<b>Token:</b> ${escapeHtml(symbol)}`,
      `<b>RPC:</b> <code>${escapeHtml(rpcUrl)}</code>`,
      `<b>Wallets:</b> ${escapeHtml(watchedWallets.map((wallet) => wallet.label).join(", "))}`,
      `<b>Starting after block:</b> ${lastProcessedBlock}`
    ].join("\n");

    await safeSendTelegramBroadcast(
      telegramToken,
      telegramChatIds,
      startupMessage,
      telegramTimeoutMs,
      telegramRetries,
      "startup status"
    );
  }

  if (sendTestAlertsOnStartup) {
    for (const wallet of watchedWallets) {
      await safeSendTelegramBroadcast(
        telegramToken,
        telegramChatIds,
        buildTestAlertMessage(wallet, symbol),
        telegramTimeoutMs,
        telegramRetries,
        `startup test alert for ${wallet.label}`
      );
      console.log(`Sent startup test alert for ${wallet.label}`);
    }
  }

  if (sendRecentRealAlertsOnStartup) {
    await sendRecentRealTransferAlerts({
      provider: rateLimitedProvider,
      usdt,
      telegramToken,
      telegramChatIds,
      telegramTimeoutMs,
      telegramRetries,
      walletByAddress,
      walletTopics,
      symbol,
      decimals,
      currentBlock,
      confirmations,
      blockRange: recentRealAlertBlockRange,
      lookbackBlocks: recentRealAlertLookbackBlocks,
      maxPerWallet: recentRealAlertMaxPerWallet,
      alertIncoming,
      alertOutgoing,
      alertWhenNoneFound: alertWhenNoRecentRealTransfers,
      indexedApi
    });
  }

  if (useWebSocket) {
    await startWebSocketMonitor({
      wsUrls,
      usdt,
      telegramToken,
      telegramChatIds,
      telegramTimeoutMs,
      telegramRetries,
      walletByAddress,
      walletTopics,
      symbol,
      decimals,
      alertIncoming,
      alertOutgoing,
      logDecodedSummary: logWebSocketDecodedSummary,
      decodedSummaryIntervalMs: webSocketDecodedSummaryIntervalMs
    });

    console.log("WebSocket live monitoring active");
    while (true) {
      await sleep(60_000);
    }
  }

  while (true) {
    try {
      const latestBlock = await withTimeout(
        rateLimitedProvider.getBlockNumber(),
        rpcTimeoutMs,
        "latest block request timed out"
      );
      const targetBlock = latestBlock - confirmations;
      const backlog = targetBlock - lastProcessedBlock;

      if (targetBlock <= lastProcessedBlock) {
        await sleep(pollIntervalMs);
        continue;
      }

      if (maxBacklogBlocks > 0 && backlog > maxBacklogBlocks) {
        const skippedFromBlock = lastProcessedBlock + 1;
        lastProcessedBlock = Math.max(0, targetBlock - maxBacklogBlocks);
        await writeState(stateFile, { lastProcessedBlock });
        console.warn(
          `Backlog ${backlog} block(s) exceeds MAX_BACKLOG_BLOCKS=${maxBacklogBlocks}; skipped ${skippedFromBlock}-${lastProcessedBlock}`
        );
      }

      const fromBlock = lastProcessedBlock + 1;
      const toBlock = Math.min(targetBlock, fromBlock + maxBlockRange - 1);
      const remainingBacklog = targetBlock - lastProcessedBlock;

      if (logScanProgress) {
        console.log(
          `Live scan ${fromBlock}-${toBlock}; latest=${latestBlock}; backlog=${remainingBacklog} block(s)`
        );
      }

      let logs: Log[] = [];
      let indexedFallbackAlerts: TransferAlert[] = [];
      try {
        logs = await fetchTransferLogs(rateLimitedProvider, fromBlock, toBlock, walletTopics, {
          incoming: alertIncoming,
          outgoing: alertOutgoing,
          timeoutMs: rpcTimeoutMs
        });
      } catch (error) {
        if (!indexedApi) throw error;

        console.warn(
          `RPC log scan failed: ${formatError(error)}. Trying ${indexedApi.name} fallback for ${fromBlock}-${toBlock}.`
        );
        indexedFallbackAlerts = await fetchIndexedTransferAlerts({
          indexedApi,
          wallets: watchedWallets,
          walletByAddress,
          fromBlock,
          toBlock,
          symbol,
          decimals,
          alertIncoming,
          alertOutgoing,
          sort: "asc",
          limitPerWallet: 100
        });
      }

      if (logScanProgress) {
        console.log(
          `Live scan result: ${logs.length + indexedFallbackAlerts.length} matching ${symbol} transfer(s)`
        );
      }

      const seenLogs = new Set<string>();
      const seenAlerts = new Set<string>();
      for (const log of logs) {
        const logKey = `${log.transactionHash}:${log.index}`;
        if (seenLogs.has(logKey)) continue;
        seenLogs.add(logKey);

        const parsed = usdt.interface.parseLog(log);
        if (!parsed) continue;

        const alert = buildTransferAlert({
          log,
          parsedArgs: parsed.args,
          walletByAddress,
          symbol,
          decimals
        });
        if (!alert) continue;

        await sendTelegramBroadcast(
          telegramToken,
          telegramChatIds,
          buildTransferAlertMessage(alert),
          telegramTimeoutMs,
          telegramRetries
        );
        console.log(
          `${alert.direction} ${alert.amount} ${symbol} for ${alert.wallet.label}: ${log.transactionHash}`
        );
      }

      for (const alert of indexedFallbackAlerts) {
        const alertKey = `${alert.transactionHash}:${alert.direction}:${alert.wallet.address}`;
        if (seenAlerts.has(alertKey)) continue;
        seenAlerts.add(alertKey);

        await sendTelegramBroadcast(
          telegramToken,
          telegramChatIds,
          buildTransferAlertMessage(alert),
          telegramTimeoutMs,
          telegramRetries
        );
        console.log(
          `${alert.direction} ${alert.amount} ${symbol} for ${alert.wallet.label}: ${alert.transactionHash}`
        );
      }

      lastProcessedBlock = toBlock;
      await writeState(stateFile, { lastProcessedBlock });
    } catch (error) {
      console.warn(`Live scan failed: ${formatError(error)}. Retrying same block range.`);
      await sleep(Math.max(pollIntervalMs, 15_000));
    }
  }
}

function buildTransferAlert(input: {
  log: Log;
  parsedArgs: unknown;
  walletByAddress: Map<string, WalletConfig>;
  symbol: string;
  decimals: number;
}): TransferAlert | null {
  const args = input.parsedArgs as { from: string; to: string; value: bigint };
  const from = args.from;
  const to = args.to;
  const fromWallet = input.walletByAddress.get(normalizeAddress(from));
  const toWallet = input.walletByAddress.get(normalizeAddress(to));
  const wallet = toWallet ?? fromWallet;
  if (!wallet) return null;

  return {
    direction: toWallet ? "Inflow" : "Outflow",
    wallet,
    amount: formatTokenAmount(args.value, input.decimals),
    symbol: input.symbol,
    from,
    to,
    transactionHash: input.log.transactionHash,
    blockNumber: input.log.blockNumber
  };
}

function buildTransferAlertMessage(alert: TransferAlert, prefix = ""): string {
  const txUrl = `https://bscscan.com/tx/${alert.transactionHash}`;
  const title = `${prefix}${alert.symbol} ${alert.direction}`;

  return [
    `<b>${escapeHtml(title)}</b>`,
    "",
    `<b>Wallet:</b> ${escapeHtml(alert.wallet.label)}`,
    `<b>Amount:</b> ${escapeHtml(alert.amount)} ${escapeHtml(alert.symbol)}`,
    `<b>From:</b> <code>${escapeHtml(alert.from)}</code>`,
    `<b>To:</b> <code>${escapeHtml(alert.to)}</code>`,
    `<b>Tx:</b> <code>${escapeHtml(alert.transactionHash)}</code>`,
    `<b>Block:</b> ${alert.blockNumber}`,
    `<a href="${txUrl}">Open on BscScan</a>`
  ].join("\n");
}

function buildTestAlertMessage(wallet: WalletConfig, symbol: string): string {
  return [
    `<b>TEST ${escapeHtml(symbol)} Inflow</b>`,
    "",
    `<b>Wallet:</b> ${escapeHtml(wallet.label)}`,
    "<b>Amount:</b> 0 TEST",
    "<b>From:</b> <code>0x0000000000000000000000000000000000000000</code>",
    `<b>To:</b> <code>${escapeHtml(wallet.address)}</code>`,
    "<b>Tx:</b> test startup message",
    "",
    "This is only a startup test alert. No real on-chain transfer happened."
  ].join("\n");
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function verifyHistoricalRange(input: {
  provider: RpcProvider;
  usdt: Contract;
  telegramToken: string;
  telegramChatIds: string[];
  telegramTimeoutMs: number;
  telegramRetries: number;
  walletByAddress: Map<string, WalletConfig>;
  walletTopics: string[];
  symbol: string;
  decimals: number;
  fromBlock: number;
  toBlock: number;
  alertIncoming: boolean;
  alertOutgoing: boolean;
  rpcTimeoutMs: number;
}): Promise<number> {
  if (input.toBlock < input.fromBlock) {
    throw new Error("toBlock must be greater than or equal to fromBlock");
  }

  console.log(`Verification scan ${input.fromBlock}-${input.toBlock}`);

  const logs = await fetchTransferLogs(
    input.provider,
    input.fromBlock,
    input.toBlock,
    input.walletTopics,
    {
      incoming: input.alertIncoming,
      outgoing: input.alertOutgoing,
      timeoutMs: input.rpcTimeoutMs
    }
  );

  console.log(`Verification found ${logs.length} matching ${input.symbol} transfer log(s)`);

  const seenLogs = new Set<string>();
  let sent = 0;
  for (const log of logs) {
    const logKey = `${log.transactionHash}:${log.index}`;
    if (seenLogs.has(logKey)) continue;
    seenLogs.add(logKey);

    const parsed = input.usdt.interface.parseLog(log);
    if (!parsed) continue;

    const alert = buildTransferAlert({
      log,
      parsedArgs: parsed.args,
      walletByAddress: input.walletByAddress,
      symbol: input.symbol,
      decimals: input.decimals
    });
    if (!alert) continue;

    await sendTelegramBroadcast(
      input.telegramToken,
      input.telegramChatIds,
      buildTransferAlertMessage(alert, "HISTORICAL VERIFY "),
      input.telegramTimeoutMs,
      input.telegramRetries
    );
    sent += 1;
    console.log(
      `Verified ${alert.direction.toLowerCase()} ${alert.amount} ${alert.symbol} for ${alert.wallet.label}: ${alert.transactionHash}`
    );
  }

  if (sent === 0) {
    console.log("Verification completed with no matching watched-wallet transfers");
  }

  return sent;
}

async function startWebSocketMonitor(input: {
  wsUrls: string[];
  usdt: Contract;
  telegramToken: string;
  telegramChatIds: string[];
  telegramTimeoutMs: number;
  telegramRetries: number;
  walletByAddress: Map<string, WalletConfig>;
  walletTopics: string[];
  symbol: string;
  decimals: number;
  alertIncoming: boolean;
  alertOutgoing: boolean;
  logDecodedSummary: boolean;
  decodedSummaryIntervalMs: number;
}): Promise<void> {
  const { provider, wsUrl } = await connectWebSocketProvider(input.wsUrls);
  const seenLogs = new Set<string>();
  let decodedCount = 0;
  let matchedCount = 0;

  if (input.logDecodedSummary) {
    setInterval(() => {
      console.log(
        `WebSocket decoded ${decodedCount} ${input.symbol} Transfer event(s); matched watched wallets: ${matchedCount}`
      );
      decodedCount = 0;
      matchedCount = 0;
    }, input.decodedSummaryIntervalMs);
  }

  const filter = {
    address: USDT_ADDRESS,
    topics: [TRANSFER_TOPIC]
  };

  console.log(`Subscribing once: ${input.symbol} Transfer events on ${USDT_ADDRESS}`);
  provider.on(filter, (log: Log) => {
    void (async () => {
      const logKey = `${log.transactionHash}:${log.index}`;
      if (seenLogs.has(logKey)) return;
      seenLogs.add(logKey);

      const parsed = input.usdt.interface.parseLog(log);
      if (!parsed) return;
      decodedCount += 1;

      const alert = buildTransferAlert({
        log,
        parsedArgs: parsed.args,
        walletByAddress: input.walletByAddress,
        symbol: input.symbol,
        decimals: input.decimals
      });
      if (!alert) return;
      if (alert.direction === "Inflow" && !input.alertIncoming) return;
      if (alert.direction === "Outflow" && !input.alertOutgoing) return;
      matchedCount += 1;

      console.log(
        `WebSocket matched ${alert.symbol} ${alert.direction}: wallet=${alert.wallet.label}, amount=${alert.amount}, block=${alert.blockNumber}, tx=${alert.transactionHash}`
      );

      await sendTelegramBroadcast(
        input.telegramToken,
        input.telegramChatIds,
        buildTransferAlertMessage(alert),
        input.telegramTimeoutMs,
        input.telegramRetries
      );

      console.log(
        `WebSocket ${alert.direction.toLowerCase()} ${alert.amount} ${alert.symbol} for ${alert.wallet.label}: ${alert.transactionHash}`
      );
    })().catch((error) => {
      console.warn(`WebSocket alert handling failed: ${formatError(error)}`);
    });
  });

  console.log(`Subscribed to USDT Transfer events over WebSocket: ${wsUrl}`);
}

async function connectWebSocketProvider(
  wsUrls: string[]
): Promise<{ provider: WebSocketProvider; wsUrl: string }> {
  const errors: string[] = [];

  for (const wsUrl of wsUrls) {
    try {
      console.log(`Trying WebSocket RPC: ${wsUrl}`);
      const provider = new WebSocketProvider(wsUrl, Number(CHAIN_ID));
      const network = await provider.getNetwork();
      if (network.chainId !== CHAIN_ID) {
        throw new Error(`chain ID mismatch. Expected ${CHAIN_ID}, got ${network.chainId}`);
      }

      console.log(`Connected WebSocket RPC: ${wsUrl}`);
      return { provider, wsUrl };
    } catch (error) {
      const message = formatError(error);
      console.warn(`WebSocket RPC failed: ${wsUrl} (${message})`);
      errors.push(`${wsUrl}: ${message}`);
    }
  }

  throw new Error(`No usable BSC WebSocket endpoint found:\n${errors.join("\n")}`);
}

function startTelegramCommandPoller(input: {
  provider: RpcProvider;
  usdt: Contract;
  telegramToken: string;
  allowedChatIds: string[];
  telegramTimeoutMs: number;
  telegramRetries: number;
  pollIntervalMs: number;
  watchedWallets: WalletConfig[];
  walletByAddress: Map<string, WalletConfig>;
  walletTopics: string[];
  symbol: string;
  decimals: number;
  alertIncoming: boolean;
  alertOutgoing: boolean;
  rpcTimeoutMs: number;
}): NodeJS.Timeout {
  let offset = 0;
  let busy = false;

  const poll = async () => {
    if (busy) return;
    busy = true;

    try {
      const updates = await getTelegramUpdates(
        input.telegramToken,
        offset,
        input.telegramTimeoutMs
      );

      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        const message = update.message;
        const text = message?.text?.trim();
        if (!message || !text) continue;
        const replyChatId = String(message.chat.id);
        if (!input.allowedChatIds.includes(replyChatId)) continue;

        await handleTelegramCommand({ ...input, replyChatId }, text);
      }
    } catch (error) {
      console.warn(`Telegram command poll failed: ${formatError(error)}`);
    } finally {
      busy = false;
    }
  };

  void poll();
  return setInterval(() => void poll(), input.pollIntervalMs);
}

async function getTelegramUpdates(
  token: string,
  offset: number,
  timeoutMs: number
): Promise<TelegramUpdate[]> {
  const url = new URL(`https://api.telegram.org/bot${token}/getUpdates`);
  if (offset > 0) url.searchParams.set("offset", String(offset));
  url.searchParams.set("timeout", "0");
  url.searchParams.set("allowed_updates", JSON.stringify(["message"]));

  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram getUpdates failed: ${response.status} ${body}`);
  }

  const body = (await response.json()) as {
    ok?: boolean;
    result?: TelegramUpdate[];
    description?: string;
  };

  if (!body.ok || !Array.isArray(body.result)) {
    throw new Error(`Telegram getUpdates failed: ${body.description ?? "invalid response"}`);
  }

  return body.result;
}

async function handleTelegramCommand(
  input: {
    provider: RpcProvider;
    usdt: Contract;
    telegramToken: string;
    allowedChatIds: string[];
    replyChatId: string;
    telegramTimeoutMs: number;
    telegramRetries: number;
    walletByAddress: Map<string, WalletConfig>;
    walletTopics: string[];
    watchedWallets: WalletConfig[];
    symbol: string;
    decimals: number;
    alertIncoming: boolean;
    alertOutgoing: boolean;
    rpcTimeoutMs: number;
  },
  text: string
): Promise<void> {
  const [commandWithBot, fromText, toText] = text.split(/\s+/);
  const command = commandWithBot.split("@")[0]?.toLowerCase();

  if (command !== "/verify") {
    if (command === "/balances") {
      await handleBalancesCommand(input);
    } else if (command === "/chatid") {
      await safeSendTelegramMessage(
        input.telegramToken,
        input.replyChatId,
        `This chat ID is:\n<code>${escapeHtml(input.replyChatId)}</code>`,
        input.telegramTimeoutMs,
        input.telegramRetries,
        "chatid command"
      );
    } else if (command === "/start" || command === "/help") {
      await safeSendTelegramMessage(
        input.telegramToken,
        input.replyChatId,
        "Commands:\n<code>/balances</code>\n<code>/verify 98456008</code>\n<code>/verify 98456008 98456013</code>\n<code>/chatid</code>\n\nRange limit: 10 blocks.",
        input.telegramTimeoutMs,
        input.telegramRetries,
        "help command"
      );
    }
    return;
  }

  const fromBlock = Number(fromText);
  const toBlock = toText ? Number(toText) : fromBlock;
  if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || fromBlock < 0 || toBlock < 0) {
    await safeSendTelegramMessage(
      input.telegramToken,
      input.replyChatId,
      "Usage:\n<code>/verify 98456008</code>\nor\n<code>/verify 98456008 98456013</code>",
      input.telegramTimeoutMs,
      input.telegramRetries,
      "verify usage"
    );
    return;
  }

  if (toBlock < fromBlock) {
    await safeSendTelegramMessage(
      input.telegramToken,
      input.replyChatId,
      "Invalid range: toBlock must be greater than or equal to fromBlock.",
      input.telegramTimeoutMs,
      input.telegramRetries,
      "verify invalid range"
    );
    return;
  }

  if (toBlock - fromBlock + 1 > 10) {
    await safeSendTelegramMessage(
      input.telegramToken,
      input.replyChatId,
      "Range too large. Use 10 blocks or fewer.",
      input.telegramTimeoutMs,
      input.telegramRetries,
      "verify range limit"
    );
    return;
  }

  await safeSendTelegramMessage(
    input.telegramToken,
    input.replyChatId,
    `Scanning BSC blocks ${fromBlock}-${toBlock} for watched-wallet ${input.symbol} transfers...`,
    input.telegramTimeoutMs,
    input.telegramRetries,
    "verify started"
  );

  try {
    const sent = await verifyHistoricalRange({
      provider: input.provider,
      usdt: input.usdt,
      telegramToken: input.telegramToken,
      telegramChatIds: [input.replyChatId],
      telegramTimeoutMs: input.telegramTimeoutMs,
      telegramRetries: input.telegramRetries,
      walletByAddress: input.walletByAddress,
      walletTopics: input.walletTopics,
      symbol: input.symbol,
      decimals: input.decimals,
      fromBlock,
      toBlock,
      alertIncoming: input.alertIncoming,
      alertOutgoing: input.alertOutgoing,
      rpcTimeoutMs: input.rpcTimeoutMs
    });

    if (sent === 0) {
      await safeSendTelegramMessage(
        input.telegramToken,
        input.replyChatId,
        `No matching watched-wallet ${input.symbol} transfers found in blocks ${fromBlock}-${toBlock}.`,
        input.telegramTimeoutMs,
        input.telegramRetries,
        "verify no match"
      );
    }
  } catch (error) {
    await safeSendTelegramMessage(
      input.telegramToken,
      input.replyChatId,
      `Verify failed for blocks ${fromBlock}-${toBlock}: ${formatError(error)}`,
      input.telegramTimeoutMs,
      input.telegramRetries,
      "verify failed"
    );
  }
}

async function handleBalancesCommand(input: {
  provider: RpcProvider;
  usdt: Contract;
  telegramToken: string;
  replyChatId: string;
  telegramTimeoutMs: number;
  telegramRetries: number;
  watchedWallets: WalletConfig[];
  symbol: string;
  decimals: number;
}): Promise<void> {
  try {
    const lines = ["<b>Wallet Balances</b>", ""];

    for (const wallet of input.watchedWallets) {
      const [rawTokenBalance, rawBnbBalance] = await Promise.all([
        input.usdt.balanceOf(wallet.address) as Promise<bigint>,
        input.provider.getBalance(wallet.address)
      ]);
      const tokenBalance = formatTokenAmount(rawTokenBalance, input.decimals);
      const bnbBalance = formatDisplayAmount(formatEther(rawBnbBalance));

      lines.push(`<b>${escapeHtml(wallet.label)}</b>`);
      lines.push(`BNB: ${escapeHtml(bnbBalance)} BNB`);
      lines.push(`${escapeHtml(input.symbol)}: ${escapeHtml(tokenBalance)} ${escapeHtml(input.symbol)}`);
      lines.push(`<code>${escapeHtml(wallet.address)}</code>`);
      lines.push("");
    }

    await safeSendTelegramMessage(
      input.telegramToken,
      input.replyChatId,
      lines.join("\n").trim(),
      input.telegramTimeoutMs,
      input.telegramRetries,
      "balances command"
    );
  } catch (error) {
    await safeSendTelegramMessage(
      input.telegramToken,
      input.replyChatId,
      `Balance lookup failed: ${formatError(error)}`,
      input.telegramTimeoutMs,
      input.telegramRetries,
      "balances command failed"
    );
  }
}

async function fetchIndexedTransferAlerts(input: {
  indexedApi: IndexedApiConfig;
  wallets: WalletConfig[];
  walletByAddress: Map<string, WalletConfig>;
  fromBlock: number;
  toBlock: number;
  symbol: string;
  decimals: number;
  alertIncoming: boolean;
  alertOutgoing: boolean;
  sort: "asc" | "desc";
  limitPerWallet: number;
}): Promise<TransferAlert[]> {
  const alerts: TransferAlert[] = [];

  for (const wallet of input.wallets) {
    const url = new URL(input.indexedApi.baseUrl);
    if (input.indexedApi.chainId) {
      url.searchParams.set("chainid", input.indexedApi.chainId);
    }
    url.searchParams.set("module", "account");
    url.searchParams.set("action", "tokentx");
    url.searchParams.set("contractaddress", USDT_ADDRESS);
    url.searchParams.set("address", wallet.address);
    url.searchParams.set("startblock", String(input.fromBlock));
    url.searchParams.set("endblock", String(input.toBlock));
    url.searchParams.set("page", "1");
    url.searchParams.set("offset", String(input.limitPerWallet));
    url.searchParams.set("sort", input.sort);
    url.searchParams.set("apikey", input.indexedApi.apiKey);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`indexed API failed: HTTP ${response.status}`);
    }

    const body = (await response.json()) as {
      status?: string;
      message?: string;
      result?: IndexedTransfer[] | string;
    };

    if (body.status !== "1") {
      const resultText = typeof body.result === "string" ? `: ${body.result}` : "";
      console.warn(
        `${input.indexedApi.name} returned no rows for ${wallet.label}: ${body.message}${resultText}`
      );
      continue;
    }

    if (!Array.isArray(body.result)) continue;

    for (const transfer of body.result) {
      const fromWallet = input.walletByAddress.get(normalizeAddress(transfer.from));
      const toWallet = input.walletByAddress.get(normalizeAddress(transfer.to));
      const matchedWallet = toWallet ?? fromWallet;
      if (!matchedWallet) continue;

      const direction = toWallet ? "Inflow" : "Outflow";
      if (direction === "Inflow" && !input.alertIncoming) continue;
      if (direction === "Outflow" && !input.alertOutgoing) continue;

      const transferDecimals = Number(transfer.tokenDecimal ?? input.decimals);
      alerts.push({
        direction,
        wallet: matchedWallet,
        amount: formatTokenAmount(BigInt(transfer.value), transferDecimals),
        symbol: transfer.tokenSymbol || input.symbol,
        from: transfer.from,
        to: transfer.to,
        transactionHash: transfer.hash,
        blockNumber: Number(transfer.blockNumber)
      });
    }
  }

  return alerts;
}

async function sendRecentRealTransferAlerts(input: {
  provider: RpcProvider;
  usdt: Contract;
  telegramToken: string;
  telegramChatIds: string[];
  telegramTimeoutMs: number;
  telegramRetries: number;
  walletByAddress: Map<string, WalletConfig>;
  walletTopics: string[];
  symbol: string;
  decimals: number;
  currentBlock: number;
  confirmations: number;
  blockRange: number;
  lookbackBlocks: number;
  maxPerWallet: number;
  alertIncoming: boolean;
  alertOutgoing: boolean;
  alertWhenNoneFound: boolean;
  indexedApi: IndexedApiConfig | null;
}): Promise<void> {
  if (input.lookbackBlocks === 0 || input.maxPerWallet === 0) return;

  const targetBlock = input.currentBlock - input.confirmations;
  let toBlock = targetBlock;
  const oldestBlock = Math.max(0, targetBlock - input.lookbackBlocks + 1);
  const sentByWallet = new Map<string, number>();
  let failedChunks = 0;

  console.log(
    `Scanning recent real transfers from blocks ${oldestBlock}-${targetBlock} for startup replay`
  );

  if (input.indexedApi) {
    const alerts = await fetchIndexedTransferAlerts({
      indexedApi: input.indexedApi,
      wallets: [...input.walletByAddress.values()],
      walletByAddress: input.walletByAddress,
      fromBlock: oldestBlock,
      toBlock: targetBlock,
      symbol: input.symbol,
      decimals: input.decimals,
      alertIncoming: input.alertIncoming,
      alertOutgoing: input.alertOutgoing,
      sort: "desc",
      limitPerWallet: input.maxPerWallet
    });

    for (const alert of alerts) {
      const walletKey = normalizeAddress(alert.wallet.address);
      const alreadySent = sentByWallet.get(walletKey) ?? 0;
      if (alreadySent >= input.maxPerWallet) continue;

      await sendTelegramBroadcast(
        input.telegramToken,
        input.telegramChatIds,
        buildTransferAlertMessage(alert, "RECENT REAL ON-CHAIN "),
        input.telegramTimeoutMs,
        input.telegramRetries
      );
      sentByWallet.set(walletKey, alreadySent + 1);
      console.log(
        `Sent indexed recent real ${alert.direction.toLowerCase()} alert for ${alert.wallet.label}: ${alert.transactionHash}`
      );
    }

    if (sentByWallet.size > 0) return;

    console.log(
      `${input.indexedApi.name} found no recent matching USDT transfers for startup replay`
    );
  }

  while (toBlock >= oldestBlock) {
    const fromBlock = Math.max(oldestBlock, toBlock - input.blockRange + 1);
    console.log(`Startup replay scanning blocks ${fromBlock}-${toBlock}`);

    let logs: Log[] = [];
    try {
      logs = await fetchTransferLogs(
        input.provider,
        fromBlock,
        toBlock,
        input.walletTopics,
        {
          incoming: input.alertIncoming,
          outgoing: input.alertOutgoing,
          timeoutMs: 15_000
        }
      );
    } catch (error) {
      failedChunks += 1;
      const message = formatError(error);
      console.warn(`Startup replay skipped ${fromBlock}-${toBlock}: ${message}`);
      toBlock = fromBlock - 1;
      continue;
    }

    console.log(`Startup replay found ${logs.length} matching log(s) in ${fromBlock}-${toBlock}`);

    for (const log of logs.reverse()) {
      const parsed = input.usdt.interface.parseLog(log);
      if (!parsed) continue;

      const alert = buildTransferAlert({
        log,
        parsedArgs: parsed.args,
        walletByAddress: input.walletByAddress,
        symbol: input.symbol,
        decimals: input.decimals
      });
      if (!alert) continue;

      const walletKey = normalizeAddress(alert.wallet.address);
      const alreadySent = sentByWallet.get(walletKey) ?? 0;
      if (alreadySent >= input.maxPerWallet) continue;

      await sendTelegramBroadcast(
        input.telegramToken,
        input.telegramChatIds,
        buildTransferAlertMessage(alert, "RECENT REAL ON-CHAIN "),
        input.telegramTimeoutMs,
        input.telegramRetries
      );
      sentByWallet.set(walletKey, alreadySent + 1);
      console.log(
        `Sent recent real ${alert.direction.toLowerCase()} alert for ${alert.wallet.label}: ${alert.transactionHash}`
      );
    }

    if ([...sentByWallet.values()].reduce((sum, count) => sum + count, 0) >= input.maxPerWallet * input.walletTopics.length) {
      break;
    }

    toBlock = fromBlock - 1;
  }

  if (sentByWallet.size === 0) {
    console.log("No recent real matching USDT transfers found for startup replay");
    if (input.alertWhenNoneFound) {
      await safeSendTelegramBroadcast(
        input.telegramToken,
        input.telegramChatIds,
        [
          "<b>BSC USDT monitor live</b>",
          "",
          "No recent real USDT transfers were found for the watched wallets in the startup replay window.",
          `<b>Replay blocks:</b> ${oldestBlock}-${targetBlock}`,
          `<b>Skipped replay chunks:</b> ${failedChunks}`,
          "",
          "Live monitoring is now active."
        ].join("\n"),
        input.telegramTimeoutMs,
        input.telegramRetries,
        "no recent transfer status"
      );
    }
  }
}

async function connectProvider(
  rpcUrls: string[],
  timeoutMs: number
): Promise<{ provider: JsonRpcProvider; rpcUrl: string }> {
  const errors: string[] = [];
  const tatumApiKey = process.env.TATUM_API_KEY?.trim();

  for (const rpcUrl of rpcUrls) {
    try {
      console.log(`Trying RPC: ${rpcUrl}`);
      const connection = new FetchRequest(rpcUrl);
      if (tatumApiKey && rpcUrl.includes("gateway.tatum.io")) {
        connection.setHeader("x-api-key", tatumApiKey);
      }

      const provider = new JsonRpcProvider(connection, Number(CHAIN_ID), {
        batchMaxCount: 1
      });
      const network = await withTimeout(
        provider.getNetwork(),
        timeoutMs,
        `RPC timed out: ${rpcUrl}`
      );
      if (network.chainId !== CHAIN_ID) {
        throw new Error(`chain ID mismatch. Expected ${CHAIN_ID}, got ${network.chainId}`);
      }

      console.log(`Connected RPC: ${rpcUrl}`);
      return { provider, rpcUrl };
    } catch (error) {
      const message = formatError(error);
      console.warn(`RPC failed: ${rpcUrl} (${message})`);
      errors.push(`${rpcUrl}: ${message}`);
    }
  }

  throw new Error(`No usable BSC RPC endpoint found:\n${errors.join("\n")}`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function fetchTransferLogs(
  provider: RpcProvider,
  fromBlock: number,
  toBlock: number,
  walletTopics: string[],
  options: { incoming: boolean; outgoing: boolean; timeoutMs: number }
): Promise<Log[]> {
  const queries: Array<() => Promise<Log[]>> = [];

  for (const walletTopic of walletTopics) {
    if (options.incoming) {
      queries.push(
        () => provider.getLogs({
          address: USDT_ADDRESS,
          fromBlock,
          toBlock,
          topics: [TRANSFER_TOPIC, null, walletTopic]
        })
      );
    }

    if (options.outgoing) {
      queries.push(
        () => provider.getLogs({
          address: USDT_ADDRESS,
          fromBlock,
          toBlock,
          topics: [TRANSFER_TOPIC, walletTopic]
        })
      );
    }
  }

  const results: Log[] = [];
  for (const query of queries) {
    results.push(
      ...(await withTimeout(
        query(),
        options.timeoutMs,
        `eth_getLogs timed out for blocks ${fromBlock}-${toBlock}`
      ))
    );
  }

  return results.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    return a.index - b.index;
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  console.warn(`Unhandled async error: ${formatError(error)}`);
});
