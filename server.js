const http = require("node:http");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DEFAULT_RUNTIME_DATA_DIR = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "RialoPM", "data")
  : path.join(os.tmpdir(), "rialo-pm-data");
const DATA_DIR = process.env.RIALO_DATA_DIR
  ? path.resolve(process.env.RIALO_DATA_DIR)
  : DEFAULT_RUNTIME_DATA_DIR;
const DATA_FILE = path.join(DATA_DIR, "market.json");
const DB_FILE = path.join(DATA_DIR, "market.db");
const LOCAL_AI_CONFIG_FILE = path.join(DATA_DIR, "rialo-ai.config.json");
const DEFAULT_WALLET_RLO_BALANCE = 250000;
const DEFAULT_FEE_BPS = 30;
const DEFAULT_CREATOR_SHARE = 0.2;
const RIALO_RPC_URL = process.env.RIALO_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const RIALO_CHAIN_ID = "0xaa36a7";
const INDEXER_POLL_MS = Number(process.env.RIALO_INDEXER_POLL_MS || 12000);
const TRADE_EXECUTED_TOPIC = "0x9ce8a552d9a28a585b4d3bd87da383f1f7ee25a97365977f122cf1b2a1fcaa46";
const GET_POOL_SELECTOR = "bbe4f6db";
const LOCAL_AI_CONFIG = loadLocalAiConfig();
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL_ALIASES = Object.freeze({
  "llama-3.3-70b-versatile": "openai/gpt-oss-120b",
  "llama-3.1-8b-instant": "openai/gpt-oss-20b"
});
const CONFIGURED_GROQ_MODEL = String(process.env.GROQ_MODEL || "").trim();
const ACTIVE_GROQ_MODEL = GROQ_MODEL_ALIASES[CONFIGURED_GROQ_MODEL]
  || CONFIGURED_GROQ_MODEL
  || "openai/gpt-oss-120b";
const AI_API_KEY = GROQ_API_KEY || process.env.OPENAI_API_KEY || LOCAL_AI_CONFIG.apiKey || "";
const AI_MODEL = GROQ_API_KEY
  ? ACTIVE_GROQ_MODEL
  : process.env.OPENAI_MODEL || LOCAL_AI_CONFIG.model || "gpt-4.1-mini";
const AI_API_URL = GROQ_API_KEY
  ? process.env.GROQ_API_URL || "https://api.groq.com/openai/v1/chat/completions"
  : process.env.OPENAI_API_URL || LOCAL_AI_CONFIG.apiUrl || "https://api.openai.com/v1/responses";
const AI_PROVIDER = GROQ_API_KEY
  ? "groq"
  : /generativelanguage\.googleapis\.com/i.test(AI_API_URL)
    ? "gemini"
    : "openai";
let marketDb = null;
const communityChatRateLimits = new Map();
let indexerState = {
  running: false,
  lastSyncAt: "",
  lastError: "",
  lastFactories: 0
};

function downloadRemoteImage(sourceUrl, redirectsLeft = 4) {
  return new Promise((resolve, reject) => {
    const request = https.get(sourceUrl, {
      headers: { "User-Agent": "RialoPM/1.0" },
      rejectUnauthorized: true
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirectsLeft > 0) {
        response.resume();
        resolve(downloadRemoteImage(new URL(response.headers.location, sourceUrl).toString(), redirectsLeft - 1));
        return;
      }

      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        contentType: String(response.headers["content-type"] || ""),
        buffer: Buffer.concat(chunks)
      }));
    });

    request.setTimeout(12000, () => request.destroy(new Error("Avatar request timed out.")));
    request.on("error", reject);
  });
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp"
};

