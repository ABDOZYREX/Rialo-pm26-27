const fs = require("node:fs");
const path = require("node:path");
const solc = require("solc");

const projectRoot = __dirname;
const contractPath = path.join(projectRoot, "contracts", "RialoNftMarketplace.sol");
const artifactPath = path.join(projectRoot, "rialo-nft-marketplace.artifact.json");

const source = fs.readFileSync(contractPath, "utf8");

const input = {
  language: "Solidity",
  sources: {
    "RialoNftMarketplace.sol": {
      content: source
    }
  },
  settings: {
    optimizer: {
      enabled: true,
      runs: 200
    },
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object"]
      }
    }
  }
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

if (output.errors?.length) {
  const hardErrors = output.errors.filter(item => item.severity === "error");
  output.errors.forEach(item => {
    console[item.severity === "error" ? "error" : "warn"](item.formattedMessage);
  });

  if (hardErrors.length) {
    process.exit(1);
  }
}

const compiled = output.contracts?.["RialoNftMarketplace.sol"]?.["RialoNftMarketplace"];

if (!compiled?.evm?.bytecode?.object) {
  throw new Error("Failed to compile RialoNftMarketplace.");
}

const artifact = {
  contractName: "RialoNftMarketplace",
  abi: compiled.abi,
  bytecode: `0x${compiled.evm.bytecode.object}`
};

fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
console.log(`Wrote ${artifactPath}`);
