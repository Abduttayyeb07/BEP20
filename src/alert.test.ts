import assert from "node:assert/strict";
import { Interface, type Log } from "ethers";

process.env.NODE_ENV = "test";

const {
  ERC20_ABI,
  buildAlertKey,
  buildTransferAlert,
  formatTokenAmount,
  normalizeAddress,
  parseTokenAmount
} = await import("./index.js");

const iface = new Interface(ERC20_ABI);
const maybeTransferEvent = iface.getEvent("Transfer");
if (!maybeTransferEvent) {
  throw new Error("Transfer event ABI missing");
}
const transferEvent = maybeTransferEvent;

const watchedWallet = {
  label: "Valdora Zignaly",
  address: "0x2d75e203c7bC5b51C71df881AF1857cE233eb2C8"
};
const secondWallet = {
  label: "Nawa Zignaly",
  address: "0x6a9d07A5aad5550b90Cb07E81374ef32dEe29eE0"
};
const externalWallet = "0x8BEf916137334781d72692328D0862b34B30F800";
const otherWallet = "0x1111111111111111111111111111111111111111";
const walletByAddress = new Map([
  [normalizeAddress(watchedWallet.address), watchedWallet],
  [normalizeAddress(secondWallet.address), secondWallet]
]);
const minAlertRawValue = parseTokenAmount("1", 18);

function fakeTransferLog(input: {
  from: string;
  to: string;
  value: bigint;
  txHash?: string;
  blockNumber?: number;
  index?: number;
}): Log {
  const encoded = iface.encodeEventLog(transferEvent, [input.from, input.to, input.value]);

  return {
    address: "0x55d398326f99059fF775485246999027B3197955",
    blockHash: "0x" + "a".repeat(64),
    blockNumber: input.blockNumber ?? 100,
    data: encoded.data,
    index: input.index ?? 0,
    removed: false,
    topics: encoded.topics,
    transactionHash: input.txHash ?? "0x" + "b".repeat(64),
    transactionIndex: 0
  } as unknown as Log;
}

function alertFromLog(log: Log) {
  const parsed = iface.parseLog(log);
  assert.ok(parsed);

  return buildTransferAlert({
    log,
    parsedArgs: parsed.args,
    walletByAddress,
    symbol: "USDT",
    decimals: 18,
    minAlertRawValue
  });
}

{
  const log = fakeTransferLog({
    from: externalWallet,
    to: watchedWallet.address,
    value: parseTokenAmount("75550", 18),
    txHash: "0x" + "1".repeat(64),
    blockNumber: 103232703
  });
  const alert = alertFromLog(log);
  assert.ok(alert);
  assert.equal(alert.direction, "Inflow");
  assert.equal(alert.wallet.label, "Valdora Zignaly");
  assert.equal(alert.amount, "75550");
  assert.equal(alert.blockNumber, 103232703);
}

{
  const log = fakeTransferLog({
    from: watchedWallet.address,
    to: externalWallet,
    value: parseTokenAmount("500000", 18),
    txHash: "0x" + "2".repeat(64)
  });
  const alert = alertFromLog(log);
  assert.ok(alert);
  assert.equal(alert.direction, "Outflow");
  assert.equal(alert.amount, "500000");
}

{
  const log = fakeTransferLog({
    from: watchedWallet.address,
    to: externalWallet,
    value: parseTokenAmount("0.5", 18),
    txHash: "0x" + "3".repeat(64)
  });
  assert.equal(alertFromLog(log), null);
}

{
  const log = fakeTransferLog({
    from: otherWallet,
    to: externalWallet,
    value: parseTokenAmount("100", 18),
    txHash: "0x" + "4".repeat(64)
  });
  assert.equal(alertFromLog(log), null);
}

{
  const log = fakeTransferLog({
    from: externalWallet,
    to: secondWallet.address,
    value: parseTokenAmount("1.234567", 18),
    txHash: "0x" + "5".repeat(64)
  });
  const alert = alertFromLog(log);
  assert.ok(alert);
  assert.equal(alert.direction, "Inflow");
  assert.equal(alert.wallet.label, "Nawa Zignaly");
  assert.equal(alert.amount, "1.234567");
  assert.equal(
    buildAlertKey(alert),
    `${alert.transactionHash}:Inflow:${normalizeAddress(secondWallet.address)}`
  );
}

assert.equal(formatTokenAmount(parseTokenAmount("1.000001", 18), 18), "1.000001");
assert.equal(formatTokenAmount(parseTokenAmount("0.0000009", 18), 18), "0.000000");

console.log("Alert parser tests passed");
