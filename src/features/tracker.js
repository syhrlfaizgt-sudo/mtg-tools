import fs from "node:fs";
import path from "node:path";

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PROTOCOL_NAMES = {
  uniswap_v3: "Uniswap V3",
  uniswap_v4: "Uniswap V4",
  meteora: "Meteora",
  meteora_damm_v2: "Meteora DAMM V2",
};

export class TrackerError extends Error {}
export class ApiError extends TrackerError {
  constructor(message, { status = null, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function detectChain(address) {
  if (EVM_ADDRESS.test(address)) return "ROBINHOOD";
  if (SOLANA_ADDRESS.test(address)) return "SOL";
  throw new TrackerError("Address tidak valid. Gunakan alamat EVM 0x... atau alamat Solana.");
}

export function normalizeAddress(address, chain = undefined) {
  const value = String(address ?? "").trim();
  let detected = detectChain(value);
  if (chain !== undefined) {
    detected = String(chain).trim().toUpperCase();
    if (!["SOL", "ROBINHOOD"].includes(detected)) {
      throw new TrackerError("Chain harus SOL atau ROBINHOOD.");
    }
    if (detected === "ROBINHOOD" && !EVM_ADDRESS.test(value)) {
      throw new TrackerError("Chain ROBINHOOD membutuhkan alamat EVM 0x....");
    }
    if (detected === "SOL" && !SOLANA_ADDRESS.test(value)) {
      throw new TrackerError("Chain SOL membutuhkan alamat Solana.");
    }
  }
  return [detected === "ROBINHOOD" ? value.toLowerCase() : value, detected];
}

export function parseAllowedUserIds(value) {
  const ids = String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!ids.length || ids.some((id) => !/^\d+$/.test(id))) {
    throw new TrackerError("ALLOWED_USER_ID wajib berisi Telegram user ID numerik.");
  }
  return new Set(ids);
}

export function isAllowedUser(userId, allowedUserIds) {
  return userId !== undefined && userId !== null && allowedUserIds.has(String(userId));
}

function number(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNumber(object, keys) {
  for (const key of keys) {
    const value = number(object?.[key]);
    if (value !== null) return value;
  }
  return null;
}

export function parseTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return new Date(value < 1e12 ? value * 1000 : value);
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function nowIso() {
  return new Date().toISOString();
}

export function formatAge(openedAt, now = new Date()) {
  const opened = parseTimestamp(openedAt);
  if (!opened) return "-";
  const seconds = Math.max(0, Math.floor((now.getTime() - opened.getTime()) / 1000));
  if (seconds < 60) return `${seconds} detik`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} menit`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam`;
  return `${Math.floor(hours / 24)} hari`;
}

export function formatAmount(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${(absolute / 1_000_000).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}M`;
  if (absolute >= 1_000) return `${(absolute / 1_000).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}k`;
  if (absolute === 0) return "0";
  return absolute.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

export function formatUsd(value) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "-"
    : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${Number(value.toFixed(1)).toString()}%`;
}

export function formatShare(value) {
  return value === null || value === undefined || !Number.isFinite(value) ? "-" : `${value.toFixed(2)}%`;
}

function tokenInfo(raw, index) {
  const info = raw[`token${index}Info`] && typeof raw[`token${index}Info`] === "object" ? raw[`token${index}Info`] : {};
  const symbol = String(raw[`tokenName${index}`] || info.token_symbol || info.symbol || raw[`token${index}`] || `token${index}`);
  const decimals = Math.max(0, Math.trunc(number(raw[`decimal${index}`]) ?? number(info.token_decimals) ?? 18));
  return { symbol, decimals };
}

function adjustedInputAmount(raw, index, decimals) {
  const input = number(raw[`inputToken${index}`]);
  if (input !== null) return input / 10 ** decimals;
  const current = raw.current && typeof raw.current === "object" ? raw.current : {};
  const adjusted = number(current[`amount${index}Adjusted`]);
  if (adjusted !== null) return adjusted;
  const rawAmount = number(current[`amount${index}`]);
  return rawAmount === null ? null : rawAmount / 10 ** decimals;
}

function tokenUsdValue(raw, index, amount) {
  if (amount === null) return null;
  const direct = firstNumber(raw, [`inputValueUsd${index}`, `inputToken${index}Usd`, `token${index}ValueUsd`, `valueUsd${index}`]);
  if (direct !== null) return Math.abs(direct);
  const info = raw[`token${index}Info`];
  const infoValue = info && typeof info === "object" ? firstNumber(info, ["valueUsd", "usdValue", "value_usd"]) : null;
  if (infoValue !== null) return Math.abs(infoValue);
  const price = firstNumber(raw, [`price${index}Usd`, `usdPrice${index}`, `price${index}`]);
  return price === null ? null : Math.abs(amount * price);
}

function rangeFromPercentList(value) {
  if (!Array.isArray(value)) return null;
  const values = value.map(number).filter((item) => item !== null);
  if (values.length === 1) return formatPercent(values[0]);
  if (values.length >= 2) return `${formatPercent(values[0])} to ${formatPercent(values[1])}`;
  return null;
}

export function rangeFromPrices(priceRange, referencePrice) {
  if (!Array.isArray(priceRange) || priceRange.length < 2) return null;
  const lower = number(priceRange[0]);
  const upper = number(priceRange[1]);
  const current = number(referencePrice ?? priceRange[2]);
  if (current === null || current === 0) return null;
  const lowerPct = lower !== null && lower > 0 ? ((lower / current) - 1) * 100 : null;
  const upperPct = upper !== null && upper > 0 ? ((upper / current) - 1) * 100 : null;
  if (lowerPct !== null && upperPct !== null) return `${formatPercent(lowerPct)} to ${formatPercent(upperPct)}`;
  if (lowerPct !== null) return formatPercent(lowerPct);
  if (upperPct !== null) return formatPercent(upperPct);
  return null;
}

export function currentRangeDisplay(raw) {
  for (const key of ["rangePercent", "range_percent", "rangePercentage"]) {
    const display = rangeFromPercentList(raw[key]);
    if (display) return display;
  }
  return rangeFromPrices(raw.priceRange, undefined) || (raw.rangeDisplay ? String(raw.rangeDisplay) : "-");
}

export function openingRangeDisplay(raw, openingLog) {
  const openingPrice = number(openingLog?.price0);
  return rangeFromPrices(raw?.priceRange, openingPrice);
}

function investmentRows(raw) {
  const first = tokenInfo(raw, 0);
  const second = tokenInfo(raw, 1);
  const candidates = [
    { info: first, amount: adjustedInputAmount(raw, 0, first.decimals), usdValue: null },
    { info: second, amount: adjustedInputAmount(raw, 1, second.decimals), usdValue: null },
  ];
  for (const item of candidates) item.usdValue = tokenUsdValue(raw, candidates.indexOf(item), item.amount);
  const totalUsd = candidates.reduce((sum, item) => sum + (item.usdValue ?? 0), 0);
  return candidates
    .filter((item) => item.amount !== null && Math.abs(item.amount) >= 1e-15)
    .map((item) => ({
      symbol: item.info.symbol,
      amount: item.amount,
      usdValue: item.usdValue,
      share: item.usdValue !== null && totalUsd > 0 ? (item.usdValue / totalUsd) * 100 : null,
    }));
}

export function positionFromApi(raw, wallet, chain) {
  if (!raw || typeof raw !== "object") throw new TrackerError("Format posisi dari LP Agent tidak valid.");
  const positionId = String(raw.id ?? raw.position ?? `${raw.pool ?? "unknown-pool"}:${raw.tokenId ?? "unknown-token"}`);
  const first = tokenInfo(raw, 0);
  const second = tokenInfo(raw, 1);
  const pairName = raw.pairName && String(raw.pairName).includes("/") ? String(raw.pairName) : `${first.symbol} / ${second.symbol}`;
  const protocolKey = String(raw.protocol ?? "").toLowerCase();
  const createdAt = parseTimestamp(raw.createdAt);
  return {
    positionId,
    wallet,
    chain,
    pool: pairName,
    protocol: PROTOCOL_NAMES[protocolKey] || String(raw.protocol || "Unknown"),
    currentRangeDisplay: currentRangeDisplay(raw),
    openingRangeDisplay: null,
    rangeSource: "current",
    openedAt: createdAt ? createdAt.toISOString() : nowIso(),
    investments: investmentRows(raw),
    raw,
  };
}

function needsInvestmentDetail(position) {
  return !Object.hasOwn(position.raw, "inputToken0") || !Object.hasOwn(position.raw, "inputToken1");
}

function earliestAddLiquidity(logs) {
  return (Array.isArray(logs) ? logs : [])
    .filter((log) => String(log?.action ?? "").toLowerCase() === "add_liquidity")
    .sort((a, b) => (parseTimestamp(a.timestamp)?.getTime() ?? Infinity) - (parseTimestamp(b.timestamp)?.getTime() ?? Infinity))[0] ?? null;
}

export class SnapshotStore {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    this.state = this.load();
  }

  load() {
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return { trackedWallets: value.trackedWallets || {}, positions: value.positions || {} };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { trackedWallets: {}, positions: {} };
    }
  }

