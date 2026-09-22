import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LPTracker,
  LPAgentClient,
  SnapshotStore,
  formatAge,
  isAllowedUser,
  normalizeAddress,
  openingRangeDisplay,
  parseAllowedUserIds,
  positionFromApi,
  baseFeeDisplay,
  renderEventHtml,
  renderEventText,
  renderTrackListHtml,
} from "../src/features/tracker.js";

const WALLET = `0x${"a".repeat(40)}`;

function apiPosition(positionId, symbol0 = "WETH", symbol1 = "musebook") {
  return {
    id: positionId,
    protocol: "uniswap_v4",
    pairName: `${symbol0} / ${symbol1}`,
    tokenName0: symbol0,
    tokenName1: symbol1,
    decimal0: 18,
    decimal1: 6,
    inputToken0: "26400000000000000",
    inputToken1: "11076300000",
    price0: 2772.7272727,
    price1: 0.1633,
    createdAt: "2026-09-22T00:00:00Z",
    priceRange: [0.3, 0.6, 1.0],
  };
}

class FakeClient {
  constructor(items = [], overview = null) { this.items = items; this.overview = overview; }
  async openingPositions(address, chain) { return this.items.map((item) => positionFromApi(item, address, chain)); }
  async enrichPosition(position) { return position; }
  async walletOverview() { return this.overview; }
}

function makeTracker(items, overview = null) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lp-tracker-"));
  const store = new SnapshotStore(path.join(directory, "tracker.json"));
  const client = new FakeClient(items, overview);
  const tracker = new LPTracker(client, store);
  return { directory, store, client, tracker };
}

test("detects EVM and Solana addresses", () => {
  assert.deepEqual(normalizeAddress(WALLET), [WALLET, "ROBINHOOD"]);
  assert.deepEqual(normalizeAddress("1".repeat(32)), ["1".repeat(32), "SOL"]);
  assert.throws(() => normalizeAddress("not-a-wallet"));
});

test("restricts access to configured Telegram user IDs", () => {
  const allowed = parseAllowedUserIds("123456789, 987654321");
  assert.equal(isAllowedUser(123456789, allowed), true);
  assert.equal(isAllowedUser(111111111, allowed), false);
  assert.throws(() => parseAllowedUserIds(""));
  assert.throws(() => parseAllowedUserIds("not-a-number"));
});

test("first sync creates a baseline without alert", async () => {
  const { tracker, store } = makeTracker([apiPosition("p1")]);
  const result = await tracker.register(10, WALLET);
  assert.equal(result.added, true);
  assert.deepEqual(await tracker.syncAll(), []);
  assert.equal(Object.keys(store.positions(result.wallet)).length, 1);
});

test("new position emits one OPENED event", async () => {
  const { tracker, client } = makeTracker([apiPosition("p1")]);
  await tracker.register(10, WALLET);
  client.items.push(apiPosition("p2", "USDG", "musebook"));
  assert.deepEqual((await tracker.syncAll()).map((event) => [event.eventType, event.position.positionId]), [["OPENED", "p2"]]);
  assert.deepEqual(await tracker.syncAll(), []);
});

test("merges simultaneous positions from the same pool into one OPENED event", async () => {
  const { tracker, client } = makeTracker([apiPosition("baseline")]);
  await tracker.register(10, WALLET);
  const first = apiPosition("p1");
  const second = apiPosition("p2");
  for (const raw of [first, second]) {
    raw.pool = "0xnautilo-pool";
    raw.priceRange = [0.3, 1, 1];
    raw.inputValueUsd0 = 73.2;
    raw.inputValueUsd1 = 1.81;
  }
  client.items.push(first, second);
  const [event] = await tracker.syncAll();
  assert.equal(event.eventType, "OPENED");
  assert.deepEqual(event.positionIds, ["p1", "p2"]);
  assert.equal(event.position.investments[0].amount, 0.0528);
  assert.equal(event.position.investments[1].amount, 22152.6);
  assert.equal(event.position.investments.reduce((sum, item) => sum + item.share, 0).toFixed(2), "100.00");
  assert.match(renderEventText(event), /Range \| \+0% \| -70%/);
});

