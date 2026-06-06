# BEP20 USDT Telegram Monitor

Dockerized TypeScript bot that watches USDT transfers on BNB Smart Chain and sends Telegram alerts for:

```bash
WATCHED_WALLETS=Valdora Zignaly=0x2d75e203c7bC5b51C71df881AF1857cE233eb2C8,Nawa Zignaly=0x6a9d07A5aad5550b90Cb07E81374ef32dEe29eE0
```

## Setup

1. Create a Telegram bot with BotFather and get the bot token.
2. Get your Telegram user or group chat ID.
3. Copy `.env.example` to `.env` and fill in:

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
TELEGRAM_CHAT_IDS=...
WATCHED_WALLETS=Valdora Zignaly=0x2d75e203c7bC5b51C71df881AF1857cE233eb2C8,Nawa Zignaly=0x6a9d07A5aad5550b90Cb07E81374ef32dEe29eE0
```

For multiple Telegram destinations, use comma-separated IDs:

```bash
TELEGRAM_CHAT_IDS=8010090311,123456789,-1001234567890
```

`TELEGRAM_CHAT_ID` is kept for single-chat backward compatibility.

4. Build and run:

```bash
docker compose up -d --build
```

5. View logs:

```bash
docker compose logs -f usdt-monitor
```

## RPC Endpoint

The example config uses:

```text
BSC_RPC_URLS=https://bsc.rpc.blxrbdn.com,https://bsc-mainnet.gateway.tatum.io
BSC_WS_URLS=wss://bsc-rpc.publicnode.com,wss://bsc.drpc.org
USE_WEBSOCKET=true
```

The bot can use WebSocket live subscriptions for new USDT transfers. The HTTP RPC list is used for startup checks and `/verify` commands.

`LOG_WEBSOCKET_DECODED_SUMMARY=true` prints a periodic count of decoded USDT transfer events so you can see the WebSocket stream is alive without logging every transfer.

When a URL contains `gateway.tatum.io`, the bot sends `TATUM_API_KEY` as the `x-api-key` header.

`RPC_TIMEOUT_MS` controls how long the bot waits before trying the next RPC URL. `RPC_MIN_DELAY_MS` spaces RPC calls apart; Tatum free keys are limited to 3 requests/sec, so keep this at `400` or higher.

## Indexed Fallback

For stronger verification, add a free BscScan API key:

```bash
BSCSCAN_API_KEY=...
```

The bot queries indexed BSC token transfers when replaying recent real alerts, and as a live fallback if RPC log polling times out.

`ETHERSCAN_API_KEY` is also supported, but Etherscan V2 may require a paid plan for BSC chain ID `56`.

## State

The bot stores the last processed block in `./data/state.json` while running. By default, each container start/restart checks the current BSC block and begins from the latest confirmed block:

```bash
START_FROM_LATEST_ON_BOOT=true
```

That mode can skip alerts for transfers that happen while the bot is offline. If you want restart catch-up behavior instead, set `START_FROM_LATEST_ON_BOOT=false`.

`MAX_BACKLOG_BLOCKS` limits live catch-up. If the bot falls behind by more than this, it jumps to the latest confirmed block instead of slowly replaying old ranges.

## Alert Contents

Each alert includes direction, wallet label, amount, from, to, transaction hash, block number, and BscScan transaction link.

On startup, the bot sends a Telegram status message if `ALERT_ON_STARTUP=true`.

For testing, `SEND_TEST_ALERTS_ON_STARTUP=true` sends one simulated Telegram alert per watched wallet. These messages are clearly marked as tests and do not mean a real transfer happened.

For real verification, `SEND_RECENT_REAL_ALERTS_ON_STARTUP=true` scans recent BSC blocks and sends Telegram messages only for actual historical USDT transfers involving watched wallets. These messages are marked as recent real on-chain events. `RECENT_REAL_ALERT_BLOCK_RANGE` controls the replay scan chunk size separately from live polling.

If no recent real transfer is found, `ALERT_WHEN_NO_RECENT_REAL_TRANSFERS=true` sends a Telegram status message confirming that live monitoring is active.

## One-Off Verification

To verify a known historical block without scanning all history:

```bash
VERIFY_BLOCK=98456008
VERIFY_TO_BLOCK=
npm run dev
```

The bot scans that block with the same transfer logic, sends matching Telegram alerts, prints the result, and exits. Use `VERIFY_TO_BLOCK` to scan a small range.

## Telegram Commands

When `TELEGRAM_COMMANDS_ENABLED=true`, send commands to the bot chat:

```text
/verify 98456008
/verify 98456008 98456013
/balances
/chatid
```

The range is capped at 10 blocks. The bot replies with matching transfers or a no-match message. `/balances` returns current USDT balances for watched wallets. `/chatid` replies with the exact Telegram Bot API chat ID for the chat where it was sent.

`LOG_SCAN_PROGRESS=true` prints each scanned block range and the number of matching logs found.
