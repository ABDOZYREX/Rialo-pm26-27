// One-time admin cleanup script.
//
// Deletes the "spider" (symbol: SP) and "RIALO" (symbol: RLO) tokens from the
// market database, along with any trades and wallet token balances tied to
// them. Wallets and NFT listings are left untouched.
//
// Usage:
//   RIALO_DATA_DIR=/path/to/data node scripts/delete-tokens.js
//
// If RIALO_DATA_DIR is not set, the script falls back to the same default
// runtime data directory that server.js uses.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SYMBOLS_TO_DELETE = ["SP", "RLO"];

const DEFAULT_RUNTIME_DATA_DIR = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "RialoPM", "data")
  : path.join(os.tmpdir(), "rialo-pm-data");

const DATA_DIR = process.env.RIALO_DATA_DIR
  ? path.resolve(process.env.RIALO_DATA_DIR)
  : DEFAULT_RUNTIME_DATA_DIR;

const DB_FILE = path.join(DATA_DIR, "market.db");

function main() {
  if (!fs.existsSync(DB_FILE)) {
    console.error(`Database not found at ${DB_FILE}`);
    process.exitCode = 1;
    return;
  }

  const db = new DatabaseSync(DB_FILE);
  db.exec("PRAGMA foreign_keys = ON;");

  const normalizedSymbols = SYMBOLS_TO_DELETE.map(symbol => symbol.toUpperCase());
  const placeholders = normalizedSymbols.map(() => "UPPER(symbol) = ?").join(" OR ");

  const matchedTokens = db.prepare(`SELECT id, symbol, name FROM tokens WHERE ${placeholders}`).all(...normalizedSymbols);

  if (matchedTokens.length === 0) {
    console.log("No matching tokens found. Nothing to delete.");
    db.close();
    return;
  }

  const tokenIds = matchedTokens.map(row => row.id);
  const tokenIdPlaceholders = tokenIds.map(() => "?").join(", ");

  let deletedTrades = 0;
  let deletedBalances = 0;
  let deletedTokens = 0;

  try {
    db.exec("BEGIN IMMEDIATE TRANSACTION");

    const tradeCountRow = db
      .prepare(`SELECT COUNT(*) AS count FROM trades WHERE token_id IN (${tokenIdPlaceholders})`)
      .get(...tokenIds);
    deletedTrades = Number(tradeCountRow?.count || 0);

    const balanceCountRow = db
      .prepare(`SELECT COUNT(*) AS count FROM wallet_token_balances WHERE token_id IN (${tokenIdPlaceholders})`)
      .get(...tokenIds);
    deletedBalances = Number(balanceCountRow?.count || 0);

    const deleteResult = db.prepare(`DELETE FROM tokens WHERE ${placeholders}`).run(...normalizedSymbols);
    deletedTokens = Number(deleteResult?.changes || 0);

    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback failure
    }
    db.close();
    throw error;
  }

  db.close();

  console.log(JSON.stringify({
    ok: true,
    tokensDeleted: deletedTokens,
    tradesDeleted: deletedTrades,
    balancesDeleted: deletedBalances,
    tokens: matchedTokens.map(row => ({ id: row.id, symbol: row.symbol, name: row.name }))
  }, null, 2));
}

main();