function loadLocalAiConfig() {
  try {
    if (!fs.existsSync(LOCAL_AI_CONFIG_FILE)) {
      return {};
    }

    const raw = fs.readFileSync(LOCAL_AI_CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function getMetadataValue(key) {
  const db = getMarketDb();
  const row = db.prepare(`SELECT value FROM metadata WHERE key = ?`).get(String(key || ""));
  return row ? row.value : "";
}

function setMetadataValue(key, value) {
  const db = getMarketDb();
  db.prepare(`
    INSERT INTO metadata (key, value)
    VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run({
    key: String(key || ""),
    value: String(value ?? "")
  });
}

async function rpcCall(method, params = []) {
  const response = await fetch(RIALO_RPC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const message = data?.error?.message || `RPC ${method} failed`;
    throw new Error(message);
  }

  return data.result;
}

function hexToBigInt(value) {
  if (!value || value === "0x") {
    return 0n;
  }

  return BigInt(value);
}

function wadBigIntToNumber(value) {
  const divisor = 10n ** 18n;
  const whole = value / divisor;
  const fraction = value % divisor;
  const fractionText = fraction.toString().padStart(18, "0").slice(0, 6);
  return Number(`${whole.toString()}.${fractionText}`.replace(/\.$/, ""));
}

function hexWordToNumber(wordHex) {
  return wadBigIntToNumber(hexToBigInt(wordHex));
}

function decodeStaticWords(dataHex) {
  const safe = String(dataHex || "").replace(/^0x/, "");
  const words = [];

  for (let index = 0; index < safe.length; index += 64) {
    const word = safe.slice(index, index + 64);
    if (word.length === 64) {
      words.push(`0x${word}`);
    }
  }

  return words;
}

function decodeTopicAddress(topic) {
  const safe = String(topic || "").toLowerCase();
  if (!safe.startsWith("0x") || safe.length < 42) {
    return "";
  }

  return `0x${safe.slice(-40)}`;
}

function decodeTopicBool(topic) {
  return hexToBigInt(topic) !== 0n;
}

function encodeAddressCall(selector, address) {
  const normalized = sanitizeAddress(address).replace(/^0x/, "").toLowerCase();
  if (normalized.length !== 40) {
    return "";
  }

  return `0x${selector}${normalized.padStart(64, "0")}`;
}

function toRpcHex(numberValue) {
  return `0x${Math.max(0, Number(numberValue || 0)).toString(16)}`;
}

function ensureDataPaths() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ tokens: [], wallets: {} }, null, 2));
  }

  if (!fs.existsSync(LOCAL_AI_CONFIG_FILE)) {
    fs.writeFileSync(LOCAL_AI_CONFIG_FILE, JSON.stringify({
      apiKey: "",
      model: "gpt-4.1-mini",
      apiUrl: "https://api.openai.com/v1/responses"
    }, null, 2));
  }
}

function getMarketDb() {
  ensureDataPaths();

  if (marketDb) {
    return marketDb;
  }

  marketDb = new DatabaseSync(DB_FILE);
  marketDb.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      description TEXT NOT NULL,
      website TEXT NOT NULL,
      image_url TEXT NOT NULL,
      token_address TEXT NOT NULL,
      factory_address TEXT NOT NULL,
      creation_tx_hash TEXT NOT NULL,
      on_chain_supply TEXT NOT NULL,
      creator_address TEXT NOT NULL,
      creator_signature TEXT NOT NULL,
      creator_rlo_balance REAL NOT NULL DEFAULT 0,
      seed_liquidity_rlo REAL NOT NULL DEFAULT 0,
      initial_price REAL NOT NULL DEFAULT 0,
      price REAL NOT NULL DEFAULT 0,
      supply REAL NOT NULL DEFAULT 0,
      holders REAL NOT NULL DEFAULT 0,
      volume REAL NOT NULL DEFAULT 0,
      creator_allocation REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      pool_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id TEXT NOT NULL,
      side TEXT NOT NULL,
      amount_rlo REAL NOT NULL DEFAULT 0,
      amount_token REAL NOT NULL DEFAULT 0,
      price REAL NOT NULL DEFAULT 0,
      execution_price REAL NOT NULL DEFAULT 0,
      trader_address TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      sort_index INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (token_id) REFERENCES tokens(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wallets (
      address TEXT PRIMARY KEY,
      rlo_balance REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      seeded_from_wallet INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS wallet_token_balances (
      wallet_address TEXT NOT NULL,
      token_id TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (wallet_address, token_id),
      FOREIGN KEY (wallet_address) REFERENCES wallets(address) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS nft_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      token_id INTEGER NOT NULL,
      seller_address TEXT NOT NULL,
      amount INTEGER NOT NULL DEFAULT 1,
      price_rlo REAL NOT NULL DEFAULT 0,
      marketplace_address TEXT NOT NULL DEFAULT '',
      tx_hash TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (code, seller_address)
    );

    CREATE TABLE IF NOT EXISTS community_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      wallet_address TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL,
      reply_to_id INTEGER NOT NULL DEFAULT 0,
      reply_username TEXT NOT NULL DEFAULT '',
      reply_message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_community_chat_messages_created
    ON community_chat_messages(id DESC);
  `);

  const tradeColumns = marketDb.prepare(`PRAGMA table_info(trades)`).all();
  if (!tradeColumns.some(column => column.name === "tx_hash")) {
    marketDb.exec(`ALTER TABLE trades ADD COLUMN tx_hash TEXT NOT NULL DEFAULT ''`);
  }

  const nftListingColumns = marketDb.prepare(`PRAGMA table_info(nft_listings)`).all();
  if (!nftListingColumns.some(column => column.name === "amount")) {
    marketDb.exec(`ALTER TABLE nft_listings ADD COLUMN amount INTEGER NOT NULL DEFAULT 1`);
  }
  if (!nftListingColumns.some(column => column.name === "tx_hash")) {
    marketDb.exec(`ALTER TABLE nft_listings ADD COLUMN tx_hash TEXT NOT NULL DEFAULT ''`);
  }
  if (!nftListingColumns.some(column => column.name === "marketplace_address")) {
    marketDb.exec(`ALTER TABLE nft_listings ADD COLUMN marketplace_address TEXT NOT NULL DEFAULT ''`);
  }

  const communityChatColumns = marketDb.prepare(`PRAGMA table_info(community_chat_messages)`).all();
  if (!communityChatColumns.some(column => column.name === "reply_to_id")) {
    marketDb.exec(`ALTER TABLE community_chat_messages ADD COLUMN reply_to_id INTEGER NOT NULL DEFAULT 0`);
  }
  if (!communityChatColumns.some(column => column.name === "reply_username")) {
    marketDb.exec(`ALTER TABLE community_chat_messages ADD COLUMN reply_username TEXT NOT NULL DEFAULT ''`);
  }
  if (!communityChatColumns.some(column => column.name === "reply_message")) {
    marketDb.exec(`ALTER TABLE community_chat_messages ADD COLUMN reply_message TEXT NOT NULL DEFAULT ''`);
  }

  normalizeNftListingIdentity(marketDb);

  marketDb.prepare(`
    INSERT INTO metadata (key, value)
    VALUES ('storage_backend', 'sqlite')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run();

  return marketDb;
}

function loadLegacyMarketJson() {
  ensureDataPaths();

  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return migrateMarket({
      tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [],
      wallets: parsed.wallets && typeof parsed.wallets === "object" ? parsed.wallets : {}
    });
  } catch {
    return { tokens: [], wallets: {} };
  }
}

function marketHasStructuredData(market) {
  return Boolean(
    (Array.isArray(market.tokens) && market.tokens.length > 0) ||
    (market.wallets && Object.keys(market.wallets).length > 0)
  );
}

function buildMarketFromDb() {
  const db = getMarketDb();
  const tokens = db.prepare(`
    SELECT
      id,
      name,
      symbol,
      description,
      website,
      image_url,
      token_address,
      factory_address,
      creation_tx_hash,
      on_chain_supply,
      creator_address,
      creator_signature,
      creator_rlo_balance,
      seed_liquidity_rlo,
      initial_price,
      price,
      supply,
      holders,
      volume,
      creator_allocation,
      created_at,
      pool_json
    FROM tokens
    ORDER BY datetime(created_at) DESC, id DESC
  `).all();

  const trades = db.prepare(`
    SELECT
      token_id,
      side,
      amount_rlo,
      amount_token,
      price,
      execution_price,
      trader_address,
      tx_hash,
      timestamp,
      sort_index
    FROM trades
    ORDER BY token_id ASC, sort_index ASC, id ASC
  `).all();

  const wallets = db.prepare(`
    SELECT address, rlo_balance, created_at, seeded_from_wallet
    FROM wallets
  `).all();

  const walletTokenRows = db.prepare(`
    SELECT wallet_address, token_id, balance
    FROM wallet_token_balances
  `).all();

  const tradeMap = new Map();
  trades.forEach(row => {
    if (!tradeMap.has(row.token_id)) {
      tradeMap.set(row.token_id, []);
    }

    tradeMap.get(row.token_id).push({
      side: row.side,
      amountRlo: Number(row.amount_rlo || 0),
      amountToken: Number(row.amount_token || 0),
      price: Number(row.price || 0),
      executionPrice: Number(row.execution_price || 0),
      traderAddress: row.trader_address,
      txHash: row.tx_hash || "",
      timestamp: row.timestamp
    });
  });

  const walletMap = {};
  wallets.forEach(row => {
    walletMap[row.address] = {
      address: row.address,
      rloBalance: Number(row.rlo_balance || 0),
      createdAt: row.created_at,
      seededFromWallet: Boolean(row.seeded_from_wallet),
      tokenBalances: {}
    };
  });

  walletTokenRows.forEach(row => {
    if (!walletMap[row.wallet_address]) {
      walletMap[row.wallet_address] = {
        address: row.wallet_address,
        rloBalance: DEFAULT_WALLET_RLO_BALANCE,
        createdAt: new Date().toISOString(),
        seededFromWallet: false,
        tokenBalances: {}
      };
    }

    walletMap[row.wallet_address].tokenBalances[row.token_id] = Number(row.balance || 0);
  });

  return migrateMarket({
    tokens: tokens.map(row => ({
      id: row.id,
      name: row.name,
      symbol: row.symbol,
      description: row.description,
      website: row.website,
      imageUrl: row.image_url,
      tokenAddress: row.token_address,
      factoryAddress: row.factory_address,
      creationTxHash: row.creation_tx_hash,
      onChainSupply: row.on_chain_supply,
      creatorAddress: row.creator_address,
      creatorSignature: row.creator_signature,
      creatorRloBalance: Number(row.creator_rlo_balance || 0),
      seedLiquidityRlo: Number(row.seed_liquidity_rlo || 0),
      initialPrice: Number(row.initial_price || 0),
      price: Number(row.price || 0),
      supply: Number(row.supply || 0),
      holders: Number(row.holders || 0),
      volume: Number(row.volume || 0),
      creatorAllocation: Number(row.creator_allocation || 0),
      createdAt: row.created_at,
      pool: JSON.parse(row.pool_json || "{}"),
      tradeHistory: tradeMap.get(row.id) || []
    })),
    wallets: walletMap
  });
}

function writeMarket(data) {
  const db = getMarketDb();
  const market = migrateMarket(data);
  const tokenRows = Array.isArray(market.tokens) ? market.tokens : [];
  const walletEntries = Object.values(market.wallets || {});

  try {
    db.exec("BEGIN IMMEDIATE TRANSACTION");
    db.exec(`
      DELETE FROM wallet_token_balances;
      DELETE FROM trades;
      DELETE FROM tokens;
      DELETE FROM wallets;
    `);

    const insertToken = db.prepare(`
      INSERT INTO tokens (
        id, name, symbol, description, website, image_url, token_address, factory_address,
        creation_tx_hash, on_chain_supply, creator_address, creator_signature, creator_rlo_balance,
        seed_liquidity_rlo, initial_price, price, supply, holders, volume, creator_allocation,
        created_at, pool_json
      ) VALUES (
        @id, @name, @symbol, @description, @website, @imageUrl, @tokenAddress, @factoryAddress,
        @creationTxHash, @onChainSupply, @creatorAddress, @creatorSignature, @creatorRloBalance,
        @seedLiquidityRlo, @initialPrice, @price, @supply, @holders, @volume, @creatorAllocation,
        @createdAt, @poolJson
      )
    `);

    const insertTrade = db.prepare(`
      INSERT INTO trades (
        token_id, side, amount_rlo, amount_token, price, execution_price, trader_address, tx_hash, timestamp, sort_index
      ) VALUES (
        @tokenId, @side, @amountRlo, @amountToken, @price, @executionPrice, @traderAddress, @txHash, @timestamp, @sortIndex
      )
    `);

    const insertWallet = db.prepare(`
      INSERT INTO wallets (address, rlo_balance, created_at, seeded_from_wallet)
      VALUES (@address, @rloBalance, @createdAt, @seededFromWallet)
    `);

    const insertWalletBalance = db.prepare(`
      INSERT INTO wallet_token_balances (wallet_address, token_id, balance)
      VALUES (@walletAddress, @tokenId, @balance)
    `);

    tokenRows.forEach(token => {
      insertToken.run({
        id: token.id,
        name: token.name,
        symbol: token.symbol,
        description: token.description,
        website: token.website || "None",
        imageUrl: token.imageUrl || "",
        tokenAddress: token.tokenAddress || "",
        factoryAddress: token.factoryAddress || "",
        creationTxHash: token.creationTxHash || "",
        onChainSupply: token.onChainSupply || "",
        creatorAddress: token.creatorAddress || "",
        creatorSignature: token.creatorSignature || "",
        creatorRloBalance: Number(token.creatorRloBalance || 0),
        seedLiquidityRlo: Number(token.seedLiquidityRlo || 0),
        initialPrice: Number(token.initialPrice || token.price || 0),
        price: Number(token.price || 0),
        supply: Number(token.supply || 0),
        holders: Number(token.holders || 0),
        volume: Number(token.volume || 0),
        creatorAllocation: Number(token.creatorAllocation || 0),
        createdAt: token.createdAt || new Date().toISOString(),
        poolJson: JSON.stringify(token.pool || {})
      });

      (Array.isArray(token.tradeHistory) ? token.tradeHistory : []).forEach((trade, index) => {
        insertTrade.run({
          tokenId: token.id,
          side: sanitizeString(trade.side || "BUY", 8).toUpperCase(),
          amountRlo: Number(trade.amountRlo ?? trade.amount ?? 0),
          amountToken: Number(trade.amountToken ?? 0),
          price: Number(trade.price || 0),
          executionPrice: Number(trade.executionPrice || trade.price || 0),
          traderAddress: sanitizeAddress(trade.traderAddress),
          txHash: sanitizeString(trade.txHash || "", 120),
          timestamp: trade.timestamp || new Date().toISOString(),
          sortIndex: index
        });
      });
    });

    walletEntries.forEach(wallet => {
      insertWallet.run({
        address: wallet.address,
        rloBalance: Number(wallet.rloBalance || 0),
        createdAt: wallet.createdAt || new Date().toISOString(),
        seededFromWallet: wallet.seededFromWallet ? 1 : 0
      });

      Object.entries(wallet.tokenBalances || {}).forEach(([tokenId, balance]) => {
        if (Number(balance || 0) <= 0) {
          return;
        }

        insertWalletBalance.run({
          walletAddress: wallet.address,
          tokenId,
          balance: Number(balance || 0)
        });
      });
    });

    db.prepare(`
      INSERT INTO metadata (key, value)
      VALUES ('last_write_at', @value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run({ value: new Date().toISOString() });
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors if no transaction is active.
    }

    throw error;
  }
}

function readMarket() {
  const db = getMarketDb();
  const tokenCount = Number(db.prepare("SELECT COUNT(*) AS count FROM tokens").get().count || 0);
  const walletCount = Number(db.prepare("SELECT COUNT(*) AS count FROM wallets").get().count || 0);

  if (tokenCount === 0 && walletCount === 0) {
    const legacyMarket = loadLegacyMarketJson();

    if (marketHasStructuredData(legacyMarket)) {
      writeMarket(legacyMarket);
      return legacyMarket;
    }
  }

  return buildMarketFromDb();
}

async function getBlockTimestampMemo(blockHex, cache) {
  if (!blockHex) {
    return new Date().toISOString();
  }

  if (cache.has(blockHex)) {
    return cache.get(blockHex);
  }

  const block = await rpcCall("eth_getBlockByNumber", [blockHex, false]);
  const timestamp = block?.timestamp
    ? new Date(Number.parseInt(block.timestamp, 16) * 1000).toISOString()
    : new Date().toISOString();
  cache.set(blockHex, timestamp);
  return timestamp;
}

async function resolveFactoryStartBlock(factoryAddress, tokens) {
  const metadataKey = `indexer:start:${String(factoryAddress || "").toLowerCase()}`;
  const stored = getMetadataValue(metadataKey);
  if (stored) {
    return Number(stored);
  }

  let earliestBlock = Number.POSITIVE_INFINITY;
  const creationHashes = tokens
    .map(token => String(token.creationTxHash || "").trim())
    .filter(Boolean);

  for (const hash of creationHashes) {
    try {
      const receipt = await rpcCall("eth_getTransactionReceipt", [hash]);
      if (receipt?.blockNumber) {
        const block = Number.parseInt(receipt.blockNumber, 16);
        if (Number.isFinite(block)) {
          earliestBlock = Math.min(earliestBlock, block);
        }
      }
    } catch {
      // Ignore per-tx receipt lookup failures and fall back below.
    }
  }

  let startBlock = 0;
  if (Number.isFinite(earliestBlock)) {
    startBlock = Math.max(earliestBlock - 1, 0);
  } else {
    try {
      const latestHex = await rpcCall("eth_blockNumber", []);
      const latest = Number.parseInt(latestHex, 16);
      startBlock = Math.max(latest - 5000, 0);
    } catch {
      startBlock = 0;
    }
  }

  setMetadataValue(metadataKey, String(startBlock));
  return startBlock;
}

function applySyncedTradeToMarket(market, token, syncedTrade) {
  const normalizedSide = syncedTrade.side === "SELL" ? "SELL" : "BUY";
  const normalizedAddress = sanitizeAddress(syncedTrade.traderAddress);
  const wallet = normalizedAddress ? ensureWalletRecord(market, normalizedAddress) : null;
  const existingTrade = (Array.isArray(token.tradeHistory) ? token.tradeHistory : []).some(item => String(item.txHash || "") === String(syncedTrade.txHash || ""));

  if (existingTrade) {
    return false;
  }

  if (wallet) {
    if (normalizedSide === "BUY") {
      wallet.tokenBalances[token.id] = Number(((wallet.tokenBalances[token.id] || 0) + Number(syncedTrade.amountToken || 0)).toFixed(6));
    } else {
      wallet.tokenBalances[token.id] = Number(Math.max(0, (wallet.tokenBalances[token.id] || 0) - Number(syncedTrade.amountToken || 0)).toFixed(6));
    }
  }

  if (!token.pool) {
    token.pool = {};
  }

  token.pool.rloReserve = Number(Number(syncedTrade.actualRloReserve || 0).toFixed(6));
  token.pool.virtualRloReserve = Number(Number(syncedTrade.virtualRloReserve || 0).toFixed(6));
  token.pool.tokenReserve = Number(Number(syncedTrade.virtualTokenReserve || 0).toFixed(6));
  token.pool.virtualTokenReserve = Number(Number(syncedTrade.virtualTokenReserve || 0).toFixed(6));
  token.pool.feeBps = Number(token.pool.feeBps || DEFAULT_FEE_BPS);

  token.tradeHistory.push({
    side: normalizedSide,
    amountRlo: Number(Number(syncedTrade.amountRlo || 0).toFixed(6)),
    amountToken: Number(Number(syncedTrade.amountToken || 0).toFixed(6)),
    price: getSpotPrice(token),
    executionPrice: Number(Number(syncedTrade.executionPrice || 0).toFixed(6)),
    traderAddress: normalizedAddress,
    txHash: String(syncedTrade.txHash || ""),
    timestamp: syncedTrade.timestamp || new Date().toISOString()
  });

  token.price = getSpotPrice(token);
  token.volume = Number((Number(token.volume || 0) + Number(syncedTrade.amountRlo || 0)).toFixed(6));
  return true;
}

async function syncFactoryTrades(factoryAddress, market) {
  const normalizedFactory = sanitizeAddress(factoryAddress);
  if (!normalizedFactory) {
    return 0;
  }

  const factoryTokens = (Array.isArray(market.tokens) ? market.tokens : []).filter(token =>
    sanitizeAddress(token.factoryAddress).toLowerCase() === normalizedFactory.toLowerCase()
      && token.pool?.mode !== "virtual"
  );

  if (!factoryTokens.length) {
    return 0;
  }

  const tokenByAddress = new Map(
    factoryTokens
      .map(token => [sanitizeAddress(token.tokenAddress).toLowerCase(), token])
      .filter(([tokenAddress]) => tokenAddress)
  );

  const syncKey = `indexer:lastTradeBlock:${normalizedFactory.toLowerCase()}`;
  const lastSynced = Number(getMetadataValue(syncKey) || "");
  const latestHex = await rpcCall("eth_blockNumber", []);
  const latestBlock = Number.parseInt(latestHex, 16);
  const fromBlock = Number.isFinite(lastSynced) && lastSynced > 0
    ? lastSynced + 1
    : await resolveFactoryStartBlock(normalizedFactory, factoryTokens);

  if (!Number.isFinite(latestBlock) || fromBlock > latestBlock) {
    setMetadataValue(syncKey, String(Math.max(0, latestBlock || 0)));
    return 0;
  }

  const logs = await rpcCall("eth_getLogs", [{
    address: normalizedFactory,
    fromBlock: toRpcHex(fromBlock),
    toBlock: toRpcHex(latestBlock),
    topics: [TRADE_EXECUTED_TOPIC]
  }]);

  const blockTimestampCache = new Map();
  let inserted = 0;

  for (const log of Array.isArray(logs) ? logs : []) {
    const tokenAddress = decodeTopicAddress(log?.topics?.[2]).toLowerCase();
    const token = tokenByAddress.get(tokenAddress);
    if (!token) {
      continue;
    }

    const words = decodeStaticWords(log.data);
    if (words.length < 6) {
      continue;
    }

    const syncedTrade = {
      side: decodeTopicBool(log?.topics?.[3]) ? "BUY" : "SELL",
      traderAddress: decodeTopicAddress(log?.topics?.[1]),
      amountRlo: hexWordToNumber(words[0]),
      amountToken: hexWordToNumber(words[1]),
      executionPrice: hexWordToNumber(words[2]),
      actualRloReserve: hexWordToNumber(words[3]),
      virtualRloReserve: hexWordToNumber(words[4]),
      virtualTokenReserve: hexWordToNumber(words[5]),
      txHash: String(log.transactionHash || ""),
      timestamp: await getBlockTimestampMemo(log.blockNumber, blockTimestampCache)
    };

    if (applySyncedTradeToMarket(market, token, syncedTrade)) {
      inserted += 1;
    }
  }

  setMetadataValue(syncKey, String(Math.max(latestBlock, fromBlock)));
  return inserted;
}

async function syncFactoryPools(factoryAddress, market) {
  const normalizedFactory = sanitizeAddress(factoryAddress);
  if (!normalizedFactory) {
    return 0;
  }

  const tokens = (Array.isArray(market.tokens) ? market.tokens : []).filter(token =>
    sanitizeAddress(token.factoryAddress).toLowerCase() === normalizedFactory.toLowerCase()
      && sanitizeAddress(token.tokenAddress)
      && token.pool?.mode !== "virtual"
  );
  let updated = 0;

  for (const token of tokens) {
    const callData = encodeAddressCall(GET_POOL_SELECTOR, token.tokenAddress);
    if (!callData) continue;

    const result = await rpcCall("eth_call", [{ to: normalizedFactory, data: callData }, "latest"]);
    const words = decodeStaticWords(result);
    if (words.length < 6) continue;

    const actualRloReserve = hexWordToNumber(words[1]);
    const virtualRloReserve = hexWordToNumber(words[2]);
    const virtualTokenReserve = hexWordToNumber(words[3]);
    const feeBps = Number(hexToBigInt(words[4]));

    if (!token.pool) token.pool = {};
    const nextPool = {
      rloReserve: Number(actualRloReserve.toFixed(6)),
      virtualRloReserve: Number(virtualRloReserve.toFixed(6)),
      tokenReserve: Number(virtualTokenReserve.toFixed(6)),
      virtualTokenReserve: Number(virtualTokenReserve.toFixed(6)),
      feeBps
    };
    const changed = Object.entries(nextPool).some(([key, value]) => Number(token.pool[key] || 0) !== value);
    if (!changed) continue;

    token.pool = { ...token.pool, ...nextPool };
    token.seedLiquidityRlo = nextPool.rloReserve;
    token.price = getSpotPrice(token);
    updated += 1;
  }

  return updated;
}

async function syncMarketFromChain() {
  if (indexerState.running) {
    return;
  }

  indexerState.running = true;
  try {
    const market = readMarket();
    const factories = [...new Set(
      (Array.isArray(market.tokens) ? market.tokens : [])
        .map(token => sanitizeAddress(token.factoryAddress))
        .filter(Boolean)
    )];

    indexerState.lastFactories = factories.length;
    let insertedTrades = 0;
    let updatedPools = 0;

    for (const factoryAddress of factories) {
      insertedTrades += await syncFactoryTrades(factoryAddress, market);
      updatedPools += await syncFactoryPools(factoryAddress, market);
    }

    if (insertedTrades > 0 || updatedPools > 0) {
      writeMarket(market);
    }

    indexerState.lastSyncAt = new Date().toISOString();
    indexerState.lastError = "";
    setMetadataValue("indexer:lastSyncAt", indexerState.lastSyncAt);
    setMetadataValue("indexer:lastError", "");
  } catch (error) {
    indexerState.lastError = error.message || "Indexer sync failed";
    setMetadataValue("indexer:lastError", indexerState.lastError);
  } finally {
    indexerState.running = false;
  }
}

function startChainIndexer() {
  setTimeout(() => {
    syncMarketFromChain().catch(() => {});
  }, 1500);

  setInterval(() => {
    syncMarketFromChain().catch(() => {});
  }, INDEXER_POLL_MS);
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(data));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8"
  });
  res.end(text);
}