test("missing position emits one CLOSED event", async () => {
  const { tracker, client } = makeTracker([apiPosition("p1")]);
  await tracker.register(10, WALLET);
  client.items = [];
  assert.deepEqual((await tracker.syncAll()).map((event) => [event.eventType, event.position.positionId]), [["CLOSED", "p1"]]);
  assert.deepEqual(await tracker.syncAll(), []);
});

test("merges simultaneous positions from the same pool into one CLOSED event", async () => {
  const first = apiPosition("p1");
  const second = apiPosition("p2");
  first.pool = "0xnautilo-pool";
  second.pool = "0xnautilo-pool";
  const { tracker, client } = makeTracker([first, second]);
  await tracker.register(10, WALLET);
  client.items = [];
  const [event] = await tracker.syncAll();
  assert.equal(event.eventType, "CLOSED");
  assert.deepEqual(event.positionIds, ["p1", "p2"]);
  assert.equal(event.position.investments[0].amount, 0.0528);
});

test("restart preserves deduplication", async () => {
  const { tracker, client, store } = makeTracker([apiPosition("p1")]);
  await tracker.register(10, WALLET);
  client.items.push(apiPosition("p2"));
  assert.equal((await tracker.syncAll()).length, 1);
  const restarted = new LPTracker(client, store);
  assert.deepEqual(await restarted.syncAll(), []);
});

test("single-sided investment preserves zero token for aggregation", () => {
  const raw = apiPosition("p1");
  raw.inputToken1 = "0";
  const investments = positionFromApi(raw, WALLET, "ROBINHOOD").investments;
  assert.deepEqual(investments.map((item) => item.symbol), ["WETH", "musebook"]);
  assert.equal(investments[1].amount, 0);
});

test("renders rich alert with exact investment shares", () => {
  const position = {
    positionId: "p1", wallet: WALLET, chain: "ROBINHOOD", pool: "WETH / musebook", protocol: "Uniswap V4",
    currentRangeDisplay: "-60% to +20%", openingRangeDisplay: "-70%", openedAt: "2026-09-22T00:00:00.000Z",
    investments: [{ symbol: "WETH", amount: 0.0264, usdValue: 73.2, share: 97.58 }, { symbol: "musebook", amount: 11076.3, usdValue: 1.81, share: 2.42 }], raw: {},
  };
  const event = { chatId: 1, eventType: "OPENED", position };
  assert.match(renderEventHtml(event), /<table>/);
  assert.match(renderEventHtml(event), /WETH/);
  assert.match(renderEventHtml(event), /Base fee/);
  assert.match(renderEventText(event), /Range \| - \| -70%/);
});

test("shows musebook regardless of pair orientation", () => {
  const raw = apiPosition("p1", "musebook", "WETH");
  const position = positionFromApi(raw, WALLET, "ROBINHOOD");
  assert.deepEqual(position.targetToken, { ticker: "musebook", name: "musebook" });
});

test("uses token name separately from ticker", () => {
  const raw = apiPosition("p1", "HYPE", "USDG");
  raw.token0Info = { token_symbol: "HYPE", token_name: "Hyperliquid", token_decimals: 18 };
  raw.token1Info = { token_symbol: "USDG", token_name: "USDG", token_decimals: 6 };
  const position = positionFromApi(raw, WALLET, "ROBINHOOD");
  assert.deepEqual(position.targetToken, { ticker: "HYPE", name: "Hyperliquid" });
  assert.match(renderEventHtml({ eventType: "OPENED", chatId: 1, position }), /<b>HYPE<\/b> Hyperliquid/);
});

test("selects the non-quote token when the pair is reversed", () => {
  const raw = apiPosition("p1", "USDG", "TOKENA");
  const position = positionFromApi(raw, WALLET, "ROBINHOOD");
  assert.deepEqual(position.targetToken, { ticker: "TOKENA", name: "TOKENA" });
});

test("formats Uniswap V4 base fee in percent units", () => {
  const raw = apiPosition("p1");
  raw.poolInfo = { fee: 10000 };
  assert.equal(baseFeeDisplay(raw), "1%");
  raw.poolInfo.fee = 10010;
  assert.equal(baseFeeDisplay(raw), "1.001%");
});

