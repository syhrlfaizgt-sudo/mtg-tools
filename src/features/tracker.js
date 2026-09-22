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
  const symbol = String(info.token_symbol || info.symbol || raw[`tokenSymbol${index}`] || raw[`tokenName${index}`] || raw[`token${index}`] || `token${index}`);
  const name = String(info.token_name || info.name || raw[`tokenFullName${index}`] || raw[`token_name${index}`] || raw[`name${index}`] || symbol);
  const decimals = Math.max(0, Math.trunc(number(raw[`decimal${index}`]) ?? number(info.token_decimals) ?? 18));
  return { symbol, name, decimals };
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

function rangePartsFromPercentList(value) {
  if (!Array.isArray(value)) return null;
  const values = value.map(number).filter((item) => item !== null);
  if (!values.length) return null;
  const positive = values.filter((item) => item >= 0).sort((a, b) => b - a)[0];
  const negative = values.filter((item) => item < 0).sort((a, b) => a - b)[0];
  return { plus: positive === undefined ? "-" : formatSignedPercent(positive), minus: negative === undefined ? "-" : formatSignedPercent(negative) };
}

function formatSignedPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  const rounded = Number(value.toFixed(1));
  return `${rounded >= 0 ? "+" : ""}${rounded}%`;
}

function rangePartsFromPrices(priceRange, referencePrice) {
  if (!Array.isArray(priceRange) || priceRange.length < 2) return null;
  const lower = number(priceRange[0]);
  const upper = number(priceRange[1]);
  const current = number(referencePrice ?? priceRange[2]);
  if (current === null || current === 0) return null;
  const lowerPct = lower !== null && lower > 0 ? ((lower / current) - 1) * 100 : null;
  const upperPct = upper !== null && upper > 0 ? ((upper / current) - 1) * 100 : null;
  const values = [lowerPct, upperPct].filter((item) => item !== null);
  if (!values.length) return null;
  const positive = values.filter((item) => item >= 0).sort((a, b) => b - a)[0];
  const negative = values.filter((item) => item < 0).sort((a, b) => a - b)[0];
  return {
    display: values.length === 1 ? formatPercent(values[0]) : `${formatPercent(lowerPct)} to ${formatPercent(upperPct)}`,
    plus: positive === undefined ? "-" : formatSignedPercent(positive),
    minus: negative === undefined ? "-" : formatSignedPercent(negative),
  };
}

function openingTickBounds(raw, openingLog) {
  const source = Array.isArray(raw?.range) ? raw.range : [];
  const lower = number(openingLog?.tickLower ?? raw?.tickLower ?? source[0]);
  const upper = number(openingLog?.tickUpper ?? raw?.tickUpper ?? source[1]);
  if (lower === null || upper === null) return null;
  return { lower, upper };
}

function openingAmount(raw, openingLog, index) {
  const logAmount = number(openingLog?.[`amount${index}`]);
  if (logAmount !== null) return logAmount;
  return number(raw?.[`inputToken${index}`]);
}

function openingRangeFromTicks(raw, openingLog) {
  const bounds = openingTickBounds(raw, openingLog);
  if (!bounds) return null;
  const amount0 = openingAmount(raw, openingLog, 0);
  const amount1 = openingAmount(raw, openingLog, 1);
  const hasOnlyOneSide = (amount0 !== null && amount1 !== null)
    && ((Math.abs(amount0) > 0 && Math.abs(amount1) === 0) || (Math.abs(amount0) === 0 && Math.abs(amount1) > 0));
  if (hasOnlyOneSide) {
    const width = (Math.pow(1.0001, bounds.lower - bounds.upper) - 1) * 100;
    return { display: `+0% to ${formatSignedPercent(width)}`, plus: "+0%", minus: formatSignedPercent(width) };
  }
  const price0 = number(openingLog?.price0);
  const price1 = number(openingLog?.price1);
  const decimals0 = number(openingLog?.decimal0) ?? number(raw?.decimal0) ?? 18;
  const decimals1 = number(openingLog?.decimal1) ?? number(raw?.decimal1) ?? 18;
  if (price0 === null || price1 === null || price0 <= 0 || price1 <= 0) return null;
  const openingTick = Math.log((price0 / price1) * 10 ** (decimals1 - decimals0)) / Math.log(1.0001);
  const lowerPct = (Math.pow(1.0001, openingTick - bounds.lower) - 1) * 100;
  const upperPct = (Math.pow(1.0001, openingTick - bounds.upper) - 1) * 100;
  const values = [lowerPct, upperPct];
  const positive = values.filter((item) => item >= 0).sort((a, b) => b - a)[0];
  const negative = values.filter((item) => item < 0).sort((a, b) => a - b)[0];
  return {
    display: `${formatPercent(lowerPct)} to ${formatPercent(upperPct)}`,
    plus: positive === undefined ? "-" : formatSignedPercent(positive),
    minus: negative === undefined ? "-" : formatSignedPercent(negative),
  };
}