function notFound(res) {
  sendJson(res, 404, { error: "Not found" });
}

// The meme image of a launched token travels inside the JSON body as a base64
// data URL, so the cap has to leave room for the 2 MB the upload form accepts
// (~2.7 MB once base64-encoded) plus the rest of the payload.
const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const fail = error => {
      if (settled) return;
      settled = true;

      // Drain the rest of the upload instead of calling req.destroy(): destroying
      // the socket kills the connection before the route can answer, and the
      // browser surfaces that as a bare "Failed to fetch" with no status code to
      // explain what went wrong.
      req.resume();
      reject(error);
    };

    req.on("data", chunk => {
      if (settled) return;

      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        const error = new Error(
          `Request body too large (limit ${Math.floor(MAX_JSON_BODY_BYTES / (1024 * 1024))} MB).`
        );
        error.statusCode = 413;
        fail(error);
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;

      const body = Buffer.concat(chunks).toString("utf8");
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        const error = new Error("Invalid JSON body");
        error.statusCode = 400;
        reject(error);
      }
    });

    req.on("error", fail);
  });
}

function containsArabicText(value) {
  return /[\u0600-\u06FF]/.test(String(value || ""));
}

function summarizeAiContext(context = {}) {
  const pageMap = {
    market: "Rialo Market",
    nft: "NFT Collection",
    groups: "Group Ranking",
    bracket: "Bracket",
    home: "Home"
  };

  return {
    page: pageMap[String(context.activePage || "home")] || "Home",
    walletStatus: context.walletStatus === "connected" ? "connected" : "disconnected",
    walletAddress: sanitizeAddress(context.walletAddress || ""),
    activeTokenName: sanitizeString(context.activeTokenName || "", 80),
    activeTokenSymbol: sanitizeString(context.activeTokenSymbol || "", 40),
    nftMode: String(context.nftMode || "collection"),
    bracketGenerated: Boolean(context.bracketGenerated),
    madePicks: Math.max(0, Number(context.madePicks || 0)),
    completedGroups: Math.max(0, Number(context.completedGroups || 0))
  };
}