test("lists and removes tracked wallets by stable ID, name, address, or all", async () => {
  const { tracker } = makeTracker([]);
  const secondWallet = `0x${"b".repeat(40)}`;
  await tracker.register(10, WALLET, "Alpha", "🦊");
  await tracker.register(10, secondWallet, "Beta", "🐻");
  assert.deepEqual(tracker.list(10).map((wallet) => [wallet.id, wallet.name]), [[1, "Alpha"], [2, "Beta"]]);
  assert.match(renderTrackListHtml(tracker.list(10)), /Alpha/);
  assert.equal(tracker.remove(10, "Alpha").length, 1);
  assert.equal(tracker.remove(10, secondWallet).length, 1);
  assert.equal(tracker.list(10).length, 0);
});

test("can track a wallet again after removing all wallets", async () => {
  const { tracker } = makeTracker([]);
  await tracker.register(10, WALLET, "Alpha", "🦊");
  assert.equal(tracker.remove(10, "all").length, 1);
  const result = await tracker.register(10, `0x${"c".repeat(40)}`, "Rabbit", "🐰");
  assert.equal(result.added, true);
  assert.deepEqual(tracker.list(10).map((wallet) => wallet.name), ["Rabbit"]);
});

test("keeps wallet emoji and win rate on close alerts", async () => {
  const { tracker, client } = makeTracker([apiPosition("p1")], { win_rate: { ALL: 0.625 } });
  await tracker.register(10, WALLET, "Alpha", "🦊");
  client.items = [];
  const [event] = await tracker.syncAll();
  assert.equal(event.eventType, "CLOSED");
  assert.equal(event.position.walletEmoji, "🦊");
  assert.equal(event.position.walletWinRate, 62.5);
  assert.match(renderEventHtml(event), /<th>Emoji<\/th>/);
  assert.match(renderEventHtml(event), /62\.5%/);
  assert.match(renderEventHtml(event), /0xaaa\.\.\.aaa/);
});

test("reads protocol-specific win rate from overview data arrays", async () => {
  const overview = [
    { protocol: "uniswap_v3", win_rate: { ALL: 0.625 } },
    { protocol: "uniswap_v4", win_rate: { ALL: 0.7724615717687812 } },
  ];
  const { tracker, client } = makeTracker([apiPosition("p1")], overview);
  await tracker.register(10, WALLET);
  client.items = [];
  const [event] = await tracker.syncAll();
  assert.equal(event.position.walletWinRate, 77.24615717687812);
  assert.match(renderEventHtml(event), /77\.2%/);
});

