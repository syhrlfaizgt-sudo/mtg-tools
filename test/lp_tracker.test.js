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
  constructor(items = []) { this.items = items; }
  async openingPositions(address, chain) { return this.items.map((item) => positionFromApi(item, address, chain)); }
  async enrichPosition(position) { return position; }
}

function makeTracker(items) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lp-tracker-"));
  const store = new SnapshotStore(path.join(directory, "tracker.json"));
  const client = new FakeClient(items);
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

test("missing position emits one CLOSED event", async () => {
  const { tracker, client } = makeTracker([apiPosition("p1")]);
  await tracker.register(10, WALLET);
  client.items = [];
  assert.deepEqual((await tracker.syncAll()).map((event) => [event.eventType, event.position.positionId]), [["CLOSED", "p1"]]);
  assert.deepEqual(await tracker.syncAll(), []);
});

test("restart preserves deduplication", async () => {
  const { tracker, client, store } = makeTracker([apiPosition("p1")]);
  await tracker.register(10, WALLET);
  client.items.push(apiPosition("p2"));
  assert.equal((await tracker.syncAll()).length, 1);
  const restarted = new LPTracker(client, store);
  assert.deepEqual(await restarted.syncAll(), []);
});

test("single-sided investment omits zero token", () => {
  const raw = apiPosition("p1");
  raw.inputToken1 = "0";
  assert.deepEqual(positionFromApi(raw, WALLET, "ROBINHOOD").investments.map((item) => item.symbol), ["WETH"]);
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

test("uses opening timestamp for age", () => {
  assert.equal(formatAge("2026-09-22T00:00:00Z", new Date("2026-09-22T02:00:00Z")), "2 jam");
});

test("calculates range relative to the opening pool price", () => {
  assert.equal(openingRangeDisplay({ priceRange: [30, 60, 40] }, { price0: 50 }), "-40% to 20%");
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