export function rangeFromPrices(priceRange, referencePrice) {
  return rangePartsFromPrices(priceRange, referencePrice)?.display || null;
}

export function currentRangeDisplay(raw) {
  for (const key of ["rangePercent", "range_percent", "rangePercentage"]) {
    const display = rangeFromPercentList(raw[key]);
    if (display) return display;
  }
  return rangeFromPrices(raw.priceRange, undefined) || (raw.rangeDisplay ? String(raw.rangeDisplay) : "-");
}

function currentRangeParts(raw) {
  for (const key of ["rangePercent", "range_percent", "rangePercentage"]) {
    const parts = rangePartsFromPercentList(raw[key]);
    if (parts) return parts;
  }
  return rangePartsFromPrices(raw.priceRange, undefined) || { plus: "-", minus: "-" };
}

export function openingRangeDisplay(raw, openingLog) {
  const tickRange = openingRangeFromTicks(raw, openingLog);
  if (tickRange) return tickRange.display;
  const openingPrice = number(openingLog?.price0);
  return rangeFromPrices(raw?.priceRange, openingPrice);
}

function openingRangeParts(raw, openingLog) {
  const tickRange = openingRangeFromTicks(raw, openingLog);
  if (tickRange) return tickRange;
  return rangePartsFromPrices(raw?.priceRange, number(openingLog?.price0));
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
    .filter((item) => item.amount !== null)
    .map((item) => ({
      symbol: item.info.symbol,
      amount: item.amount,
      usdValue: item.usdValue,
      share: item.usdValue !== null && totalUsd > 0 ? (item.usdValue / totalUsd) * 100 : null,
    }));
}

function tokenMatchesTarget(token) {
  return [token?.symbol, token?.name].some((value) => String(value || "").toLowerCase() === "musebook");
}

const QUOTE_TOKEN_SYMBOLS = new Set(["eth", "weth", "usdg", "usdc", "usdt", "sol"]);

function tokenLooksLikeQuote(token) {
  return [token?.symbol, token?.name].some((value) => QUOTE_TOKEN_SYMBOLS.has(String(value || "").toLowerCase()));
}

function targetToken(raw, first, second) {
  const selected = tokenMatchesTarget(first)
    ? first
    : tokenMatchesTarget(second)
      ? second
      : tokenLooksLikeQuote(first) && !tokenLooksLikeQuote(second)
        ? second
        : tokenLooksLikeQuote(second) && !tokenLooksLikeQuote(first)
          ? first
          : first;
  return { ticker: selected.symbol, name: selected.name };
}

function winRateFromValue(value) {
  const parsed = number(value) ?? (value && typeof value === "object" ? firstNumber(value, ["ALL", "all", "allTime", "ALL_TIME"]) : null);
  return parsed === null ? null : parsed <= 1 ? parsed * 100 : parsed;
}

function extractWinRate(value) {
  if (!value || typeof value !== "object") return null;
  for (const key of ["winRate", "win_rate", "winrate", "winningRate", "winning_rate", "winRatePercentage", "win_rate_percentage"]) {
    if (value[key] !== undefined) {
      const direct = winRateFromValue(value[key]);
      if (direct !== null) return direct;
    }
  }
  for (const child of [value.data, value.overview, value.stats, value.walletStats, value.performance]) {
    const nested = extractWinRate(child);
    if (nested !== null) return nested;
  }
  return null;
}

function feePercentFromRaw(raw) {
  const feeInfo = raw?.feeInfo && typeof raw.feeInfo === "object" ? raw.feeInfo : {};
  const direct = firstNumber(feeInfo, ["baseFeeRatePercentage", "base_fee_rate_percentage", "baseFeePercentage"]);
  if (direct !== null) return direct;
  const protocol = String(raw?.protocol || "").toLowerCase();
  const poolInfo = raw?.poolInfo && typeof raw.poolInfo === "object" ? raw.poolInfo : {};
  const rawFee = firstNumber(poolInfo, ["baseFeeRatePercentage", "base_fee_rate_percentage", "baseFeePercentage"]);
  if (rawFee !== null) return rawFee;
  const fee = firstNumber(poolInfo, ["fee", "feeRate", "fee_rate"]);
  if (fee === null) return null;
  if (protocol === "uniswap_v3" || protocol === "uniswap_v4") return fee / 10_000;
  return fee <= 1 ? fee * 100 : fee;
}

