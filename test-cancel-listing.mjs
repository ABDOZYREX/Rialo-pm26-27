// Regression check for the NFT "Cancel Listing" fix.
// Boots server.js against a throwaway data dir, then exercises the cancel API.
// Run with:  node test-cancel-listing.mjs
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROJECT = import.meta.dirname;
const PORT = Number(process.env.TEST_PORT || 3987);
const DATA_DIR = path.join(os.tmpdir(), "rialo-cancel-listing-test");
const BASE = `http://127.0.0.1:${PORT}`;

const SELLER_CHECKSUM = "0xAbC0000000000000000000000000000000000001";
const SELLER_LOWER = SELLER_CHECKSUM.toLowerCase();
const OTHER_SELLER = "0x00000000000000000000000000000000000000f2";

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

function resetDataDir() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

async function startServer() {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: PROJECT,
    env: { ...process.env, PORT: String(PORT), RIALO_DATA_DIR: DATA_DIR },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  child.stdout.on("data", () => {});

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (code ${child.exitCode})\n${stderr}`);
    }
    try {
      const res = await fetch(`${BASE}/api/nft-listings`);
      if (res.ok) return { child, getStderr: () => stderr };
    } catch {
      // not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  child.kill();
  throw new Error(`server did not become ready\n${stderr}`);
}

async function stopServer(server) {
  if (!server?.child) return;
  server.child.kill();
  await new Promise(resolve => setTimeout(resolve, 400));
}

async function api(pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const listings = async () => (await api("/api/nft-listings")).data.listings || [];
const findListing = (rows, code, seller) => rows.find(row =>
  row.code === code && String(row.sellerAddress).toLowerCase() === seller.toLowerCase()
) || null;

async function main() {
  // ---------- phase 1: live API behaviour ----------
  resetDataDir();
  let server = await startServer();

  try {
    // Case mismatch: list with checksum casing, cancel with lowercase.
    let res = await api("/api/nft-listings", {
      code: "MA", tokenId: 10, sellerAddress: SELLER_CHECKSUM, amount: 2, priceRlo: 5, txHash: "0xlist"
    });
    check("list accepted", res.status === 201, JSON.stringify(res.data).slice(0, 200));

    let rows = await listings();
    check("listing stored lowercase", findListing(rows, "ma", SELLER_LOWER)?.sellerAddress === SELLER_LOWER,
      JSON.stringify(rows));

    res = await api("/api/nft-listings/cancel", { code: "ma", sellerAddress: SELLER_LOWER, amount: 1 });
    check("partial cancel with different address casing succeeds", res.status === 200,
      `${res.status} ${JSON.stringify(res.data.error || "")}`);
    check("partial cancel reports remaining 1", res.data.remainingAmount === 1, JSON.stringify(res.data).slice(0, 200));

    rows = await listings();
    check("listing still active after partial cancel", findListing(rows, "ma", SELLER_LOWER)?.amount === 1,
      JSON.stringify(rows));

    // Reject bogus amounts.
    res = await api("/api/nft-listings/cancel", { code: "ma", sellerAddress: SELLER_CHECKSUM, amount: 0 });
    check("cancel amount 0 rejected", res.status === 400, `${res.status} ${JSON.stringify(res.data)}`);
    res = await api("/api/nft-listings/cancel", { code: "ma", sellerAddress: SELLER_CHECKSUM, amount: 99 });
    check("cancel amount above listed rejected", res.status === 400, `${res.status} ${JSON.stringify(res.data)}`);

    // Omitted amount cancels the whole listing.
    res = await api("/api/nft-listings/cancel", { code: "ma", sellerAddress: SELLER_CHECKSUM });
    check("cancel without amount clears listing", res.status === 200 && res.data.remainingAmount === 0,
      `${res.status} ${JSON.stringify(res.data).slice(0, 200)}`);

    rows = await listings();
    check("cancelled listing gone from active list", findListing(rows, "ma", SELLER_LOWER) === null, JSON.stringify(rows));

    // Cancelling twice is a clean 400 the UI can recover from.
    res = await api("/api/nft-listings/cancel", { code: "ma", sellerAddress: SELLER_CHECKSUM, amount: 1 });
    check("second cancel returns not-found error", res.status === 400 && /not found/i.test(String(res.data.error)),
      `${res.status} ${JSON.stringify(res.data)}`);

    // Re-listing after a cancel works (ON CONFLICT path).
    res = await api("/api/nft-listings", {
      code: "ma", tokenId: 10, sellerAddress: SELLER_CHECKSUM, amount: 3, priceRlo: 7, txHash: "0xrelist"
    });
    rows = await listings();
    check("re-list after cancel restores an active listing",
      res.status === 201 && findListing(rows, "ma", SELLER_LOWER)?.amount === 3, JSON.stringify(rows));

    // A different wallet's listing is untouched by our cancels.
    await api("/api/nft-listings", {
      code: "ma", tokenId: 10, sellerAddress: OTHER_SELLER, amount: 1, priceRlo: 4, txHash: "0xother"
    });
    await api("/api/nft-listings/cancel", { code: "ma", sellerAddress: SELLER_CHECKSUM });
    rows = await listings();
    check("other wallet listing survives", findListing(rows, "ma", OTHER_SELLER)?.amount === 1, JSON.stringify(rows));
    check("own listing cleared", findListing(rows, "ma", SELLER_LOWER) === null, JSON.stringify(rows));
  } finally {
    await stopServer(server);
  }

  // ---------- phase 2: legacy mixed-case rows get merged on boot ----------
  const dbFile = path.join(DATA_DIR, "market.db");
  {
    const db = new DatabaseSync(dbFile);
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO nft_listings (code, token_id, seller_address, amount, price_rlo, tx_hash, status, created_at, updated_at)
      VALUES (@code, @tokenId, @sellerAddress, @amount, @priceRlo, '', 'ACTIVE', @now, @now)
    `);
    // Two rows for the same wallet + card, differing only in address casing:
    // exactly the state that made Cancel Listing look broken.
    insert.run({ code: "br", tokenId: 9, sellerAddress: "0xDdD0000000000000000000000000000000000003", amount: 2, priceRlo: 6, now });
    insert.run({ code: "br", tokenId: 9, sellerAddress: "0xddd0000000000000000000000000000000000003", amount: 1, priceRlo: 6, now });
    db.close();
  }

  server = await startServer();
  try {
    const rows = await listings();
    const brRows = rows.filter(row => row.code === "br");
    check("mixed-case duplicates merged into one row", brRows.length === 1, JSON.stringify(brRows));
    check("merged row keeps both amounts", brRows[0]?.amount === 3, JSON.stringify(brRows));
    check("merged row address is lowercase",
      brRows[0]?.sellerAddress === "0xddd0000000000000000000000000000000000003", JSON.stringify(brRows));

    const res = await api("/api/nft-listings/cancel", {
      code: "br", sellerAddress: "0xDdD0000000000000000000000000000000000003"
    });
    check("merged listing cancels in one call", res.status === 200 && res.data.remainingAmount === 0,
      `${res.status} ${JSON.stringify(res.data).slice(0, 200)}`);

    const after = (await listings()).filter(row => row.code === "br");
    check("no leftover row keeps the listing alive", after.length === 0, JSON.stringify(after));
  } finally {
    await stopServer(server);
  }

  console.log(failures === 0 ? "\nALL_TESTS_PASSED" : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => {
  console.error("TEST_HARNESS_ERROR", error);
  process.exit(1);
});
