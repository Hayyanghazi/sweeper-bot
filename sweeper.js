require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

// ── Dashboard Logger ────────────────────────────────────
const LOG_FILE = 'sweeps.json';

function loadLog() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    }
  } catch {}
  return { totalSwept:0, totalTx:0, gasUsed:0, chains:{}, tokens:{}, history:[] };
}

function logSweep(chain, token, amount, hash, gasUsd) {
  const data = loadLog();
  data.totalSwept = (data.totalSwept || 0) + amount;
  data.totalTx    = (data.totalTx || 0) + 1;
  data.gasUsed    = (data.gasUsed || 0) + gasUsd;

  if (!data.chains[chain]) data.chains[chain] = { swept:0, count:0 };
  data.chains[chain].swept += amount;
  data.chains[chain].count += 1;

  if (!data.tokens[token]) data.tokens[token] = { total:0, count:0 };
  data.tokens[token].total += amount;
  data.tokens[token].count += 1;

  data.history.unshift({ chain, token, amount, hash, gasUsd, time: Date.now() });
  if (data.history.length > 100) data.history = data.history.slice(0, 100);

  try { fs.writeFileSync(LOG_FILE, JSON.stringify(data, null, 2)); } catch {}
}

// ── Chains ──────────────────────────────────────────────
const CHAINS = [
  {
    name: 'Ethereum',
    rpc: 'https://eth.llamarpc.com',
    chainId: 1,
    nativeGasLimit: 21000n,
    gasMultiplier: 300n,
    tokens: {
      USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    }
  },
  {
    name: 'BSC',
    rpc: 'https://bsc-dataseed1.defibit.io',
    chainId: 56,
    nativeGasLimit: 21000n,
    gasMultiplier: 250n,
    tokens: {
      USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      USDT: '0x55d398326f99059fF775485246999027B3197955',
    }
  },
  {
    name: 'Base',
    rpc: 'https://mainnet.base.org',
    chainId: 8453,
    nativeGasLimit: 300000n,
    gasMultiplier: 200n,
    tokens: {
      USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
    }
  },
  {
    name: 'Arbitrum',
    rpc: 'https://arb1.arbitrum.io/rpc',
    chainId: 42161,
    nativeGasLimit: 500000n,
    gasMultiplier: 300n,
    tokens: {
      USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
      CUSTOM: '0xD36EcC50f90bf285eB018A5Be18c550a0E35f426',
    }
  },
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
];

const SAFE_ADDRESS = process.env.SAFE_ADDRESS;
const PRIVATE_KEY  = process.env.COMPROMISED_PRIVATE_KEY;

// ── Frontrun Gas ────────────────────────────────────────
// Pays 2x-3x current gas to beat any attacker in mempool
// Hard cap at 5x so we never overpay
async function getFrontrunGas(provider, multiplier) {
  const feeData  = await provider.getFeeData();
  const base     = feeData.gasPrice;
  const boosted  = base * multiplier / 100n;
  const maxCap   = base * 500n / 100n; // 5x hard cap
  const final    = boosted > maxCap ? maxCap : boosted;
  return final;
}

// ── Sweep Tokens ────────────────────────────────────────
async function sweepTokens(wallet, provider, tokens, chainName, gasMultiplier) {
  const gasPrice = await getFrontrunGas(provider, gasMultiplier);
  let nonce = await provider.getTransactionCount(wallet.address, 'pending');

  console.log(`[${chainName}] ⚡ Frontrun gas: ${ethers.formatUnits(gasPrice, 'gwei')} gwei (${gasMultiplier/100n}x boost)`);

  for (const [tokenName, tokenAddress] of Object.entries(tokens)) {
    try {
      const token   = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
      const balance = await token.balanceOf(wallet.address);
      if (balance === 0n) continue;

      // Dynamic gas estimate with 30% buffer
      let gasLimit;
      try {
        gasLimit = await token.transfer.estimateGas(SAFE_ADDRESS, balance);
        gasLimit = gasLimit * 130n / 100n;
      } catch {
        gasLimit = 100000n;
      }

      const gasCostEth = parseFloat(ethers.formatEther(gasPrice * gasLimit));
      const gasCostUsd = gasCostEth * 3000;

      console.log(`[${chainName}] 🚀 Sweeping ${tokenName}...`);

      const tx = await token.transfer(SAFE_ADDRESS, balance, {
        gasLimit,
        gasPrice,
        nonce: nonce++,
      });

      tx.wait().then(async () => {
        let decimals = 18;
        try { decimals = await token.decimals(); } catch {}
        const amount = parseFloat(ethers.formatUnits(balance, decimals));
        console.log(`[${chainName}] ✅ ${tokenName} swept! $${amount.toFixed(2)} | TX: ${tx.hash}`);
        logSweep(chainName, tokenName, amount, tx.hash, gasCostUsd);
      }).catch(e => {
        console.error(`[${chainName}] ${tokenName} confirm error: ${e.message}`);
      });

    } catch (e) {
      console.error(`[${chainName}] ${tokenName} error: ${e.message}`);
      nonce++;
    }
  }
}

// ── Main Cycle ──────────────────────────────────────────
async function sweepAll(wallet, provider, tokens, chainName, gasMultiplier) {
  try {
    await sweepTokens(wallet, provider, tokens, chainName, gasMultiplier);
    // Native sweep disabled — gas kept for token transfers
  } catch (e) {
    console.error(`[${chainName}] Cycle error: ${e.message}`);
  }
}

// ── Monitor Chains ──────────────────────────────────────
async function monitorChain({ name, rpc, tokens, gasMultiplier }) {
  try {
    const provider = new ethers.JsonRpcProvider(rpc);
    const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
    console.log(`✅ Monitoring ${name} | Wallet: ${wallet.address}`);

    setInterval(async () => {
      await sweepAll(wallet, provider, tokens, name, gasMultiplier);
    }, 3000);

  } catch (e) {
    console.error(`Failed to start ${name}: ${e.message}`);
  }
}

// ── Start ───────────────────────────────────────────────
console.log('🛡️  Sweeper Bot Starting...');
console.log('⚡  Frontrun Mode: ON');
console.log('   Ethereum  → 3x gas');
console.log('   BSC       → 2.5x gas');
console.log('   Base      → 2x gas');
console.log('   Arbitrum  → 3x gas');
console.log('📊  Dashboard logging: ON → sweeps.json');
console.log('─────────────────────────────────────────');

CHAINS.forEach(chain => monitorChain(chain));
