const fs = require("node:fs");
const path = require("node:path");
const solc = require("solc");

const sourceName = "RialoMarketFactory.sol";
const contractName = "RialoMarketFactory";
const source = fs.readFileSync(path.join(__dirname, "contracts", sourceName), "utf8");
const input = {
  language: "Solidity",
  sources: { [sourceName]: { content: source } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } }
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors || []).filter(item => item.severity === "error");
if (errors.length) throw new Error(errors.map(item => item.formattedMessage).join("\n"));
const compiled = output.contracts?.[sourceName]?.[contractName];
if (!compiled?.evm?.bytecode?.object) throw new Error("Failed to compile RialoMarketFactory.");
fs.writeFileSync(path.join(__dirname, "rialo-market-factory.artifact.json"), JSON.stringify({ contractName, abi: compiled.abi, bytecode: `0x${compiled.evm.bytecode.object}` }, null, 2));
console.log("Wrote rialo-market-factory.artifact.json");