  persist() {
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2));
    fs.renameSync(temporary, this.filePath);
  }

  walletKey(chatId, address, chain) {
    return `${chatId}|${address}|${chain}`;
  }

  positionKey(wallet, positionId) {
    return `${this.walletKey(wallet.chatId, wallet.address, wallet.chain)}|${positionId}`;
  }

  addWallet(chatId, address, chain) {
    const key = this.walletKey(chatId, address, chain);
    if (this.state.trackedWallets[key]) return false;
    this.state.trackedWallets[key] = { chatId, address, chain, initialized: false, createdAt: nowIso() };
    this.persist();
    return true;
  }

  wallets() {
    return Object.values(this.state.trackedWallets).map(({ chatId, address, chain }) => ({ chatId, address, chain }));
  }

  isInitialized(wallet) {
    return Boolean(this.state.trackedWallets[this.walletKey(wallet.chatId, wallet.address, wallet.chain)]?.initialized);
  }

  markInitialized(wallet) {
    const item = this.state.trackedWallets[this.walletKey(wallet.chatId, wallet.address, wallet.chain)];
    if (item) item.initialized = true;
    this.persist();
  }

  positions(wallet) {
    const prefix = `${this.walletKey(wallet.chatId, wallet.address, wallet.chain)}|`;
    const result = {};
    for (const [key, value] of Object.entries(this.state.positions)) {
      if (key.startsWith(prefix)) result[value.position.positionId] = value;
    }
    return result;
  }

  savePosition(wallet, position) {
    this.state.positions[this.positionKey(wallet, position.positionId)] = {
      position,
      active: true,
      lastSeenAt: nowIso(),
      closedAt: null,
    };
    this.persist();
  }

  markClosed(wallet, positionId) {
    const value = this.state.positions[this.positionKey(wallet, positionId)];
    if (!value) return;
    value.active = false;
    value.closedAt = nowIso();
    value.lastSeenAt = value.closedAt;
    this.persist();
  }
}