test("caches pool enrichment and renders TVL, volume, and APR", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      status: "success",
      data: [{ pool: "0xpool", tvl: 1000, vol_24h: 2000, fee_24h: 10.5 }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const raw = apiPosition("p1");
    raw.pool = "0xpool";
    const position = positionFromApi(raw, WALLET, "ROBINHOOD");
    const client = new LPAgentClient("test-key", { baseUrl: "https://api.test", poolCacheTtlMs: 10_000 });
    const first = await client.poolMetrics(position);
    const second = await client.poolMetrics(position);
    assert.equal(calls, 1);
    assert.equal(first.apr, 383.25);
    assert.deepEqual(second, first);
    const enriched = await client.enrichPoolMetrics(position);
    const html = renderEventHtml({ eventType: "OPENED", chatId: 1, position: enriched });
    assert.match(html, /TVL/);
    assert.match(html, /Volume 24h/);
    assert.match(html, /383\.3%/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("serves repeated opening logs and overviews from cache", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    const endpoint = new URL(String(url)).pathname.split("/").pop();
    requested.push(endpoint);
    const data = endpoint === "logs" ? [{ action: "open", timestamp: "2026-09-07T05:36:09.000Z" }] : { win_rate: { ALL: 0.5 } };
    return new Response(JSON.stringify({ status: "success", data }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const client = new LPAgentClient("test-key", { baseUrl: "https://api.test", positionCacheTtlMs: 10_000 });
    await client.positionLogs("p1", WALLET, "ROBINHOOD");
    await client.positionLogs("p1", WALLET, "ROBINHOOD");
    await client.walletOverview(WALLET, "ROBINHOOD");
    await client.walletOverview(WALLET, "ROBINHOOD");
    assert.deepEqual(requested, ["logs", "overview"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retries a pool lookup that returned nothing", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ status: "success", data: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    // A miss is cached only briefly: the indexer may simply not have the pool
    // yet, and pinning the null would drop TVL/APR from every later alert.
    const client = new LPAgentClient("test-key", { baseUrl: "https://api.test" });
    const position = positionFromApi({ ...apiPosition("p1"), pool: "0xmissing" }, WALLET, "ROBINHOOD");
    await client.poolMetrics(position);
    await client.poolMetrics(position);
    assert.equal(calls, 1);
    client.poolCache.clear();
    await client.poolMetrics(position);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses opening timestamp for age", () => {
  assert.equal(formatAge("2026-09-22T00:00:00Z", new Date("2026-09-22T02:00:00Z")), "2 jam");
});

test("calculates range relative to the opening pool price", () => {
  assert.equal(openingRangeDisplay({ priceRange: [30, 60, 40] }, { price0: 50 }), "-40% to 20%");
});

// Real Robinhood Chain payloads, captured from chain=ROBINHOOD.
const rhPosition = (overrides = {}) => ({
  protocol: "uniswap_v3",
  tickLower: -61080,
  tickUpper: -58560,
  tickCurrent: -59974,
  range: [-61080, -58560, -59974],
  priceRange: [0.49180187583565105, 0.6327423725067508, 0.5493141029199337],
  decimal0: 8,
  decimal1: 9,
  price0: 1.0635218893066807,
  price1: 2209.6742343383034,
  inputToken0: "1471978547858306",
  inputToken1: "5000000000000",
  current: { amount0Adjusted: 19434891.11146002, amount1Adjusted: 3808.10805329 },
  ...overrides,
});

test("measures Uniswap opening range towards the tick, not away from it", () => {
  // Opened at price 2503.99 with bounds 0.4918 / 0.6327: the upper bound is
  // +10.7% away from the opening price and the lower one -14.0%.
  assert.equal(
    openingRangeDisplay(rhPosition(), { price0: "0.9707626378872785", price1: "3749.720186193272", tickLower: -61080, tickUpper: -58560 }),
    "-14% to 10.6%",
  );
});

test("treats a Uniswap single-sided deposit as entering at its open bound", () => {
  // All-token0 means the price opened on the lower bound, so the range has room
  // above it and none below. The width is the bound-to-bound span: -14% from
  // the opening price up to +10.6%, i.e. +22.3% of head room.
  assert.equal(
    openingRangeDisplay(
      rhPosition({ inputToken0: "100", inputToken1: "0", current: { amount0Adjusted: 100, amount1Adjusted: 0 } }),
      { tickLower: -61080, tickUpper: -58560, amount0: "100", amount1: "0", price0: "0.9707626378872785", price1: "3749.720186193272" },
    ),
    "+22.3% to +0%",
  );
  // All-token1 mirrors it: deposited on the upper bound, so it only has room down.
  assert.equal(
    openingRangeDisplay(
      rhPosition({ inputToken0: "0", inputToken1: "100", current: { amount0Adjusted: 0, amount1Adjusted: 100 } }),
      { tickLower: -61080, tickUpper: -58560, amount0: "0", amount1: "100", price0: "0.9707626378872785", price1: "3749.720186193272" },
    ),
    "+0% to -22.3%",
  );
});

test("reports a dynamic Uniswap V4 fee instead of the packed flag", () => {
  assert.equal(baseFeeDisplay({ protocol: "uniswap_v4", poolInfo: { fee: 8388608 } }), "Dinamis");
  assert.equal(baseFeeDisplay({ protocol: "uniswap_v3", poolInfo: { fee: 3000 } }), "0.3%");
});

test("falls back to the current range when the opening log is unavailable", () => {
  // Without price0/price1 the tick maths cannot run, so the stored position
  // keeps the current range instead of a mirrored one.
  assert.equal(openingRangeDisplay(rhPosition(), null), "-10.5% to 15.2%");
});

test("handles LP Agent rate limits with Retry-After", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ status: "error" }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "2" },
  });
  try {
    const client = new LPAgentClient("test-key");
    await assert.rejects(
      () => client.getJson("lp-positions/opening", {}),
      (error) => error.status === 429 && error.retryAfterMs === 2_000,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