function formatFeePercent(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${Number(value.toFixed(3)).toString()}%`;
}

export function baseFeeDisplay(raw) {
  return formatFeePercent(feePercentFromRaw(raw));
}

function positionPoolId(position) {
  const raw = position?.raw || {};
  return String(raw.poolId || raw.pool_id || raw.pool || raw.poolAddress || "").trim();
}

function protocolKeyFromPosition(position) {
  const protocol = String(position?.raw?.protocol || "").toLowerCase();
  return Object.hasOwn(PROTOCOL_NAMES, protocol) ? protocol : undefined;
}

function poolFeeFraction(pool) {
  const fee = firstNumber(pool, ["fee", "base_fee", "baseFee"]);
  if (fee === null) return null;
  if (fee <= 1) return fee;
  return fee / 1_000_000;
}

function poolMetricsFromApi(pool) {
  if (!pool || typeof pool !== "object") return null;
  const tvl = firstNumber(pool, ["tvl", "liquidity", "tvl_usd"]);
  const volume24h = firstNumber(pool, ["vol_24h", "volume_24h", "volume24h"]);
  const fee24h = firstNumber(pool, ["fee_24h", "fees_24h", "fee24h"]);
  const ratio = firstNumber(pool, ["fee_tvl_ratio", "feeTvlRatio"]);
  let apr = null;
  let aprEstimated = false;
  if (fee24h !== null && tvl !== null && tvl > 0) {
    apr = (fee24h / tvl) * 365 * 100;
  } else if (ratio !== null) {
    apr = ratio * 365 * 100;
  } else {
    const feeFraction = poolFeeFraction(pool);
    if (feeFraction !== null && volume24h !== null && tvl !== null && tvl > 0) {
      apr = ((volume24h * feeFraction) / tvl) * 365 * 100;
      aprEstimated = true;
    }
  }
  return {
    tvl,
    volume24h,
    apr,
    aprEstimated,
    updatedAt: nowIso(),
  };
}

export function positionFromApi(raw, wallet, chain) {
  if (!raw || typeof raw !== "object") throw new TrackerError("Format posisi dari LP Agent tidak valid.");
  const positionId = String(raw.id ?? raw.position ?? `${raw.pool ?? "unknown-pool"}:${raw.tokenId ?? "unknown-token"}`);
  const first = tokenInfo(raw, 0);
  const second = tokenInfo(raw, 1);
  const pairName = raw.pairName && String(raw.pairName).includes("/") ? String(raw.pairName) : `${first.symbol} / ${second.symbol}`;
  const protocolKey = String(raw.protocol ?? "").toLowerCase();
  const createdAt = parseTimestamp(raw.createdAt);
  const rangeParts = currentRangeParts(raw);
  return {
    positionId,
    wallet,
    chain,
    pool: pairName,
    protocol: PROTOCOL_NAMES[protocolKey] || String(raw.protocol || "Unknown"),
    targetToken: targetToken(raw, first, second),
    baseFee: baseFeeDisplay(raw),
    currentRangeDisplay: currentRangeDisplay(raw),
    currentRangePlus: rangeParts.plus,
    currentRangeMinus: rangeParts.minus,
    openingRangeDisplay: null,
    openingRangePlus: null,
    openingRangeMinus: null,
    rangeSource: "current",
    openedAt: createdAt ? createdAt.toISOString() : nowIso(),
    walletWinRate: extractWinRate(raw),
    poolMetrics: null,
    investments: investmentRows(raw),
    raw,
  };
}

function needsInvestmentDetail(position) {
  return !Object.hasOwn(position.raw, "inputToken0") || !Object.hasOwn(position.raw, "inputToken1");
}

function needsTokenMetadata(position) {
  return [0, 1].some((index) => {
    const info = position.raw?.[`token${index}Info`];
    return !info?.token_name && !info?.name && !position.raw?.[`tokenFullName${index}`] && !position.raw?.[`token_name${index}`] && !position.raw?.[`name${index}`];
  });
}

function earliestAddLiquidity(logs) {
  return (Array.isArray(logs) ? logs : [])
    .filter((log) => ["add_liquidity", "increase", "open"].includes(String(log?.action ?? "").toLowerCase()))
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
      const state = {
        trackedWallets: value.trackedWallets || {},
        positions: value.positions || {},
        nextWalletId: value.nextWalletId || {},
      };
      const highestByChat = {};
      for (const wallet of Object.values(state.trackedWallets)) {
        const chatId = String(wallet.chatId);
        const existingId = Number(wallet.id);
        if (Number.isInteger(existingId) && existingId > 0) highestByChat[chatId] = Math.max(highestByChat[chatId] || 0, existingId);
      }
      for (const wallet of Object.values(state.trackedWallets)) {
        const chatId = String(wallet.chatId);
        if (!Number.isInteger(Number(wallet.id)) || Number(wallet.id) < 1) {
          highestByChat[chatId] = (highestByChat[chatId] || 0) + 1;
          wallet.id = highestByChat[chatId];
        }
        state.nextWalletId[chatId] = Math.max(Number(state.nextWalletId[chatId]) || 0, Number(wallet.id));
      }
      return state;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { trackedWallets: {}, positions: {}, nextWalletId: {} };
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

  addWallet(chatId, address, chain, name = "Wallet", emoji = "👝") {
    const key = this.walletKey(chatId, address, chain);
    const existing = this.state.trackedWallets[key];
    if (existing) {
      const changed = existing.name !== name || existing.emoji !== emoji;
      existing.name = name;
      existing.emoji = emoji;
      if (changed) {
        const prefix = `${key}|`;
        for (const [positionKey, value] of Object.entries(this.state.positions)) {
          if (positionKey.startsWith(prefix)) {
            value.position.walletName = name;
            value.position.walletEmoji = emoji;
          }
        }
        this.persist();
      }
      return false;
    }
    const chatKey = String(chatId);
    const id = (Number(this.state.nextWalletId[chatKey]) || 0) + 1;
    this.state.nextWalletId[chatKey] = id;
    this.state.trackedWallets[key] = { id, chatId, address, chain, name, emoji, initialized: false, createdAt: nowIso() };
    this.persist();
    return true;
  }

  wallets() {
    return Object.values(this.state.trackedWallets).map(({ id, chatId, address, chain, name = "Wallet", emoji = "👝" }) => ({ id, chatId, address, chain, name, emoji }));
  }

  walletsForChat(chatId) {
    return this.wallets().filter((wallet) => String(wallet.chatId) === String(chatId));
  }

  removeWallet(wallet) {
    const key = this.walletKey(wallet.chatId, wallet.address, wallet.chain);
    if (!this.state.trackedWallets[key]) return false;
    delete this.state.trackedWallets[key];
    const prefix = `${key}|`;
    for (const positionKey of Object.keys(this.state.positions)) {
      if (positionKey.startsWith(prefix)) delete this.state.positions[positionKey];
    }
    this.persist();
    return true;
  }

  removeWallets(chatId, selector) {
    const value = String(selector || "").trim();
    const wallets = this.walletsForChat(chatId);
    let matches;
    if (value.toLowerCase() === "all") {
      matches = wallets;
    } else {
      const lower = value.toLowerCase();
      matches = wallets.filter((wallet) => String(wallet.id) === value
        || wallet.address.toLowerCase() === lower
        || String(wallet.name).toLowerCase() === lower);
    }
    for (const wallet of matches) this.removeWallet(wallet);
    return matches;
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
      position: { ...position, walletName: wallet.name || position.walletName || "Wallet", walletEmoji: wallet.emoji || position.walletEmoji || "👝" },
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
  constructor(apiKey, { baseUrl = "https://api.lpagent.io/open-api/v1", timeoutMs = 30_000, poolCacheTtlMs = 5 * 60_000 } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
    this.poolCacheTtlMs = poolCacheTtlMs;
    this.poolCache = new Map();
    this.poolRequests = new Map();
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

  async walletOverview(address, chain) {
    const payload = await this.getJson("lp-positions/overview", { owner: address, chain });
    return payload.data || payload;
  }

  async poolMetrics(position) {
    const poolId = positionPoolId(position);
    if (!poolId) return null;
    const protocol = protocolKeyFromPosition(position);
    const key = `${position.chain}|${protocol || "all"}|${poolId.toLowerCase()}`;
    const cached = this.poolCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (this.poolRequests.has(key)) return this.poolRequests.get(key);
    const request = (async () => {
      const payload = await this.getJson("pools/discover", {
        chain: position.chain,
        search: poolId,
        show_small_pools: "true",
        ...(protocol ? { platform: protocol } : {}),
        page: "1",
        pageSize: "10",
      });
      const pools = Array.isArray(payload.data) ? payload.data : [];
      const pool = pools.find((item) => String(item?.pool || "").toLowerCase() === poolId.toLowerCase()) || pools[0];
      const value = poolMetricsFromApi(pool);
      if (value) this.poolCache.set(key, { value, expiresAt: Date.now() + this.poolCacheTtlMs });
      return value;
    })();
    this.poolRequests.set(key, request);
    try {
      return await request;
    } finally {
      this.poolRequests.delete(key);
    }
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
    if (needsInvestmentDetail(enriched) || needsTokenMetadata(enriched)) {
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
      const openingParts = openingRangeParts(enriched.raw, openingLog);
      if (openingLog || openingRange) {
        enriched = {
          ...enriched,
          openedAt: openingAt ? openingAt.toISOString() : enriched.openedAt,
          openingRangeDisplay: openingRange,
          openingRangePlus: openingParts?.plus || null,
          openingRangeMinus: openingParts?.minus || null,
          rangeSource: openingRange ? "add_liquidity" : "current",
        };
      }
    } catch (error) {
      // The historical range is optional; do not block open/close detection.
      if (error.status === 429) return enriched;
    }
    return enriched;
  }

  async enrichPoolMetrics(position) {
    try {
      const metrics = await this.poolMetrics(position);
      return metrics ? { ...position, poolMetrics: metrics } : position;
    } catch (error) {
      // Pool analytics are optional; an API failure must not suppress OPENED/CLOSED alerts.
      return position;
    }
  }
}

function normalizedPoolKey(position) {
  const id = positionPoolId(position);
  if (id) return `id:${id.toLowerCase()}`;
  const pair = String(position?.pool || "")
    .split("/")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join("/");
  return `pair:${pair}`;
}

function eventTimestamp(event) {
  return parseTimestamp(event.eventType === "CLOSED"
    ? event.closedAt || event.observedAt || event.position?.closedAt
    : event.position?.openedAt || event.observedAt);
}

function eventMergeBaseKey(event) {
  const position = event.position || {};
  return [
    event.chatId,
    String(position.wallet || "").toLowerCase(),
    position.chain,
    event.eventType,
    String(position.protocol || "").toLowerCase(),
    normalizedPoolKey(position),
  ].join("|");
}

function signedRangeValue(value) {
  if (value === null || value === undefined || value === "-") return null;
  const parsed = Number.parseFloat(String(value).replace("%", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function mergedRangeParts(positions) {
  const parts = positions.map((position) => eventRangeParts(position));
  const plus = parts.map((part) => signedRangeValue(part.plus)).filter((value) => value !== null);
  const minus = parts.map((part) => signedRangeValue(part.minus)).filter((value) => value !== null);
  const plusValue = plus.length ? Math.max(...plus) : null;
  const minusValue = minus.length ? Math.min(...minus) : null;
  return {
    plus: plusValue === null ? "-" : formatSignedPercent(plusValue),
    minus: minusValue === null ? "-" : formatSignedPercent(minusValue),
  };
}

function mergeInvestments(positions) {
  const merged = new Map();
  for (const position of positions) {
    for (const item of position.investments || []) {
      const key = String(item.symbol || "").toLowerCase();
      const current = merged.get(key) || { ...item, amount: 0, usdValue: 0, hasUsdValue: false };
      if (Number.isFinite(item.amount)) current.amount += item.amount;
      if (Number.isFinite(item.usdValue)) {
        current.usdValue += item.usdValue;
        current.hasUsdValue = true;
      }
      merged.set(key, current);
    }
  }
  const rows = [...merged.values()].map((item) => ({
    symbol: item.symbol,
    amount: item.amount,
    usdValue: item.hasUsdValue ? item.usdValue : null,
    share: null,
  }));
  const totalUsd = rows.reduce((sum, item) => sum + (item.usdValue ?? 0), 0);
  for (const item of rows) {
    if (item.usdValue !== null && totalUsd > 0) item.share = (item.usdValue / totalUsd) * 100;
  }
  return rows;
}

function mergePositions(positions) {
  const first = positions[0];
  const range = mergedRangeParts(positions);
  const openedAt = positions
    .map((position) => parseTimestamp(position.openedAt))
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  const positionIds = positions.map((position) => position.positionId);
  const openingRangeDisplay = range.plus !== "-" && range.minus !== "-"
    ? `${range.minus} to ${range.plus}`
    : range.plus !== "-" ? range.plus : range.minus;
  return {
    ...first,
    positionId: positionIds.length === 1 ? positionIds[0] : `group:${positionIds.join(",")}`,
    positionIds,
    openedAt: openedAt ? openedAt.toISOString() : first.openedAt,
    openingRangeDisplay: openingRangeDisplay || first.openingRangeDisplay,
    openingRangePlus: range.plus,
    openingRangeMinus: range.minus,
    rangeSource: "grouped_opening_ranges",
    investments: mergeInvestments(positions),
  };
}

export class LPTracker {
  constructor(client, store, logger = () => {}, { mergeWindowMs = 60_000 } = {}) {
    this.client = client;
    this.store = store;
    this.logger = logger;
    this.mergeWindowMs = mergeWindowMs;
    this.syncing = false;
  }

  async register(chatId, address, name = "Wallet", emoji = "👝", chain = undefined) {
    const [normalizedAddress, normalizedChain] = normalizeAddress(address, chain);
    const wallet = { chatId: Number(chatId), address: normalizedAddress, chain: normalizedChain, name: String(name || "Wallet"), emoji: String(emoji || "👝") };
    const added = this.store.addWallet(wallet.chatId, wallet.address, wallet.chain, wallet.name, wallet.emoji);
    if (added) {
      try {
        await this.syncWallet(wallet, null, false);
      } catch (error) {
        return { wallet, added, warning: error.message };
      }
    }
    return { wallet, added, warning: null };
  }

  list(chatId) {
    return this.store.walletsForChat(chatId).map((wallet) => ({
      ...wallet,
      activePositions: Object.values(this.store.positions(wallet)).filter((item) => item.active).length,
    }));
  }

  remove(chatId, selector) {
    return this.store.removeWallets(chatId, selector);
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
    const observedAt = nowIso();
    let walletWinRate;
    let overviewLoaded = false;
    const loadWalletWinRate = async () => {
      if (overviewLoaded) return walletWinRate;
      overviewLoaded = true;
      if (typeof this.client.walletOverview !== "function") return null;
      try {
        walletWinRate = extractWinRate(await this.client.walletOverview(wallet.address, wallet.chain));
      } catch (error) {
        if (error.status !== 404 && error.status !== 429) this.logger(`Win rate tidak tersedia ${wallet.address} ${wallet.chain}: ${error.message}`);
      }
      return walletWinRate;
    };
    if (!this.store.isInitialized(wallet)) {
      const overviewWinRate = await loadWalletWinRate();
      for (const position of currentById.values()) {
        const enriched = await this.client.enrichPosition(position);
        this.store.savePosition(wallet, {
          ...enriched,
          walletName: wallet.name,
          walletEmoji: wallet.emoji,
          walletWinRate: overviewWinRate ?? enriched.walletWinRate,
        });
      }
      this.store.markInitialized(wallet);
      return [];
    }

    const events = [];
    for (const [positionId, saved] of Object.entries(existing)) {
      if (saved.active && !currentById.has(positionId)) {
        this.store.markClosed(wallet, positionId);
        const winRate = saved.position.walletWinRate ?? await loadWalletWinRate();
        const closedPosition = !saved.position.poolMetrics && typeof this.client.enrichPoolMetrics === "function"
          ? await this.client.enrichPoolMetrics(saved.position)
          : saved.position;
        events.push({
          chatId: wallet.chatId,
          eventType: "CLOSED",
          position: {
            ...closedPosition,
            walletName: wallet.name,
            walletEmoji: wallet.emoji,
            walletWinRate: winRate,
          },
          observedAt,
        });
      }
    }
    for (const [positionId, position] of currentById.entries()) {
      const previous = existing[positionId];
      if (!previous || !previous.active) {
        let enriched = await this.client.enrichPosition(position);
        if (typeof this.client.enrichPoolMetrics === "function") enriched = await this.client.enrichPoolMetrics(enriched);
        const winRate = (await loadWalletWinRate()) ?? enriched.walletWinRate;
        const eventPosition = { ...enriched, walletName: wallet.name, walletEmoji: wallet.emoji, walletWinRate: winRate };
        this.store.savePosition(wallet, eventPosition);
        events.push({ chatId: wallet.chatId, eventType: "OPENED", position: eventPosition, observedAt });
      }
    }
    return emitEvents ? this.mergeEvents(events) : [];
  }

  mergeEvents(events) {
    const groupsByBase = new Map();
    for (const event of events) {
      const baseKey = eventMergeBaseKey(event);
      const timestamp = eventTimestamp(event)?.getTime() ?? null;
      const candidates = groupsByBase.get(baseKey) || [];
      let group = candidates.find((candidate) => {
        if (timestamp === null || candidate.minTimestamp === null) return true;
        return Math.abs(timestamp - candidate.minTimestamp) <= this.mergeWindowMs;
      });
      if (!group) {
        group = { events: [], minTimestamp: timestamp };
        candidates.push(group);
        groupsByBase.set(baseKey, candidates);
      }
      group.events.push(event);
      if (timestamp !== null && (group.minTimestamp === null || timestamp < group.minTimestamp)) group.minTimestamp = timestamp;
    }
    return [...groupsByBase.values()].flatMap((groups) => groups.map((group) => {
      if (group.events.length === 1) return group.events[0];
      const first = group.events[0];
      return {
        ...first,
        position: mergePositions(group.events.map((event) => event.position)),
        positionIds: group.events.flatMap((event) => event.position.positionIds || [event.position.positionId]),
      };
    }));
  }
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function eventTitle(eventType) {
  return eventType === "OPENED" ? "🍏" : "🍎";
}

export function eventRange(position) {
  return position.openingRangeDisplay || position.currentRangeDisplay || "-";
}

function parseRangeParts(display) {
  const values = String(display || "").match(/[+-]?\d+(?:\.\d+)?%/g)?.map((value) => Number.parseFloat(value)) || [];
  const positive = values.filter((value) => value >= 0).sort((a, b) => b - a)[0];
  const negative = values.filter((value) => value < 0).sort((a, b) => a - b)[0];
  return { plus: positive === undefined ? "-" : formatSignedPercent(positive), minus: negative === undefined ? "-" : formatSignedPercent(negative) };
}

function eventRangeParts(position) {
  if (position.openingRangeDisplay) {
    const fallback = parseRangeParts(position.openingRangeDisplay);
    return { plus: position.openingRangePlus || fallback.plus, minus: position.openingRangeMinus || fallback.minus };
  }
  const fallback = parseRangeParts(position.currentRangeDisplay);
  return { plus: position.currentRangePlus || fallback.plus, minus: position.currentRangeMinus || fallback.minus };
}

function shortWallet(address) {
  const value = String(address || "-");
  return value.length > 10 ? `${value.slice(0, 5)}...${value.slice(-3)}` : value;
}

function eventToken(position) {
  if (position.targetToken) return position.targetToken;
  const symbols = String(position.pool || "").split("/").map((value) => value.trim());
  const selected = symbols.find((value) => value.toLowerCase() === "musebook") || symbols[0] || "Token";
  return { ticker: selected, name: selected };
}

function eventWalletName(position) {
  return position.walletName || "Wallet";
}

function eventWalletEmoji(position) {
  return position.walletEmoji || "👝";
}

function eventWinRate(position) {
  return position.walletWinRate === null || position.walletWinRate === undefined ? "-" : formatPercent(position.walletWinRate);
}

function eventBaseFee(position) {
  return position.baseFee || baseFeeDisplay(position.raw || {});
}

function eventPoolMetrics(position) {
  return position.poolMetrics || {};
}

function eventApr(position) {
  const metrics = eventPoolMetrics(position);
  if (metrics.apr === null || metrics.apr === undefined || !Number.isFinite(metrics.apr)) return "-";
  return `${metrics.aprEstimated ? "~" : ""}${formatPercent(metrics.apr)}`;
}

export function renderEventText(event, now = new Date()) {
  const { position } = event;
  const chain = position.chain === "ROBINHOOD" ? "Robinhood" : "SOL";
  const token = eventToken(position);
  const range = eventRangeParts(position);
  const metrics = eventPoolMetrics(position);
  const lines = [
    `${eventTitle(event.eventType)} ${token.ticker} ${token.name}`,
    "",
    "👝 Wallet",
    `${eventWalletEmoji(position)} | ${shortWallet(position.wallet)} | ${eventWalletName(position)} | ${eventWinRate(position)}`,
    "",
    "💧 Pool",
    `🔗 Chain | ${chain}`,
    `♻️ Protocol | ${position.protocol}`,
    `💦 Pool | ${position.pool}`,
    `💸 Base fee | ${eventBaseFee(position)}`,
    `📊 TVL | ${formatUsd(metrics.tvl)}`,
    `📈 Volume 24h | ${formatUsd(metrics.volume24h)}`,
    `🚀 APR | ${eventApr(position)}`,
    "",
    "📌 Detail",
    ...position.investments.map((item, index) => `${index === 0 ? "💶" : "💷"} ${item.symbol} | ${formatAmount(item.amount)} | ${formatUsd(item.usdValue)}`),
    `🏷 Range | ${range.plus} | ${range.minus}`,
    "",
    `⏰ ${formatAge(position.openedAt, now)}`,
  ];
  return lines.join("\n");
}

export function renderEventHtml(event, now = new Date()) {
  const { position } = event;
  const chain = position.chain === "ROBINHOOD" ? "Robinhood" : "SOL";
  const token = eventToken(position);
  const range = eventRangeParts(position);
  const metrics = eventPoolMetrics(position);
  const rows = position.investments.length
    ? position.investments.map((item, index) => `<tr><td>${index === 0 ? "💶" : "💷"} ${escapeHtml(item.symbol)}</td><td>${escapeHtml(formatAmount(item.amount))}</td><td>${escapeHtml(formatUsd(item.usdValue))}</td></tr>`).join("")
    : "<tr><td colspan='3'>-</td></tr>";
  return [
    `<h2>${eventTitle(event.eventType)} <b>${escapeHtml(token.ticker)}</b> ${escapeHtml(token.name)}</h2>`,
    "<hr>",
    "<h3>👝 Wallet</h3>",
    `<table><tr><th>Emoji</th><th>Wallet</th><th>Name</th><th>Win rate</th></tr><tr><td>${escapeHtml(eventWalletEmoji(position))}</td><td><code>${escapeHtml(shortWallet(position.wallet))}</code></td><td>${escapeHtml(eventWalletName(position))}</td><td>${escapeHtml(eventWinRate(position))}</td></tr></table>`,
    "<hr>",
    "<h3>💧 Pool</h3>",
    `<table><tr><th>Name</th><th>Value</th></tr><tr><td>🔗 Chain</td><td>${escapeHtml(chain)}</td></tr><tr><td>♻️ Protocol</td><td>${escapeHtml(position.protocol)}</td></tr><tr><td>💦 Pool</td><td>${escapeHtml(position.pool)}</td></tr><tr><td>💸 Base fee</td><td>${escapeHtml(eventBaseFee(position))}</td></tr><tr><td>📊 TVL</td><td>${escapeHtml(formatUsd(metrics.tvl))}</td></tr><tr><td>📈 Volume 24h</td><td>${escapeHtml(formatUsd(metrics.volume24h))}</td></tr><tr><td>🚀 APR</td><td>${escapeHtml(eventApr(position))}</td></tr></table>`,
    "<hr>",
    "<h3>📌 Detail</h3>",
    `<table><tr><th>Name</th><th>Value</th><th>USD</th></tr>${rows}<tr><td>🏷 Range</td><td>${escapeHtml(range.plus)}</td><td>${escapeHtml(range.minus)}</td></tr></table>`,
    `<p>⏰ ${escapeHtml(formatAge(position.openedAt, now))}</p>`,
  ].join("");
}

export function renderTrackListHtml(wallets) {
  const rows = wallets.length
    ? wallets.map((wallet) => `<tr><td>${escapeHtml(wallet.id)}</td><td>${escapeHtml(wallet.emoji)}</td><td><code>${escapeHtml(shortWallet(wallet.address))}</code></td><td>${escapeHtml(wallet.name)}</td><td>${escapeHtml(wallet.chain === "ROBINHOOD" ? "Robinhood" : "SOL")}</td><td>${escapeHtml(wallet.activePositions ?? 0)}</td></tr>`).join("")
    : "<tr><td colspan='6'>Belum ada wallet yang di-track.</td></tr>";
  return [
    "<h2>📋 Track List</h2>",
    `<table><tr><th>ID</th><th></th><th>Wallet</th><th>Name</th><th>Chain</th><th>LP aktif</th></tr>${rows}</table>`,
  ].join("");
}

export function renderTrackListText(wallets) {
  if (!wallets.length) return "📋 Track List\n\nBelum ada wallet yang di-track.";
  return [
    "📋 Track List",
    "",
    ...wallets.map((wallet) => `${wallet.id} | ${wallet.emoji} | ${shortWallet(wallet.address)} | ${wallet.name} | ${wallet.chain === "ROBINHOOD" ? "Robinhood" : "SOL"} | LP aktif: ${wallet.activePositions ?? 0}`),
  ].join("\n");
}

export function renderTrackRemoveHtml(wallets) {
  const rows = wallets.map((wallet) => `<tr><td>${escapeHtml(wallet.id)}</td><td>${escapeHtml(wallet.emoji)}</td><td><code>${escapeHtml(shortWallet(wallet.address))}</code></td><td>${escapeHtml(wallet.name)}</td></tr>`).join("");
  return `<h2>✅ Tracking Removed</h2><table><tr><th>ID</th><th></th><th>Wallet</th><th>Name</th></tr>${rows}</table>`;
}

export function renderTrackRemoveText(wallets) {
  return ["✅ Tracking removed", "", ...wallets.map((wallet) => `${wallet.id} | ${wallet.emoji} | ${shortWallet(wallet.address)} | ${wallet.name}`)].join("\n");
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

  async sendRichHtml(chatId, html, fallbackText) {
    try {
      await this.call("sendRichMessage", { chat_id: chatId, rich_message: { html } });
    } catch {
      await this.sendText(chatId, fallbackText);
    }
  }

  async sendRichTrackList(chatId, wallets) {
    await this.sendRichHtml(chatId, renderTrackListHtml(wallets), renderTrackListText(wallets));
  }

  async sendRichTrackRemoved(chatId, wallets) {
    await this.sendRichHtml(chatId, renderTrackRemoveHtml(wallets), renderTrackRemoveText(wallets));
  }

  async sendRichEvent(event) {
    await this.sendRichHtml(event.chatId, renderEventHtml(event), renderEventText(event));
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
        const args = text.split(/\s+/);
        const command = String(args[0] || "").toLowerCase().split("@")[0];
        if (command === "/start") {
          await telegram.sendText(chatId, "Kirim /track <address> <name> <emoji> untuk mulai memantau posisi LP.");
          continue;
        }
        if (command === "/track-list") {
          await telegram.sendRichTrackList(chatId, tracker.list(chatId));
          continue;
        }
        if (command === "/track-remove") {
          if (args.length !== 2) {
            await telegram.sendText(chatId, "Format: /track-remove <id|address|name|all>");
            continue;
          }
          const removed = tracker.remove(chatId, args[1]);
          if (removed.length) await telegram.sendRichTrackRemoved(chatId, removed);
          else await telegram.sendText(chatId, "Tracking tidak ditemukan.");
          continue;
        }
        if (command !== "/track") continue;
        if (![3, 4].includes(args.length)) {
          await telegram.sendText(chatId, "Format: /track <address> <name> <emoji>");
          continue;
        }
        try {
          const legacyChain = args.length === 3 && ["SOL", "ROBINHOOD"].includes(args[2].toUpperCase()) ? args[2] : undefined;
          const name = legacyChain ? "Wallet" : args[2];
          const emoji = legacyChain ? "👝" : args[3];
          const result = await tracker.register(chatId, args[1], name, emoji, legacyChain);
          if (result.warning) await telegram.sendText(chatId, `Tracking tersimpan, tetapi baseline belum bisa diambil: ${result.warning}`);
          else if (result.added) await telegram.sendText(chatId, `Tracking aktif untuk ${result.wallet.name} ${result.wallet.emoji} (${result.wallet.address}, ${result.wallet.chain}). Posisi saat ini dijadikan baseline.`);
          else await telegram.sendText(chatId, "Wallet tersebut sudah di-track; nama dan emoji diperbarui.");
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
