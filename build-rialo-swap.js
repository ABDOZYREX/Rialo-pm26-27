const fs = require("node:fs");
const path = require("node:path");
const solc = require("solc");

const projectRoot = __dirname;
const contractsDir = path.join(projectRoot, "contracts");

const sources = {
  "MockUSDC.sol": {
    content: fs.readFileSync(path.join(contractsDir, "MockUSDC.sol"), "utf8")
  },
  "MockUSDT.sol": {
    content: fs.readFileSync(path.join(contractsDir, "MockUSDT.sol"), "utf8")
  },
  "RialoUsdcSwap.sol": {
    content: fs.readFileSync(path.join(contractsDir, "RialoUsdcSwap.sol"), "utf8")
  }
};

const input = {
  language: "Solidity",
  sources,
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
const errors = Array.isArray(output.errors) ? output.errors : [];
const fatalErrors = errors.filter(item => item.severity === "error");

if (fatalErrors.length) {
  throw new Error(fatalErrors.map(item => item.formattedMessage || item.message).join("\n\n"));
}

function writeArtifact(sourceName, contractName, artifactFileName) {
  const compiled = output.contracts?.[sourceName]?.[contractName];

  if (!compiled?.evm?.bytecode?.object) {
    throw new Error(`Failed to compile ${contractName}.`);
  }

  const artifact = {
    contractName,
    abi: compiled.abi,
    bytecode: `0x${compiled.evm.bytecode.object}`
  };

  const artifactPath = path.join(projectRoot, artifactFileName);
  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
  console.log(`Wrote ${artifactPath}`);
}

writeArtifact("MockUSDC.sol", "MockUSDC", "rialo-mock-usdc.artifact.json");
writeArtifact("MockUSDT.sol", "MockUSDT", "rialo-mock-usdt.artifact.json");
writeArtifact("RialoUsdcSwap.sol", "RialoUsdcSwap", "rialo-usdc-swap.artifact.json");