function buildLocalAiReply(message, contextSummary) {
  const text = String(message || "").trim();
  const lower = text.toLowerCase();
  const arabic = containsArabicText(text);

  const reply = (...lines) => lines.join(arabic ? "\n\n" : "\n\n");

  if (/wallet|Ù…Ø­ÙØ¸|metamask|megaeth|connect/i.test(lower)) {
    return reply(
      arabic
        ? `Ø£Ù†Øª Ø§Ù„Ø¢Ù† Ø¯Ø§Ø®Ù„ ${contextSummary.page}. Ø¥Ø°Ø§ ÙƒØ§Ù†Øª Ø§Ù„Ù…Ø­ÙØ¸Ø© ${contextSummary.walletStatus === "connected" ? "Ù…ØªØµÙ„Ø©" : "ØºÙŠØ± Ù…ØªØµÙ„Ø©"} ÙØ§Ø¨Ø¯Ø£ Ù…Ù† Ø²Ø± Connect Wallet Ø£Ø¹Ù„Ù‰ Ø§Ù„ÙˆØ§Ø¬Ù‡Ø©.`
        : `You are currently on ${contextSummary.page}. Your wallet is ${contextSummary.walletStatus}. Start from the Connect Wallet button at the top.`,
      arabic
        ? `Ø£ÙŠ Ø¹Ù…Ù„ÙŠØ© Ø´Ø±Ø§Ø¡ Ø£Ùˆ Ø¨ÙŠØ¹ Ø£Ùˆ listing Ø­Ù‚ÙŠÙ‚ÙŠØ© ØªØ­ØªØ§Ø¬ ØªØ£ÙƒÙŠØ¯ Ù…Ù† MetaMask Ø¹Ù„Ù‰ MegaETH testnet.`
        : `Any real buy, sell, or listing action needs MetaMask confirmation on MegaETH testnet.`
    );
  }

  if (/slippage|Ø§Ù†Ø²Ù„Ø§Ù‚/i.test(lower)) {
    return reply(
      arabic
        ? `Ø§Ù„Ù€ slippage Ù‡Ù†Ø§ Ù„ÙŠØ³ Ù…Ø¬Ø±Ø¯ Ø±Ù‚Ù… ÙˆØ§Ø¬Ù‡Ø©. Ù„Ù„ØªÙˆÙƒÙ†Ø§Øª Ø§Ù„Ø¬Ø¯ÙŠØ¯Ø© Ù†Ø­Ù† Ù†Ù…Ø±Ø± Ø­Ø¯ÙˆØ¯ Ø§Ù„Ø­Ù…Ø§ÙŠØ© Ø¯Ø§Ø®Ù„ Ø§Ù„Ù…Ø¹Ø§Ù…Ù„Ø© Ù†ÙØ³Ù‡Ø§ØŒ Ù„Ø°Ù„Ùƒ Ø¥Ø°Ø§ ØªØ­Ø±Ùƒ Ø§Ù„Ø³Ø¹Ø± Ø£ÙƒØ«Ø± Ù…Ù† Ø§Ù„Ù…Ø³Ù…ÙˆØ­ ØªÙØ´Ù„ Ø§Ù„Ø¹Ù…Ù„ÙŠØ© Ø¨Ø¯Ù„ Ø£Ù† ØªÙ†ÙØ° Ø¨Ø³Ø¹Ø± Ø³ÙŠØ¦.`
        : `Slippage here is not just a display number. For the newer token flow we pass protection limits into the transaction, so if price moves too far the transaction fails instead of filling badly.`,
      arabic
        ? `Ø§Ø®ØªØ± Ù†Ø³Ø¨Ø© Ø£ØµØºØ± Ø¥Ø°Ø§ ÙƒÙ†Øª ØªØ±ÙŠØ¯ Ø­Ù…Ø§ÙŠØ© Ø£ÙƒØ¨Ø±ØŒ Ù„ÙƒÙ† Ù‡Ø°Ø§ Ù‚Ø¯ ÙŠØ³Ø¨Ø¨ ÙØ´Ù„Ù‹Ø§ Ø£ÙƒØ«Ø± Ù„Ù„ØµÙÙ‚Ø§Øª Ø£Ø«Ù†Ø§Ø¡ Ø§Ù„ØªØ­Ø±Ùƒ Ø§Ù„Ø³Ø±ÙŠØ¹.`
        : `Choose a smaller percentage for tighter protection, but expect more failed trades during fast moves.`
    );
  }

  if (/nft|collection|items|list|listing|sell nft|buy listed|ÙƒØ±ÙŠØ³ØªÙŠØ§Ù†Ùˆ|Ø±ÙˆÙ†Ø§Ù„Ø¯Ùˆ/i.test(lower)) {
    return reply(
      arabic
        ? `Ø¯Ø§Ø®Ù„ NFT Collection: ØªØ¨ÙˆÙŠØ¨ Collection Ù„Ù„Ù…Ø´ØªØ±ÙŠØŒ ÙˆØªØ¨ÙˆÙŠØ¨ Items Ù„Ù„Ù…Ø§Ù„Ùƒ. Ø¹Ù†Ø¯Ù…Ø§ ØªØ¹Ù…Ù„ listing Ù…Ù† ItemsØŒ ØªØ¸Ù‡Ø± Ø§Ù„Ø¨Ø·Ø§Ù‚Ø© Ù†ÙØ³Ù‡Ø§ ÙÙŠ Collection Ø¨Ø§Ù„Ø³Ø¹Ø± Ø§Ù„Ø°ÙŠ ÙˆØ¶Ø¹ØªÙ‡.`
        : `Inside NFT Collection: Collection is for buyers, and Items is for owners. When you list from Items, that NFT appears in Collection at the price you set.`,
      arabic
        ? `Owned ÙŠØ¬Ø¨ Ø£Ù† ÙŠØ¹ÙƒØ³ Ø§Ù„ÙƒÙ…ÙŠØ© Ø§Ù„Ù…ÙˆØ¬ÙˆØ¯Ø© ÙØ¹Ù„ÙŠÙ‹Ø§ ÙÙŠ Ø§Ù„Ù…Ø­ÙØ¸Ø©ØŒ ÙˆListed ÙŠØ¹ÙƒØ³ Ø§Ù„ÙƒÙ…ÙŠØ© Ø§Ù„Ù…Ø¹Ø±ÙˆØ¶Ø© Ù„Ù„Ø¨ÙŠØ¹.`
        : `Owned should reflect the quantity actually in the wallet, while Listed reflects the quantity currently for sale.`
    );
  }

  if (/token|create|launch|market/i.test(lower)) {
    return reply(
      arabic
        ? `Ø¯Ø§Ø®Ù„ Rialo Market ÙŠÙ…ÙƒÙ†Ùƒ Ø¥Ù†Ø´Ø§Ø¡ ØªÙˆÙƒÙ† Ø¬Ø¯ÙŠØ¯ØŒ Ø´Ø±Ø§Ø¡Ù‡ØŒ Ø¨ÙŠØ¹Ù‡ØŒ ÙˆÙ…ØªØ§Ø¨Ø¹Ø© Ø§Ù„Ø´Ù…ÙˆØ¹. Ø¥Ø°Ø§ ÙƒÙ†Øª Ø¹Ù„Ù‰ ØµÙØ­Ø© ØªÙˆÙƒÙ† Ø§Ù„Ø¢Ù† ÙØ§Ù„ØªÙˆÙƒÙ† Ø§Ù„Ù†Ø´Ø· Ù‡Ùˆ ${contextSummary.activeTokenName || "ØºÙŠØ± Ù…Ø­Ø¯Ø¯"} ${contextSummary.activeTokenSymbol || ""}.`
        : `Inside Rialo Market you can create a new token, buy it, sell it, and follow the candles. If you are on a token page now, the active token is ${contextSummary.activeTokenName || "not specified"} ${contextSummary.activeTokenSymbol || ""}.`,
      arabic
        ? `Ø¥Ø°Ø§ Ø£Ø±Ø¯Øª Ù…Ø³Ø§Ø¹Ø¯Ø© Ø¹Ù…Ù„ÙŠØ©ØŒ Ø§ÙƒØªØ¨ Ù„ÙŠ Ù…Ø«Ù„Ù‹Ø§: ÙƒÙŠÙ Ø£Ø´ØªØ±ÙŠØŸ ÙƒÙŠÙ Ø£Ø¨ÙŠØ¹ØŸ Ù…Ø§ Ù…Ø¹Ù†Ù‰ Pool RLOØŸ`
        : `For practical help, ask things like: how do I buy, how do I sell, or what does Pool RLO mean?`
    );
  }

  if (/group|bracket|prediction|world cup|groups|champion|Ù…Ø¬Ù…ÙˆØ¹Ø§Øª|Ø¨Ø±Ø§ÙƒÙŠØª|ØªÙˆÙ‚Ø¹/i.test(lower)) {
    return reply(
      arabic
        ? `ÙÙŠ ÙˆØ¶Ø¹ Ø§Ù„ØªÙˆÙ‚Ø¹Ø§Øª: Ø§Ù„Ù…Ø¬Ù…ÙˆØ¹Ø§Øª Ø§Ù„Ù…ÙƒØªÙ…Ù„Ø© Ø§Ù„Ø¢Ù† ${contextSummary.completedGroups}/12ØŒ ÙˆØ¹Ø¯Ø¯ Ø§Ù„Ø§Ø®ØªÙŠØ§Ø±Ø§Øª Ø§Ù„Ø­Ø§Ù„ÙŠØ© ${contextSummary.madePicks}.`
        : `In prediction mode: completed groups are ${contextSummary.completedGroups}/12, and current picks are ${contextSummary.madePicks}.`,
      arabic
        ? `Ø§Ø¨Ø¯Ø£ Ø¨ØªØ±ØªÙŠØ¨ Ø§Ù„Ù…Ø¬Ù…ÙˆØ¹Ø§ØªØŒ Ø«Ù… Ø£Ù†Ø´Ø¦ Ø§Ù„Ù€ bracketØŒ Ø«Ù… Ø§Ø®ØªØ± Ø§Ù„Ø¨Ø·Ù„ØŒ Ø«Ù… Ù‚Ø¯Ù‘Ù… Ø§Ù„ØªÙˆÙ‚Ø¹ Ø¨Ø¹Ø¯ Ø±Ø¨Ø· Ø§Ù„Ù…Ø­ÙØ¸Ø©.`
        : `Start by ranking groups, then generate the bracket, then choose the champion, and finally submit after connecting the wallet.`
    );
  }

  return reply(
    arabic
      ? `Ø£Ù†Ø§ Ù…Ø³Ø§Ø¹Ø¯ Rialo Ø¯Ø§Ø®Ù„ Ø§Ù„Ù…ÙˆÙ‚Ø¹. Ø£Ù‚Ø¯Ø± Ø£Ø´Ø±Ø­ Ù„Ùƒ Ø§Ù„Ø³ÙˆÙ‚ØŒ Ø§Ù„Ù€ NFTsØŒ Ø§Ù„Ù€ walletØŒ Ø§Ù„ØªÙˆÙ‚Ø¹Ø§ØªØŒ Ø£Ùˆ Ø®Ø·ÙˆØ§Øª Ø£ÙŠ Ø¹Ù…Ù„ÙŠØ© ØªØ±ÙŠØ¯Ù‡Ø§.`
      : `I'm the Rialo in-app assistant. I can explain the market, NFTs, wallet flow, predictions, or the steps behind any action you want.`,
    arabic
      ? `Ø§ÙƒØªØ¨ Ø³Ø¤Ø§Ù„Ùƒ Ù…Ø¨Ø§Ø´Ø±Ø© ÙˆØ³Ø£Ø¬Ø§ÙˆØ¨Ùƒ Ø­Ø³Ø¨ Ø§Ù„ØµÙØ­Ø© Ø§Ù„ØªÙŠ Ø£Ù†Øª ÙÙŠÙ‡Ø§ Ø§Ù„Ø¢Ù†: ${contextSummary.page}.`
      : `Ask directly and I'll answer based on the page you are currently on: ${contextSummary.page}.`
  );
}

async function requestAiChat(message, contextSummary) {
  if (!AI_API_KEY) {
    return null;
  }

  const prompt = [
    "You are Rialo Helper, a concise in-product assistant inside a Web3 sports + meme market app.",
    "Be practical, brief, and helpful.",
    "Use the current UI context when it matters.",
    "If the user asks a general question unrelated to the app, answer it normally and clearly instead of forcing the topic back to Rialo.",
    `Current page: ${contextSummary.page}`,
    `Wallet status: ${contextSummary.walletStatus}`,
    `Wallet address: ${contextSummary.walletAddress || "not connected"}`,
    `Active token: ${contextSummary.activeTokenName || "none"} ${contextSummary.activeTokenSymbol || ""}`.trim(),
    `NFT tab mode: ${contextSummary.nftMode}`,
    `Bracket generated: ${contextSummary.bracketGenerated ? "yes" : "no"}`,
    `Completed groups: ${contextSummary.completedGroups}`,
    `Made picks: ${contextSummary.madePicks}`,
    "",
    `User message: ${message}`
  ].join("\n");

  const usesGeminiGenerateContent = /generativelanguage\.googleapis\.com\/.*:generateContent/i.test(AI_API_URL);
  const usesChatCompletions = /\/chat\/completions\/?(?:\?|$)/i.test(AI_API_URL);
  const requestBody = usesGeminiGenerateContent
    ? {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 700 }
      }
    : usesChatCompletions
    ? {
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are Rialo Helper, a concise and helpful in-product assistant for a Web3 sports, NFT, prediction, and meme-market app."
          },
          { role: "user", content: prompt }
        ],
        max_tokens: 700
      }
    : {
        model: AI_MODEL,
        input: prompt
      };

  const response = await fetch(AI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(usesGeminiGenerateContent
        ? { "x-goog-api-key": AI_API_KEY }
        : { Authorization: `Bearer ${AI_API_KEY}` })
    },
    body: JSON.stringify(requestBody)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || "AI provider request failed");
  }

  const text =
    data?.candidates?.[0]?.content?.parts?.map(part => part?.text || "").filter(Boolean).join("\n") ||
    data?.choices?.[0]?.message?.content ||
    data?.output_text ||
    data?.output?.flatMap(item => Array.isArray(item.content) ? item.content : [])
      ?.map(item => item?.text || "")
      ?.filter(Boolean)
      ?.join("\n")
    || "";

  return String(text || "").trim();
}