export class LPAgentClient {
  constructor(apiKey, { baseUrl = "https://api.lpagent.io/open-api/v1", timeoutMs = 30_000 } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
    this.rateLimitUntil = 0;
  }

  async getJson(endpoint, params) {
    const waitMs = Math.max(0, this.rateLimitUntil - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    const url = new URL(`${this.baseUrl}/${endpoint}`);
    for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { headers: { "x-api-key": this.apiKey, Accept: "application/json" }, signal: controller.signal });
      const payload = await response.json();
      if (response.status === 429) {
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterSeconds = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
        const retryAfterMs = Number.isFinite(retryAfterSeconds)
          ? Math.max(1_000, retryAfterSeconds * 1_000)
          : 60_000;
        this.rateLimitUntil = Date.now() + retryAfterMs;
        throw new ApiError(`LP Agent HTTP 429; retry dalam ${Math.ceil(retryAfterMs / 1_000)} detik`, { status: 429, retryAfterMs });
      }
      if (!response.ok || payload?.status !== "success") {
        throw new ApiError(payload?.message || `LP Agent HTTP ${response.status}`, { status: response.status });
      }
      return payload;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(`Gagal mengambil data LP Agent: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async openingPositions(address, chain) {
    const payload = await this.getJson("lp-positions/opening", { owner: address, chain });
    return (Array.isArray(payload.data) ? payload.data : []).map((item) => positionFromApi(item, address, chain));
  }

  async positionDetail(positionId, wallet, chain) {
    const payload = await this.getJson("lp-positions/position", { position: positionId, chain });
    if (!payload.data || typeof payload.data !== "object") throw new ApiError("Detail posisi LP Agent tidak valid.");
    return positionFromApi(payload.data, wallet, chain);
  }

  async positionLogs(positionId, wallet, chain) {
    const payload = await this.getJson("lp-positions/logs", { position: positionId, owner: wallet, chain });
    return Array.isArray(payload.data) ? payload.data : [];
  }

  async enrichPosition(position) {
    let enriched = position;
    if (needsInvestmentDetail(enriched)) {
      try {
        enriched = await this.positionDetail(position.positionId, position.wallet, position.chain);
      } catch (error) {
        // Opening data is still useful when detail access is unavailable.
        if (error.status === 429) return enriched;
      }
    }
    try {
      const openingLog = earliestAddLiquidity(await this.positionLogs(enriched.positionId, enriched.wallet, enriched.chain));
      const openingAt = parseTimestamp(openingLog?.timestamp);
      const openingRange = openingRangeDisplay(enriched.raw, openingLog);
      if (openingLog || openingRange) {
        enriched = {
          ...enriched,
          openedAt: openingAt ? openingAt.toISOString() : enriched.openedAt,
          openingRangeDisplay: openingRange,
          rangeSource: openingRange ? "add_liquidity" : "current",
        };
      }
    } catch (error) {
      // The historical range is optional; do not block open/close detection.
      if (error.status === 429) return enriched;
    }
    return enriched;
  }
}

export class LPTracker {
  constructor(client, store, logger = () => {}) {
    this.client = client;
    this.store = store;
    this.logger = logger;
    this.syncing = false;
  }

  async register(chatId, address, chain = undefined) {
    const [normalizedAddress, normalizedChain] = normalizeAddress(address, chain);
    const wallet = { chatId: Number(chatId), address: normalizedAddress, chain: normalizedChain };
    const added = this.store.addWallet(wallet.chatId, wallet.address, wallet.chain);
    if (added) {
      try {
        await this.syncWallet(wallet, null, false);
      } catch (error) {
        return { wallet, added, warning: error.message };
      }
    }
    return { wallet, added, warning: null };
  }

  async syncAll() {
    if (this.syncing) return [];
    this.syncing = true;
    try {
      const grouped = new Map();
      for (const wallet of this.store.wallets()) {
        const key = `${wallet.address}|${wallet.chain}`;
        if (!grouped.has(key)) grouped.set(key, { address: wallet.address, chain: wallet.chain, wallets: [] });
        grouped.get(key).wallets.push(wallet);
      }
      const events = [];
      for (const group of grouped.values()) {
        let current;
        try {
          current = await this.client.openingPositions(group.address, group.chain);
        } catch (error) {
          const prefix = error.status === 429 ? "LP Agent rate limit" : "Sync gagal";
          this.logger(`${prefix} ${group.address} ${group.chain}: ${error.message}`);
          continue;
        }
        for (const wallet of group.wallets) events.push(...await this.syncWallet(wallet, current, true));
      }
      return events;
    } finally {
      this.syncing = false;
    }
  }

  async syncWallet(wallet, current = null, emitEvents = true) {
    const positions = current || await this.client.openingPositions(wallet.address, wallet.chain);
    const currentById = new Map(positions.map((position) => [position.positionId, position]));
    const existing = this.store.positions(wallet);
    if (!this.store.isInitialized(wallet)) {
      for (const position of currentById.values()) this.store.savePosition(wallet, await this.client.enrichPosition(position));
      this.store.markInitialized(wallet);
      return [];
    }

    const events = [];
    for (const [positionId, saved] of Object.entries(existing)) {
      if (saved.active && !currentById.has(positionId)) {
        this.store.markClosed(wallet, positionId);
        events.push({ chatId: wallet.chatId, eventType: "CLOSED", position: saved.position });
      }
    }
    for (const [positionId, position] of currentById.entries()) {
      const previous = existing[positionId];
      if (!previous || !previous.active) {
        const enriched = await this.client.enrichPosition(position);
        this.store.savePosition(wallet, enriched);
        events.push({ chatId: wallet.chatId, eventType: "OPENED", position: enriched });
      }
    }
    return emitEvents ? events : [];
  }
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function eventTitle(eventType) {
  return eventType === "OPENED" ? "🟢 LP POSITION OPENED" : "🔴 LP POSITION CLOSED";
}

export function eventRange(position) {
  return position.openingRangeDisplay || position.currentRangeDisplay || "-";
}

export function renderEventText(event, now = new Date()) {
  const { position } = event;
  const chain = position.chain === "ROBINHOOD" ? "Robinhood" : "SOL";
  const lines = [
    eventTitle(event.eventType),
    "",
    `Wallet: ${position.wallet}`,
    `Chain: ${chain}`,
    `Pool: ${position.pool}`,
    `Protocol: ${position.protocol}`,
    `Range: ${eventRange(position)}`,
    "",
    "Invested",
    ...position.investments.map((item) => `${item.symbol}: ${formatAmount(item.amount)} | ${formatUsd(item.usdValue)} | ${formatShare(item.share)}`),
    "",
    `Age: ${formatAge(position.openedAt, now)}`,
  ];
  return lines.join("\n");
}

export function renderEventHtml(event, now = new Date()) {
  const { position } = event;
  const chain = position.chain === "ROBINHOOD" ? "Robinhood" : "SOL";
  const rows = position.investments.length
    ? position.investments.map((item) => `<tr><td>${escapeHtml(item.symbol)}</td><td>${escapeHtml(formatAmount(item.amount))}</td><td>${escapeHtml(formatUsd(item.usdValue))}</td><td>${escapeHtml(formatShare(item.share))}</td></tr>`).join("")
    : "<tr><td colspan='4'>-</td></tr>";
  return [
    `<h2>${escapeHtml(eventTitle(event.eventType))}</h2>`,
    `<p><b>Wallet</b><br><code>${escapeHtml(position.wallet)}</code></p>`,
    `<p><b>Chain</b><br>${escapeHtml(chain)}</p>`,
    `<p><b>Pool</b><br>${escapeHtml(position.pool)}</p>`,
    `<p><b>Protocol</b><br>${escapeHtml(position.protocol)}</p>`,
    `<p><b>Range at open</b><br>${escapeHtml(eventRange(position))}</p>`,
    "<h3>Invested</h3>",
    `<table><tr><th>Token</th><th>Amount</th><th>Value</th><th>Share</th></tr>${rows}</table>`,
    `<p><b>Age</b><br>${escapeHtml(formatAge(position.openedAt, now))}</p>`,
  ].join("");
}

export class TelegramClient {
  constructor(botToken, { timeoutMs = 45_000 } = {}) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
    this.timeoutMs = timeoutMs;
  }

  async call(method, payload, timeoutMs = this.timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new TrackerError(result.description || `Telegram HTTP ${response.status}`);
      return result.result;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getUpdates(offset, timeout = 30) {
    const payload = { timeout, allowed_updates: ["message"] };
    if (offset !== null) payload.offset = offset;
    const result = await this.call("getUpdates", payload, (timeout + 10) * 1000);
    return Array.isArray(result) ? result : [];
  }

  async sendText(chatId, text) {
    await this.call("sendMessage", { chat_id: chatId, text });
  }

  async sendRichEvent(event) {
    try {
      await this.call("sendRichMessage", { chat_id: event.chatId, rich_message: { html: renderEventHtml(event) } });
    } catch {
      await this.sendText(event.chatId, renderEventText(event));
    }
  }
}

function loadDotEnv(filePath = ".env") {
  try {
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function runBot() {
  loadDotEnv();
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const apiKey = process.env.LPAGENT_API_KEY?.trim();
  if (!botToken || !apiKey) throw new Error("Set TELEGRAM_BOT_TOKEN dan LPAGENT_API_KEY terlebih dahulu.");
  const allowedUserIds = parseAllowedUserIds(process.env.ALLOWED_USER_ID);
  const databasePath = process.env.DATABASE_PATH || "data/tracker.json";
  const interval = Math.max(10, Number(process.env.POLL_INTERVAL_SECONDS || 60) * 1000);
  const store = new SnapshotStore(databasePath);
  const telegram = new TelegramClient(botToken);
  const tracker = new LPTracker(new LPAgentClient(apiKey), store, (message) => console.error(message));
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  (async () => {
    while (!stopping) {
      try {
        for (const event of await tracker.syncAll()) await telegram.sendRichEvent(event);
      } catch (error) {
        console.error(`Polling gagal: ${error.message}`);
      }
      await sleep(interval);
    }
  })();

  let offset = null;
  while (!stopping) {
    try {
      for (const update of await telegram.getUpdates(offset)) {
        offset = Number(update.update_id) + 1;
        const message = update.message || {};
        const text = String(message.text || "").trim();
        const chatId = message.chat?.id;
        if (chatId === undefined || !isAllowedUser(message.from?.id, allowedUserIds)) continue;
        if (text.startsWith("/start")) {
          await telegram.sendText(chatId, "Kirim /track <wallet> untuk mulai memantau posisi LP.");
          continue;
        }
        if (!text.startsWith("/track")) continue;
        const args = text.split(/\s+/);
        if (![2, 3].includes(args.length)) {
          await telegram.sendText(chatId, "Format: /track <wallet> [SOL|ROBINHOOD]");
          continue;
        }
        try {
          const result = await tracker.register(chatId, args[1], args[2]);
          if (result.warning) await telegram.sendText(chatId, `Tracking tersimpan, tetapi baseline belum bisa diambil: ${result.warning}`);
          else if (result.added) await telegram.sendText(chatId, `Tracking aktif untuk ${result.wallet.address} (${result.wallet.chain}). Posisi saat ini dijadikan baseline.`);
          else await telegram.sendText(chatId, "Wallet tersebut sudah sedang di-track.");
        } catch (error) {
          await telegram.sendText(chatId, `Tidak bisa track wallet: ${error.message}`);
        }
      }
    } catch (error) {
      if (!stopping && error.name !== "AbortError") {
        console.error(`Telegram polling gagal: ${error.message}`);
      }
      if (!stopping) await sleep(5_000);
    }
  }
}