function formatRelativeTime(timestamp) {
  const diffMs = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.max(1, Math.round(diffMs / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function toCompact(value) {
  const num = Number(value || 0);
  if (num > 0 && num < 1) return `${Number(num.toFixed(4))}`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1).replace(".0", "")}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1).replace(".0", "")}K`;
  return `${Math.round(num)}`;
}

function getSpotPrice(token) {
  if (token.pool && Number(token.pool.virtualTokenReserve || token.pool.tokenReserve || 0) > 0) {
    const rloReserve = Number(token.pool.virtualRloReserve || token.pool.rloReserve || 0);
    const tokenReserve = Number(token.pool.virtualTokenReserve || token.pool.tokenReserve || 1);
    return Number((rloReserve / tokenReserve).toFixed(6));
  }

  return Number(token.price || token.initialPrice || 0);
}

function getTrackedHolders(market, tokenId) {
  return Object.values(market.wallets || {}).filter(wallet => Number(wallet.tokenBalances?.[tokenId] || 0) > 0).length;
}

function normalizeTradeEntry(item, fallbackPrice) {
  const price = Number(item.price || item.executionPrice || fallbackPrice || 0.0001);
  const amountRlo = Number(item.amountRlo ?? item.amount ?? 0);
  const amountToken = Number(item.amountToken ?? (price > 0 ? amountRlo / price : 0));

  return {
    side: sanitizeString(item.side || "BUY", 8).toUpperCase(),
    amountRlo: Number(amountRlo.toFixed(6)),
    amountToken: Number(amountToken.toFixed(6)),
    price: Number(price.toFixed(6)),
    executionPrice: Number((Number(item.executionPrice || price || 0)).toFixed(6)),
    traderAddress: sanitizeAddress(item.traderAddress),
    txHash: sanitizeString(item.txHash || "", 120),
    timestamp: item.timestamp || new Date().toISOString()
  };
}

function buildRecentTrades(token) {
  const history = Array.isArray(token.tradeHistory) ? token.tradeHistory : [];
  const fallbackPrice = getSpotPrice(token);

  return history
    .map(item => normalizeTradeEntry(item, fallbackPrice))
    .filter(item => item.side !== "LIST")
    .slice(-8)
    .reverse()
    .map(item => ({
      side: item.side,
      amountRlo: Number(item.amountRlo.toFixed(2)),
      amountToken: Number(item.amountToken.toFixed(2)),
      traderAddress: item.traderAddress,
      txHash: item.txHash,
      price: item.price,
      executionPrice: item.executionPrice,
      time: formatRelativeTime(item.timestamp)
    }));
}

function buildViewerTrades(token, viewerAddress) {
  const normalizedViewer = sanitizeAddress(viewerAddress).toLowerCase();
  if (!normalizedViewer) {
    return [];
  }

  return (Array.isArray(token.tradeHistory) ? token.tradeHistory : [])
    .map(item => normalizeTradeEntry(item, getSpotPrice(token)))
    .filter(item => item.side !== "LIST" && String(item.traderAddress || "").toLowerCase() === normalizedViewer)
    .slice(-12)
    .reverse()
    .map(item => ({
      side: item.side,
      amountRlo: Number(item.amountRlo.toFixed(2)),
      amountToken: Number(item.amountToken.toFixed(2)),
      txHash: item.txHash,
      price: item.price,
      executionPrice: item.executionPrice,
      time: formatRelativeTime(item.timestamp)
    }));
}

function normalizeToken(token, market, viewerAddress = "", viewerSeedBalance = null) {
  const price = getSpotPrice(token);
  const supply = Number(token.supply || 0);
  const volume = Number(token.volume || 0);
  const trackedHolders = getTrackedHolders(market, token.id);
  const holders = Math.max(trackedHolders, Number(token.holders || 0));
  const tradeHistory = (Array.isArray(token.tradeHistory) ? token.tradeHistory : []).map(item => normalizeTradeEntry(item, price));
  const recentTrades = buildRecentTrades(token);
  const mcap = Number((price * supply).toFixed(4));
  const safeViewerSeed = sanitizeBalanceSeed(viewerSeedBalance);
  const viewerWallet = viewerAddress && market.wallets?.[viewerAddress.toLowerCase()]
    ? market.wallets[viewerAddress.toLowerCase()]
    : null;

  return {
    ...token,
    price,
    supply,
    volume,
    holders,
    mcap,
    tradeHistory,
    recentTrades,
    priceText: `${price.toFixed(4)} RLO`,
    mcapText: `${toCompact(mcap)} RLO`,
    volumeText: `${toCompact(volume)} RLO`,
    pool: token.pool || null,
    viewerTrades: buildViewerTrades(token, viewerAddress),
    viewer: viewerWallet ? {
      address: viewerAddress,
      rloBalance: Number(Number(viewerWallet.rloBalance || 0).toFixed(4)),
      tokenBalance: Number(Number(viewerWallet.tokenBalances?.[token.id] || 0).toFixed(4))
    } : (viewerAddress ? {
      address: viewerAddress,
      rloBalance: safeViewerSeed ?? DEFAULT_WALLET_RLO_BALANCE,
      tokenBalance: 0
    } : null)
  };
}

function buildViewerPositionStats(token, viewerAddress, currentBalance) {
  const normalizedViewer = sanitizeAddress(viewerAddress).toLowerCase();
  const normalizedTrades = (Array.isArray(token.tradeHistory) ? token.tradeHistory : [])
    .map(item => normalizeTradeEntry(item, getSpotPrice(token)))
    .filter(item => item.side !== "LIST" && String(item.traderAddress || "").toLowerCase() === normalizedViewer);

  let runningTokenBalance = 0;
  let runningCostBasisRlo = 0;

  normalizedTrades.forEach(trade => {
    if (trade.side === "BUY") {
      runningTokenBalance += Number(trade.amountToken || 0);
      runningCostBasisRlo += Number(trade.amountRlo || 0);
      return;
    }

    if (trade.side === "SELL") {
      const amountToken = Number(trade.amountToken || 0);
      const averageCost = runningTokenBalance > 0 ? runningCostBasisRlo / runningTokenBalance : 0;
      const relievedCost = averageCost * Math.min(amountToken, runningTokenBalance);
      runningTokenBalance = Math.max(0, runningTokenBalance - amountToken);
      runningCostBasisRlo = Math.max(0, runningCostBasisRlo - relievedCost);
    }
  });

  const effectiveBalance = Math.max(0, Number(currentBalance || 0));
  const fallbackAverage = Number(token.initialPrice || token.price || 0);
  const averageEntryRlo = effectiveBalance > 0
    ? Number(((runningCostBasisRlo > 0 ? runningCostBasisRlo / effectiveBalance : fallbackAverage) || 0).toFixed(6))
    : 0;
  const costBasisRlo = Number((averageEntryRlo * effectiveBalance).toFixed(6));
  const currentValueRlo = Number((effectiveBalance * getSpotPrice(token)).toFixed(6));
  const unrealizedPnlRlo = Number((currentValueRlo - costBasisRlo).toFixed(6));
  const unrealizedPnlPct = costBasisRlo > 0
    ? Number((((currentValueRlo - costBasisRlo) / costBasisRlo) * 100).toFixed(2))
    : 0;

  return {
    averageEntryRlo,
    costBasisRlo,
    currentValueRlo,
    unrealizedPnlRlo,
    unrealizedPnlPct
  };
}

function buildPortfolio(market, viewerAddress = "", viewerSeedBalance = null) {
  const normalizedViewer = sanitizeAddress(viewerAddress).toLowerCase();
  const safeViewerSeed = sanitizeBalanceSeed(viewerSeedBalance);

  if (!normalizedViewer) {
    return {
      viewerAddress: "",
      walletRloBalance: safeViewerSeed ?? 0,
      totalTokenValueRlo: 0,
      totalPortfolioValueRlo: safeViewerSeed ?? 0,
      unrealizedPnlRlo: 0,
      positionsCount: 0,
      positions: [],
      trades: [],
      syncedAt: new Date().toISOString()
    };
  }

  const wallet = market.wallets?.[normalizedViewer] || null;
  const displayedWalletRlo = safeViewerSeed ?? Number(wallet?.rloBalance || DEFAULT_WALLET_RLO_BALANCE);
  const visibleTokens = Array.isArray(market.tokens) ? market.tokens : [];

  const positions = visibleTokens
    .map(token => {
      const balance = Number(wallet?.tokenBalances?.[token.id] || 0);
      if (balance <= 0) {
        return null;
      }

      const normalizedToken = normalizeToken(token, market);
      const positionStats = buildViewerPositionStats(token, normalizedViewer, balance);

      return {
        tokenId: token.id,
        name: token.name,
        symbol: token.symbol,
        imageUrl: token.imageUrl || "",
        tokenAddress: token.tokenAddress || "",
        priceRlo: normalizedToken.price,
        balance: Number(balance.toFixed(6)),
        valueRlo: positionStats.currentValueRlo,
        averageEntryRlo: positionStats.averageEntryRlo,
        costBasisRlo: positionStats.costBasisRlo,
        unrealizedPnlRlo: positionStats.unrealizedPnlRlo,
        unrealizedPnlPct: positionStats.unrealizedPnlPct
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.valueRlo - a.valueRlo);

  const trades = visibleTokens
    .flatMap(token => (Array.isArray(token.tradeHistory) ? token.tradeHistory : []).map(item => ({
      tokenId: token.id,
      tokenName: token.name,
      tokenSymbol: token.symbol,
      ...normalizeTradeEntry(item, getSpotPrice(token))
    })))
    .filter(item => item.side !== "LIST" && String(item.traderAddress || "").toLowerCase() === normalizedViewer)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 16)
    .map(item => ({
      tokenId: item.tokenId,
      tokenName: item.tokenName,
      tokenSymbol: item.tokenSymbol,
      side: item.side,
      amountRlo: Number(item.amountRlo.toFixed(2)),
      amountToken: Number(item.amountToken.toFixed(2)),
      executionPrice: item.executionPrice,
      txHash: item.txHash,
      time: formatRelativeTime(item.timestamp),
      timestamp: item.timestamp
    }));

  const totalTokenValueRlo = Number(positions.reduce((sum, position) => sum + Number(position.valueRlo || 0), 0).toFixed(6));
  const unrealizedPnlRlo = Number(positions.reduce((sum, position) => sum + Number(position.unrealizedPnlRlo || 0), 0).toFixed(6));

  return {
    viewerAddress: normalizedViewer,
    walletRloBalance: Number(displayedWalletRlo.toFixed(6)),
    totalTokenValueRlo,
    totalPortfolioValueRlo: Number((displayedWalletRlo + totalTokenValueRlo).toFixed(6)),
    unrealizedPnlRlo,
    positionsCount: positions.length,
    positions,
    trades,
    syncedAt: new Date().toISOString()
  };
}

function normalizeNftListingIdentity(db) {
  // Older builds stored the seller address with the wallet's checksum casing, so the
  // same wallet could own two rows for one card ("0xAb..." and "0xab..."). Cancelling
  // then only cleared one of them and the listing kept coming back in the UI.
  const rows = db.prepare(`
    SELECT rowid AS id, code, seller_address, amount, status
    FROM nft_listings
    ORDER BY datetime(updated_at) DESC, id DESC
  `).all();

  const groups = new Map();
  rows.forEach(row => {
    const code = String(row.code || "").toLowerCase();
    const sellerAddress = String(row.seller_address || "").toLowerCase();
    const key = `${code}:${sellerAddress}`;

    if (!groups.has(key)) {
      groups.set(key, { code, sellerAddress, rows: [] });
    }

    groups.get(key).rows.push(row);
  });

  const deleteRow = db.prepare(`DELETE FROM nft_listings WHERE rowid = @id`);
  const updateRow = db.prepare(`
    UPDATE nft_listings
    SET code = @code,
        seller_address = @sellerAddress,
        amount = @amount,
        status = @status
    WHERE rowid = @id
  `);

  groups.forEach(group => {
    const activeRows = group.rows.filter(row => String(row.status || "") === "ACTIVE");
    const primary = activeRows[0] || group.rows[0];
    const duplicates = group.rows.filter(row => row.id !== primary.id);
    const needsRewrite = duplicates.length > 0 ||
      primary.code !== group.code ||
      primary.seller_address !== group.sellerAddress;

    if (!needsRewrite) {
      return;
    }

    const mergedAmount = activeRows.length
      ? activeRows.reduce((sum, row) => sum + Math.max(0, Math.floor(Number(row.amount || 0))), 0)
      : Math.max(0, Math.floor(Number(primary.amount || 0)));
    const mergedStatus = activeRows.length
      ? (mergedAmount > 0 ? "ACTIVE" : "CANCELLED")
      : String(primary.status || "CANCELLED");

    // Duplicates go first so the UNIQUE (code, seller_address) index stays satisfied.
    duplicates.forEach(row => deleteRow.run({ id: row.id }));
    updateRow.run({
      id: primary.id,
      code: group.code,
      sellerAddress: group.sellerAddress,
      amount: mergedAmount,
      status: mergedStatus
    });
  });
}

function listActiveNftListings() {
  const db = getMarketDb();
  return db.prepare(`
    SELECT code, token_id, seller_address, amount, price_rlo, marketplace_address, tx_hash, created_at, updated_at
    FROM nft_listings
    WHERE status = 'ACTIVE' AND amount > 0
    ORDER BY price_rlo ASC, datetime(updated_at) DESC
  `).all().map(row => ({
    code: row.code,
    tokenId: Number(row.token_id || 0),
    sellerAddress: row.seller_address,
    amount: Number(row.amount || 0),
    priceRlo: Number(row.price_rlo || 0),
    marketplaceAddress: row.marketplace_address || "",
    txHash: row.tx_hash || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

const PROTECTED_NFT_CODES = new Set(["ade", "eric-spider"]);

function createOrUpdateNftListing(payload) {
  const code = sanitizeString(payload.code, 32).toLowerCase();
  const tokenId = Number(payload.tokenId || 0);
  const sellerAddress = sanitizeAddress(payload.sellerAddress).toLowerCase();
  const amount = Math.max(1, Math.floor(Number(payload.amount || 0)));
  const priceRlo = sanitizeBalanceSeed(payload.priceRlo);
  const marketplaceAddress = sanitizeAddress(payload.marketplaceAddress).toLowerCase();
  const txHash = sanitizeString(payload.txHash || "", 120);
  const now = new Date().toISOString();

  if (!code) {
    return { error: "NFT code is required." };
  }

  if (PROTECTED_NFT_CODES.has(code)) {
    return { error: "This permanent Rialo team NFT cannot be listed or sold." };
  }

  if (!sellerAddress) {
    return { error: "Wallet confirmation is required to list this NFT." };
  }

  if (!Number.isFinite(tokenId) || tokenId <= 0) {
    return { error: "NFT token id is invalid." };
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: "Listing amount must be at least 1." };
  }

  if (priceRlo === null || priceRlo <= 0) {
    return { error: "Listing price must be greater than 0 RLO." };
  }

  if (!marketplaceAddress) {
    return { error: "NFT marketplace contract address is required." };
  }

  const db = getMarketDb();
  db.prepare(`
    INSERT INTO nft_listings (
      code, token_id, seller_address, amount, price_rlo, marketplace_address, tx_hash, status, created_at, updated_at
    ) VALUES (
      @code, @tokenId, @sellerAddress, @amount, @priceRlo, @marketplaceAddress, @txHash, 'ACTIVE', @createdAt, @updatedAt
    )
    ON CONFLICT(code, seller_address) DO UPDATE SET
      token_id = excluded.token_id,
      amount = excluded.amount,
      price_rlo = excluded.price_rlo,
      marketplace_address = excluded.marketplace_address,
      tx_hash = excluded.tx_hash,
      status = 'ACTIVE',
      updated_at = excluded.updated_at
  `).run({
    code,
    tokenId,
    sellerAddress,
    amount,
    priceRlo,
    marketplaceAddress,
    txHash,
    createdAt: now,
    updatedAt: now
  });

  return {
    listing: {
      code,
      tokenId,
      sellerAddress,
      amount,
      priceRlo,
      marketplaceAddress,
      txHash,
      createdAt: now,
      updatedAt: now
    }
  };
}

function cancelNftListing(payload) {
  const code = sanitizeString(payload.code, 32).toLowerCase();
  const sellerAddress = sanitizeAddress(payload.sellerAddress).toLowerCase();
  const txHash = sanitizeString(payload.txHash || "", 120);
  const hasAmount = payload.amount !== undefined && payload.amount !== null && String(payload.amount).trim() !== "";
  const requestedAmount = hasAmount ? Math.floor(Number(payload.amount)) : 0;

  if (!code || !sellerAddress) {
    return { error: "Listing code and seller wallet are required." };
  }

  if (hasAmount && (!Number.isFinite(requestedAmount) || requestedAmount <= 0)) {
    return { error: "Cancel amount is invalid." };
  }

  const db = getMarketDb();
  const activeListing = db.prepare(`
    SELECT id, amount, tx_hash
    FROM nft_listings
    WHERE code = ? AND lower(seller_address) = ? AND status = 'ACTIVE'
    ORDER BY datetime(updated_at) DESC, id DESC
    LIMIT 1
  `).get(code, sellerAddress);

  if (!activeListing) {
    return { error: "Active listing was not found for this wallet." };
  }

  const currentAmount = Math.max(0, Math.floor(Number(activeListing.amount || 0)));
  // No amount in the payload means "cancel the whole listing".
  const amount = hasAmount ? requestedAmount : currentAmount;

  if (amount > currentAmount) {
    return { error: `You only have ${currentAmount} listed item(s).` };
  }

  const nextAmount = currentAmount - amount;
  db.prepare(`
    UPDATE nft_listings
    SET amount = @amount,
        status = @status,
        updated_at = @updatedAt,
        tx_hash = CASE WHEN @txHash = '' THEN tx_hash ELSE @txHash END
    WHERE id = @id
  `).run({
    id: Number(activeListing.id || 0),
    amount: nextAmount,
    status: nextAmount > 0 ? "ACTIVE" : "CANCELLED",
    updatedAt: new Date().toISOString(),
    txHash
  });

  return {
    ok: true,
    code,
    sellerAddress,
    cancelledAmount: amount,
    remainingAmount: nextAmount
  };
}

function purchaseNftListing(payload) {
  const code = sanitizeString(payload.code, 32).toLowerCase();
  const sellerAddress = sanitizeAddress(payload.sellerAddress).toLowerCase();
  const amount = Math.max(1, Math.floor(Number(payload.amount || 0)));
  const txHash = sanitizeString(payload.txHash || "", 120);
  const updatedAt = new Date().toISOString();

  if (!code || !sellerAddress) {
    return { error: "Listing code and seller wallet are required." };
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: "Purchase amount is invalid." };
  }

  const db = getMarketDb();
  const current = db.prepare(`
    SELECT id, amount
    FROM nft_listings
    WHERE code = @code AND lower(seller_address) = @sellerAddress AND status = 'ACTIVE'
    ORDER BY datetime(updated_at) DESC, id DESC
    LIMIT 1
  `).get({
    code,
    sellerAddress
  });

  if (!current) {
    return { error: "Active listing was not found." };
  }

  const remaining = Number(current.amount || 0) - amount;
  if (remaining < 0) {
    return { error: "Listing amount is lower than the requested purchase." };
  }

  db.prepare(`
    UPDATE nft_listings
    SET amount = @remaining,
        status = CASE WHEN @remaining <= 0 THEN 'SOLD' ELSE 'ACTIVE' END,
        tx_hash = CASE WHEN @txHash = '' THEN tx_hash ELSE @txHash END,
        updated_at = @updatedAt
    WHERE id = @id
  `).run({
    id: Number(current.id || 0),
    remaining,
    txHash,
    updatedAt
  });

  return { ok: true };
}

function sanitizeString(value, maxLength = 140) {
  return String(value || "").trim().slice(0, maxLength);
}

function pruneExpiredCommunityChatMessages(db = getMarketDb()) {
  const expiresBefore = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`DELETE FROM community_chat_messages WHERE created_at < ?`).run(expiresBefore);
}

function sanitizeAddress(value) {
  const address = String(value || "").trim();
  return /^0x[a-fA-F0-9]{40}$/.test(address) ? address : "";
}

function sanitizeImageSource(value) {
  const input = String(value || "").trim();

  if (!input) {
    return "";
  }

  if (/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(input) && input.length <= 2_500_000) {
    return input;
  }

  if (/^https?:\/\/\S+$/i.test(input) && input.length <= 2048) {
    return input;
  }

  return "";
}

function isCommunityLaunchedToken(token) {
  return Boolean(
    token &&
    sanitizeAddress(token.creatorAddress) &&
    sanitizeAddress(token.tokenAddress) &&
    sanitizeAddress(token.factoryAddress)
  );
}

function sanitizeBalanceSeed(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }

  return Number(amount.toFixed(6));
}

function getWalletRecord(market, address) {
  const normalized = sanitizeAddress(address).toLowerCase();
  return normalized ? market.wallets?.[normalized] || null : null;
}

function ensureWalletRecord(market, address, seedRloBalance = null) {
  const normalized = sanitizeAddress(address).toLowerCase();
  if (!normalized) {
    return null;
  }

  if (!market.wallets || typeof market.wallets !== "object") {
    market.wallets = {};
  }

  const safeSeedBalance = sanitizeBalanceSeed(seedRloBalance);

  if (!market.wallets[normalized]) {
    market.wallets[normalized] = {
      address: normalized,
      rloBalance: safeSeedBalance ?? DEFAULT_WALLET_RLO_BALANCE,
      tokenBalances: {},
      createdAt: new Date().toISOString(),
      seededFromWallet: safeSeedBalance !== null
    };
  }

  if (!market.wallets[normalized].tokenBalances || typeof market.wallets[normalized].tokenBalances !== "object") {
    market.wallets[normalized].tokenBalances = {};
  }

  const wallet = market.wallets[normalized];

  if (
    safeSeedBalance !== null &&
    (!wallet.seededFromWallet || Number(wallet.rloBalance || 0) === DEFAULT_WALLET_RLO_BALANCE)
  ) {
    wallet.rloBalance = safeSeedBalance;
    wallet.seededFromWallet = true;
  }

  const currentRloBalance = Number(wallet.rloBalance);
  wallet.rloBalance = Number.isFinite(currentRloBalance) && currentRloBalance >= 0
    ? Number(currentRloBalance.toFixed(6))
    : (safeSeedBalance ?? DEFAULT_WALLET_RLO_BALANCE);
  return market.wallets[normalized];
}

function migrateMarket(market) {
  if (!market.wallets || typeof market.wallets !== "object") {
    market.wallets = {};
  }

  const visibleTokenIds = new Set();

  market.tokens = (market.tokens || [])
    .filter(isCommunityLaunchedToken)
    .map(token => {
    const supply = Number(token.supply || 0);
    const initialPrice = Number(token.initialPrice || token.price || 0.0001);

    token.tradeHistory = (Array.isArray(token.tradeHistory) ? token.tradeHistory : []).map(item => normalizeTradeEntry(item, initialPrice));
    token.creatorAddress = sanitizeAddress(token.creatorAddress);

    if (!token.pool) {
      const creatorAllocation = Number((supply * DEFAULT_CREATOR_SHARE).toFixed(6));
      const tokenReserve = Number(Math.max(supply - creatorAllocation, 1).toFixed(6));
      const rloReserve = Number((tokenReserve * initialPrice).toFixed(6));

      token.initialPrice = Number(initialPrice.toFixed(6));
      token.creatorAllocation = creatorAllocation;
      token.pool = {
        rloReserve: Math.max(Number(token.seedLiquidityRlo || 0), rloReserve),
        virtualRloReserve: rloReserve,
        tokenReserve,
        virtualTokenReserve: tokenReserve,
        feeBps: DEFAULT_FEE_BPS
      };
    } else {
      token.pool.virtualRloReserve = Number(token.pool.virtualRloReserve || token.pool.rloReserve || 0);
      token.pool.virtualTokenReserve = Number(token.pool.virtualTokenReserve || token.pool.tokenReserve || 0);
    }

    if (token.creatorAddress && Number(token.creatorAllocation || 0) > 0) {
      const creatorWallet = ensureWalletRecord(market, token.creatorAddress);
      if (creatorWallet && Number(creatorWallet.tokenBalances[token.id] || 0) <= 0) {
        creatorWallet.tokenBalances[token.id] = Number(token.creatorAllocation.toFixed(6));
      }
    }

    token.volume = Number(token.volume || 0);
    token.holders = Number(token.holders || 0);
    token.price = getSpotPrice(token);
    visibleTokenIds.add(token.id);
    return token;
  });

  Object.values(market.wallets).forEach(wallet => {
    if (!wallet || typeof wallet !== "object") {
      return;
    }

    if (!wallet.tokenBalances || typeof wallet.tokenBalances !== "object") {
      wallet.tokenBalances = {};
      return;
    }

    Object.keys(wallet.tokenBalances).forEach(tokenId => {
      if (!visibleTokenIds.has(tokenId)) {
        delete wallet.tokenBalances[tokenId];
      }
    });
  });

  return market;
}

function createTokenPayload(body) {
  const name = sanitizeString(body.name, 40);
  const symbol = sanitizeString(body.symbol, 10).toUpperCase();
  const description = sanitizeString(body.description, 280);
  const website = sanitizeString(body.website || "None", 120) || "None";
  const price = Number(body.price || 0);
  const supply = Number(body.supply || 0);

  if (!name || !symbol || !description || !Number.isFinite(price) || price <= 0 || !Number.isFinite(supply) || supply <= 0) {
    return { error: "Invalid token fields." };
  }

  return {
    id: `${symbol.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`,
    name,
    symbol,
    description,
    website,
    imageUrl: sanitizeImageSource(body.imageUrl),
    tokenAddress: sanitizeAddress(body.tokenAddress),
    factoryAddress: sanitizeAddress(body.factoryAddress),
    creationTxHash: sanitizeString(body.creationTxHash || "", 120),
    onChainSupply: sanitizeString(body.onChainSupply || "", 120),
    creatorAddress: sanitizeAddress(body.creatorAddress),
    creatorSignature: sanitizeString(body.creatorSignature || "", 400),
    creatorRloBalance: sanitizeBalanceSeed(body.walletRloBalance),
    seedLiquidityRlo: sanitizeBalanceSeed(body.seedLiquidityRlo) ?? 0,
    initialPrice: Number(price.toFixed(6)),
    price: Number(price.toFixed(6)),
    supply: Math.round(supply),
    holders: 1,
    volume: 0,
    createdAt: new Date().toISOString(),
    recentTrades: [],
    tradeHistory: []
  };
}

function createTokenInMarket(market, payload) {
  if (!payload.creatorAddress) {
    return { error: "Wallet confirmation is required to create a token." };
  }

  const creatorWallet = ensureWalletRecord(market, payload.creatorAddress, payload.creatorRloBalance);
  const creatorAllocation = Number((Number(payload.supply) * DEFAULT_CREATOR_SHARE).toFixed(6));
  const poolTokenReserve = Number(Math.max(Number(payload.supply) - creatorAllocation, 1).toFixed(6));
  const virtualRloReserve = Number((poolTokenReserve * Number(payload.initialPrice || payload.price || 0)).toFixed(6));
  const seedLiquidityRlo = Number(payload.seedLiquidityRlo || 0);

  if (!creatorWallet) {
    return { error: "Invalid creator wallet." };
  }

  if (seedLiquidityRlo <= 0) {
    return { error: "Seed liquidity is required." };
  }

  if (creatorWallet.rloBalance < seedLiquidityRlo) {
    creatorWallet.rloBalance = Number(seedLiquidityRlo.toFixed(6));
  }

  creatorWallet.rloBalance = Number(Math.max(0, creatorWallet.rloBalance - seedLiquidityRlo).toFixed(6));
  creatorWallet.tokenBalances[payload.id] = Number(((creatorWallet.tokenBalances[payload.id] || 0) + creatorAllocation).toFixed(6));

  payload.creatorAllocation = creatorAllocation;
  payload.pool = {
    rloReserve: seedLiquidityRlo,
    virtualRloReserve,
    tokenReserve: poolTokenReserve,
    virtualTokenReserve: poolTokenReserve,
    feeBps: DEFAULT_FEE_BPS
  };
  payload.tradeHistory.push({
    side: "LIST",
    amountRlo: 0,
    amountToken: 0,
    price: Number(payload.initialPrice || payload.price || 0),
    executionPrice: Number(payload.initialPrice || payload.price || 0),
    traderAddress: payload.creatorAddress,
    txHash: payload.creationTxHash || "",
    timestamp: payload.createdAt
  });

  payload.price = getSpotPrice(payload);
  market.tokens.unshift(payload);
  return { token: payload };
}

function applyTrade(market, token, side, amountValue, traderAddress, traderRloBalance = null, tradeTxHash = "") {
  const normalizedSide = sanitizeString(side, 4).toUpperCase();
  const wallet = ensureWalletRecord(market, traderAddress, traderRloBalance);

  if (!wallet) {
    return { error: "Wallet confirmation is required." };
  }

  if (!token.pool) {
    return { error: "Token pool is not initialized." };
  }

  const feeBps = Number(token.pool.feeBps || DEFAULT_FEE_BPS);
  const feeMultiplier = (10_000 - feeBps) / 10_000;
  const poolRloReserve = Number(token.pool.rloReserve || 0);
  const poolTokenReserve = Number(token.pool.tokenReserve || 0);
  const virtualRloReserve = Number(token.pool.virtualRloReserve || token.pool.rloReserve || 0);
  const virtualTokenReserve = Number(token.pool.virtualTokenReserve || token.pool.tokenReserve || 0);
  const amount = Number(amountValue || 0);

  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: "Invalid trade amount." };
  }

  if (poolRloReserve <= 0 || poolTokenReserve <= 0 || virtualRloReserve <= 0 || virtualTokenReserve <= 0) {
    return { error: "Pool liquidity is empty." };
  }

  const k = virtualRloReserve * virtualTokenReserve;
  let amountRlo = 0;
  let amountToken = 0;

  if (normalizedSide === "BUY") {
    if (Number(wallet.rloBalance || 0) + 0.0000001 < amount) {
      return {
        error: `Insufficient RLO balance. Available: ${Number(wallet.rloBalance || 0).toFixed(6)} RLO.`
      };
    }

    const effectiveRloIn = amount * feeMultiplier;
    const nextVirtualRloReserve = virtualRloReserve + effectiveRloIn;
    const nextVirtualTokenReserve = k / nextVirtualRloReserve;
    const tokenOut = virtualTokenReserve - nextVirtualTokenReserve;

    let safeTokenOut = tokenOut;
    let safeNextVirtualTokenReserve = nextVirtualTokenReserve;
    if (!Number.isFinite(safeTokenOut) || safeTokenOut <= 0 || safeTokenOut >= poolTokenReserve) {
      const fallbackPrice = Number(token.price || 0) > 0 ? Number(token.price || 0) : (poolRloReserve / Math.max(poolTokenReserve, 1));
      safeTokenOut = Math.min(amount / Math.max(fallbackPrice, 0.000001), poolTokenReserve * 0.92);
      safeNextVirtualTokenReserve = Math.max(0.000001, virtualTokenReserve - safeTokenOut);
    }

    if (!Number.isFinite(safeTokenOut) || safeTokenOut <= 0) {
      return { error: "Pool cannot quote this buy yet." };
    }

    amountRlo = Number(amount.toFixed(6));
    amountToken = Number(safeTokenOut.toFixed(6));

    wallet.rloBalance = Number(Math.max(0, wallet.rloBalance - amountRlo).toFixed(6));
    wallet.tokenBalances[token.id] = Number(((wallet.tokenBalances[token.id] || 0) + amountToken).toFixed(6));

    token.pool.rloReserve = Number((poolRloReserve + amountRlo).toFixed(6));
    token.pool.tokenReserve = Number(Math.max(0.000001, poolTokenReserve - amountToken).toFixed(6));
    token.pool.virtualRloReserve = Number(nextVirtualRloReserve.toFixed(6));
    token.pool.virtualTokenReserve = Number(safeNextVirtualTokenReserve.toFixed(6));
  } else if (normalizedSide === "SELL") {
    const availableTokenBalance = Number(wallet.tokenBalances[token.id] || 0);
    if (availableTokenBalance + 0.0000001 < amount) {
      return {
        error: `Insufficient ${token.symbol || "token"} balance. Available: ${availableTokenBalance.toFixed(6)}.`
      };
    }

    const effectiveTokenIn = amount * feeMultiplier;
    const nextVirtualTokenReserve = virtualTokenReserve + effectiveTokenIn;
    const nextVirtualRloReserve = k / nextVirtualTokenReserve;
    const rloOut = virtualRloReserve - nextVirtualRloReserve;

    let safeRloOut = rloOut;
    if (!Number.isFinite(safeRloOut) || safeRloOut <= 0 || safeRloOut >= poolRloReserve) {
      const fallbackPrice = Number(token.price || 0) > 0 ? Number(token.price || 0) : (poolRloReserve / Math.max(poolTokenReserve, 1));
      safeRloOut = Math.min(amount * fallbackPrice, poolRloReserve * 0.92);
    }

    if (!Number.isFinite(safeRloOut) || safeRloOut <= 0) {
      return { error: "Pool cannot quote this sell yet." };
    }

    amountToken = Number(amount.toFixed(6));
    amountRlo = Number(safeRloOut.toFixed(6));

    wallet.tokenBalances[token.id] = Number(Math.max(0, (wallet.tokenBalances[token.id] || 0) - amountToken).toFixed(6));
    wallet.rloBalance = Number((wallet.rloBalance + amountRlo).toFixed(6));

    token.pool.tokenReserve = Number((poolTokenReserve + amountToken).toFixed(6));
    token.pool.rloReserve = Number(Math.max(0.000001, poolRloReserve - amountRlo).toFixed(6));
    token.pool.virtualRloReserve = Number(nextVirtualRloReserve.toFixed(6));
    token.pool.virtualTokenReserve = Number(nextVirtualTokenReserve.toFixed(6));
  } else {
    return { error: "Invalid trade side." };
  }

  token.price = getSpotPrice(token);
  token.volume = Number((Number(token.volume || 0) + amountRlo).toFixed(6));

  const timestamp = new Date().toISOString();
  const executionPrice = amountToken > 0 ? Number((amountRlo / amountToken).toFixed(6)) : token.price;

  token.tradeHistory.push({
    side: normalizedSide,
    amountRlo,
    amountToken,
    price: token.price,
    executionPrice,
    traderAddress: sanitizeAddress(traderAddress),
    txHash: sanitizeString(tradeTxHash || "", 120),
    timestamp
  });

  return { token };
}

function buildCandles(token, points = 32) {
  const history = (token.tradeHistory.length ? token.tradeHistory : [{
    side: "BUY",
    amount: 0,
    price: token.price,
    timestamp: new Date().toISOString()
  }]).map(item => ({
    price: Number(item.price || token.price || 0.0001),
    timestamp: item.timestamp || new Date().toISOString()
  }));

  const chunkSize = Math.max(1, Math.ceil(history.length / points));
  const buckets = [];

  for (let index = 0; index < history.length; index += chunkSize) {
    const chunk = history.slice(index, index + chunkSize);
    const prices = chunk.map(item => Number(item.price || 0.0001));
    const open = prices[0];
    const close = prices[prices.length - 1];
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    const timestamp = chunk[chunk.length - 1].timestamp;

    buckets.push({
      open,
      high,
      low,
      close,
      timestamp,
      samples: chunk.length
    });
  }

  const trimmed = buckets.slice(-points);
  const fallback = trimmed[0] || {
    open: token.price,
    high: token.price,
    low: token.price,
    close: token.price,
    timestamp: new Date().toISOString()
  };

  const chartCandles = trimmed.length ? trimmed : [fallback];

  return chartCandles.map((candle, index) => {
    const previousClose = index > 0 ? chartCandles[index - 1].close : candle.open;
    const open = Number((candle.samples > 1 ? candle.open : previousClose).toFixed(6));
    const close = Number(candle.close.toFixed(6));
    const high = Number(Math.max(candle.high, open, close).toFixed(6));
    const low = Number(Math.min(candle.low, open, close).toFixed(6));

    return {
      index,
      open,
      high,
      low,
      close,
      timestamp: candle.timestamp,
      direction: close >= open ? "up" : "down"
    };
  });
}

function listTokens(sortBy) {
  const market = readMarket();
  const tokens = market.tokens.map(token => normalizeToken(token, market));

  if (sortBy === "volume") {
    return tokens.sort((a, b) => b.volume - a.volume);
  }

  if (sortBy === "mcap") {
    return tokens.sort((a, b) => b.mcap - a.mcap);
  }

  return tokens.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function getTokenById(tokenId, viewerAddress = "", viewerSeedBalance = null) {
  const market = readMarket();
  const token = market.tokens.find(item => item.id === tokenId);
  return token ? normalizeToken(token, market, viewerAddress, viewerSeedBalance) : null;
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const normalizedPath = String(safePath || "").replace(/\\/g, "/").toLowerCase();

  if (
    normalizedPath.startsWith("/data/") ||
    normalizedPath === "/data" ||
    normalizedPath.endsWith(".db") ||
    normalizedPath.endsWith("rialo-ai.config.json")
  ) {
    sendText(res, 403, "Forbidden");
    return;
  }

  const filePath = path.join(ROOT, path.normalize(safePath).replace(/^(\.\.[/\\])+/, ""));

  if (!filePath.startsWith(ROOT)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendText(res, 404, "Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const cacheControl = ext === ".html"
      ? "no-cache"
      : [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".ico"].includes(ext)
        ? "public, max-age=86400"
        : "public, max-age=3600";
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": cacheControl,
      // The *.artifact.json ABI files are fetched by script.js, which may be
      // served from another origin (Netlify) or from file://, where the page has
      // no host of its own. These are public build outputs, so allow any origin.
      "Access-Control-Allow-Origin": "*"
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    sendJson(res, 400, { error: "Invalid request" });
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (req.method === "GET" && pathname === "/api/community-chat") {
    const db = getMarketDb();
    pruneExpiredCommunityChatMessages(db);
    const after = Math.max(0, Number.parseInt(url.searchParams.get("after") || "0", 10) || 0);
    let rows;

    if (after > 0) {
      rows = db.prepare(`
        SELECT id, username, wallet_address, message, reply_to_id, reply_username, reply_message, created_at
        FROM community_chat_messages
        WHERE id > ?
        ORDER BY id ASC
        LIMIT 100
      `).all(after);
    } else {
      rows = db.prepare(`
        SELECT id, username, wallet_address, message, reply_to_id, reply_username, reply_message, created_at
        FROM community_chat_messages
        ORDER BY id DESC
        LIMIT 80
      `).all().reverse();
    }

    sendJson(res, 200, {
      messages: rows.map(row => ({
        id: Number(row.id),
        username: row.username,
        walletAddress: row.wallet_address,
        message: row.message,
        replyToId: Number(row.reply_to_id) || 0,
        replyUsername: row.reply_username || "",
        replyMessage: row.reply_message || "",
        createdAt: row.created_at
      }))
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/community-chat") {
    try {
      const body = await parseBody(req);
      const username = String(body.username || "").replace(/^@+/, "").trim();
      const walletAddress = sanitizeAddress(body.walletAddress || "");
      const message = sanitizeString(body.message || "", 280);
      const replyToId = Math.max(0, Number.parseInt(body.replyToId || "0", 10) || 0);

      if (!/^[A-Za-z0-9_]{2,32}$/.test(username)) {
        sendJson(res, 400, { error: "Connect your wallet and confirm a valid X username first." });
        return;
      }
      if (!message) {
        sendJson(res, 400, { error: "Message is required." });
        return;
      }

      const clientKey = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
      const now = Date.now();
      const recentPosts = (communityChatRateLimits.get(clientKey) || []).filter(timestamp => now - timestamp < 30000);
      if (recentPosts.length >= 10) {
        sendJson(res, 429, { error: "Too many messages. Wait a moment and try again." });
        return;
      }
      recentPosts.push(now);
      communityChatRateLimits.set(clientKey, recentPosts);

      const db = getMarketDb();
      pruneExpiredCommunityChatMessages(db);
      const createdAt = new Date().toISOString();
      const repliedMessage = replyToId
        ? db.prepare(`SELECT id, username, message FROM community_chat_messages WHERE id = ?`).get(replyToId)
        : null;
      const replyUsername = repliedMessage ? sanitizeString(repliedMessage.username || "", 32) : "";
      const replyMessage = repliedMessage ? sanitizeString(repliedMessage.message || "", 120) : "";
      const storedReplyToId = repliedMessage ? Number(repliedMessage.id) : 0;
      const result = db.prepare(`
        INSERT INTO community_chat_messages (
          username, wallet_address, message, reply_to_id, reply_username, reply_message, created_at
        )
        VALUES (
          @username, @walletAddress, @message, @replyToId, @replyUsername, @replyMessage, @createdAt
        )
      `).run({
        username,
        walletAddress,
        message,
        replyToId: storedReplyToId,
        replyUsername,
        replyMessage,
        createdAt
      });

      db.exec(`
        DELETE FROM community_chat_messages
        WHERE id NOT IN (
          SELECT id FROM community_chat_messages ORDER BY id DESC LIMIT 1000
        )
      `);

      sendJson(res, 201, {
        ok: true,
        message: {
          id: Number(result.lastInsertRowid),
          username,
          walletAddress,
          message,
          replyToId: storedReplyToId,
          replyUsername,
          replyMessage,
          createdAt
        }
      });
      return;
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
      return;
    }
  }


  if (req.method === "GET" && pathname === "/api/twitter-avatar") {
    const username = String(url.searchParams.get("username") || "").replace(/^@+/, "").trim();

    if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) {
      sendJson(res, 400, { error: "Invalid X username." });
      return;
    }

    const encodedUsername = encodeURIComponent(username);
    const avatarSources = [
      `https://unavatar.io/x/${encodedUsername}?fallback=false`,
      `https://unavatar.io/twitter/${encodedUsername}?fallback=false`
    ];

    for (const avatarSource of avatarSources) {
      try {
        const avatarResponse = await downloadRemoteImage(avatarSource);
        const contentType = avatarResponse.contentType;

        if (!avatarResponse.ok || !contentType.startsWith("image/")) continue;

        const avatarBuffer = avatarResponse.buffer;
        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": avatarBuffer.length,
          "Cache-Control": "public, max-age=1800",
          "Access-Control-Allow-Origin": "*"
        });
        res.end(avatarBuffer);
        return;
      } catch (error) {
        // Try the next fixed avatar provider URL.
      }
    }

    sendJson(res, 404, { error: "X profile image was not found." });
    return;
  }

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      service: "rialo-market",
      now: new Date().toISOString(),
      indexer: {
        lastSyncAt: indexerState.lastSyncAt || getMetadataValue("indexer:lastSyncAt") || "",
        lastError: indexerState.lastError || getMetadataValue("indexer:lastError") || "",
        factories: indexerState.lastFactories || 0,
        rpcUrl: RIALO_RPC_URL,
        chainId: RIALO_CHAIN_ID,
        network: "Ethereum Sepolia"
      }
    });
    return;
  }

  if (req.method === "POST" && pathname === "/ask") {
    try {
      const body = await parseBody(req);
      const question = sanitizeString(body.question || body.message || "", 1200);
      const contextSummary = summarizeAiContext(body.context || {});

      if (!question) {
        sendJson(res, 400, { error: "Question is required." });
        return;
      }

      let answer = "";
      let mode = "local";
      let fallbackReason = "";

      try {
        const aiReply = await requestAiChat(question, contextSummary);
        if (aiReply) {
          answer = aiReply;
          mode = AI_PROVIDER;
        }
      } catch (error) {
        fallbackReason = error?.message || "AI provider request failed";
        indexerState.lastError = `AI fallback used: ${fallbackReason}`;
      }

      if (!answer) {
        answer = buildLocalAiReply(question, contextSummary);
      }

      sendJson(res, 200, {
        ok: true,
        mode,
        answer,
        fallbackReason
      });
      return;
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
      return;
    }
  }
  if (req.method === "POST" && pathname === "/api/ai-chat") {
    try {
      const body = await parseBody(req);
      const message = sanitizeString(body.message || "", 1200);
      const contextSummary = summarizeAiContext(body.context || {});

      if (!message) {
        sendJson(res, 400, { error: "Message is required." });
        return;
      }

      let reply = "";
      let mode = "local";
      let fallbackReason = "";

      try {
        const aiReply = await requestAiChat(message, contextSummary);
        if (aiReply) {
          reply = aiReply;
          mode = AI_PROVIDER;
        }
      } catch (error) {
        fallbackReason = error?.message || "AI provider request failed";
        indexerState.lastError = `AI fallback used: ${fallbackReason}`;
      }

      if (!reply) {
        reply = buildLocalAiReply(message, contextSummary);
      }

      sendJson(res, 200, {
        ok: true,
        mode,
        reply,
        fallbackReason
      });
      return;
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
      return;
    }
  }

  if (req.method === "GET" && pathname === "/api/tokens") {
    const sortBy = url.searchParams.get("sort") || "latest";
    sendJson(res, 200, { tokens: listTokens(sortBy) });
    return;
  }

  if (req.method === "GET" && pathname === "/api/portfolio") {
    const market = readMarket();
    const viewerAddress = sanitizeAddress(url.searchParams.get("viewer") || "");
    const viewerSeedBalance = sanitizeBalanceSeed(url.searchParams.get("viewerBalanceRlo"));
    sendJson(res, 200, {
      portfolio: buildPortfolio(market, viewerAddress, viewerSeedBalance)
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/nft-listings") {
    sendJson(res, 200, {
      listings: listActiveNftListings()
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/nft-listings") {
    try {
      const body = await parseBody(req);
      const result = createOrUpdateNftListing(body);

      if (result.error) {
        sendJson(res, 400, result);
        return;
      }

      sendJson(res, 201, {
        listing: result.listing,
        listings: listActiveNftListings()
      });
      return;
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
      return;
    }
  }

  if (req.method === "POST" && pathname === "/api/nft-listings/cancel") {
    try {
      const body = await parseBody(req);
      const result = cancelNftListing(body);

      if (result.error) {
        sendJson(res, 400, result);
        return;
      }

      sendJson(res, 200, {
        ok: true,
        cancelledAmount: result.cancelledAmount,
        remainingAmount: result.remainingAmount,
        listings: listActiveNftListings()
      });
      return;
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
      return;
    }
  }

  if (req.method === "POST" && pathname === "/api/nft-listings/purchase") {
    try {
      const body = await parseBody(req);
      const result = purchaseNftListing(body);
      if (result.error) {
        sendJson(res, 400, result);
        return;
      }

      sendJson(res, 200, {
        ok: true,
        listings: listActiveNftListings()
      });
      return;
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
      return;
    }
  }

  if (req.method === "POST" && pathname === "/api/tokens") {
    try {
      const body = await parseBody(req);
      const payload = createTokenPayload(body);

      if (payload.error) {
        sendJson(res, 400, payload);
        return;
      }

      const market = readMarket();
      const result = createTokenInMarket(market, payload);
      if (result.error) {
        sendJson(res, 400, result);
        return;
      }

      writeMarket(market);

      sendJson(res, 201, {
        token: normalizeToken(result.token, market, payload.creatorAddress),
        candles: buildCandles(result.token)
      });
      return;
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
      return;
    }
  }

  const tokenDetailMatch = pathname.match(/^\/api\/tokens\/([^/]+)$/);
  if (req.method === "GET" && tokenDetailMatch) {
    const viewerAddress = sanitizeAddress(url.searchParams.get("viewer") || "");
    const viewerSeedBalance = sanitizeBalanceSeed(url.searchParams.get("viewerBalanceRlo"));
    const token = getTokenById(tokenDetailMatch[1], viewerAddress, viewerSeedBalance);
    if (!token) {
      notFound(res);
      return;
    }

    sendJson(res, 200, {
      token,
      candles: buildCandles(token)
    });
    return;
  }

  const tokenDeleteMatch = pathname.match(/^\/api\/tokens\/([^/]+)\/delete$/);
  if (req.method === "POST" && tokenDeleteMatch) {
    try {
      const body = await parseBody(req);
      const market = readMarket();
      const tokenId = tokenDeleteMatch[1];
      const tokenIndex = market.tokens.findIndex(item => item.id === tokenId);
      if (tokenIndex === -1) {
        notFound(res);
        return;
      }

      const creatorAddress = sanitizeAddress(body.creatorAddress || "");
      const token = market.tokens[tokenIndex];
      if (!creatorAddress || !token.creatorAddress || creatorAddress.toLowerCase() !== token.creatorAddress.toLowerCase()) {
        sendJson(res, 403, { error: "Only the meme creator can cancel this meme." });
        return;
      }
      if (!sanitizeString(body.creatorSignature || "", 400)) {
        sendJson(res, 400, { error: "Wallet confirmation is required to cancel this meme." });
        return;
      }

      market.tokens.splice(tokenIndex, 1);
      Object.values(market.wallets || {}).forEach(wallet => {
        if (wallet && wallet.tokenBalances) {
          delete wallet.tokenBalances[tokenId];
        }
      });
      writeMarket(market);
      sendJson(res, 200, { ok: true, cancelledTokenId: tokenId, deletedTokenId: tokenId });
      return;
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
      return;
    }
  }

  const tokenTradeMatch = pathname.match(/^\/api\/tokens\/([^/]+)\/trades$/);
  if (req.method === "POST" && tokenTradeMatch) {
    try {
      const body = await parseBody(req);
      const tokenId = tokenTradeMatch[1];
      const market = readMarket();
      const token = market.tokens.find(item => item.id === tokenId);

      if (!token) {
        notFound(res);
        return;
      }

      const normalizedSide = sanitizeString(body.side, 4).toUpperCase();
      const shadowTradeAmount = normalizedSide === "SELL"
        ? Number(body.amountToken || body.amount || 0)
        : Number(body.amountRlo || body.amount || 0);

      if (body.virtualTrade === true && token.pool) {
        token.pool.mode = "virtual";
      }

      const result = applyTrade(
        market,
        token,
        normalizedSide,
        shadowTradeAmount,
        body.traderAddress,
        body.walletRloBalance,
        body.txHash
      );
      if (result.error) {
        sendJson(res, 400, result);
        return;
      }

      writeMarket(market);
      const viewerAddress = sanitizeAddress(body.traderAddress);
      const normalizedToken = normalizeToken(token, market, viewerAddress);

      sendJson(res, 200, {
        token: normalizedToken,
        candles: buildCandles(token)
      });
      return;
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
      return;
    }
  }

  serveStatic(req, res, pathname);
});

startChainIndexer();

server.listen(PORT, () => {
  console.log(`Rialo Market server running on http://localhost:${PORT}`);
});
