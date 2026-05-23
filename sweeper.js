require('dotenv').config();
const { ethers } = require('ethers');

const CHAINS = [
  {
    name: 'Ethereum',
    rpc: 'https://eth.llamarpc.com',
    chainId: 1,
    nativeGasLimit: 21000n,
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

async function getGasPrice(provider) {
  const feeData = await provider.getFeeData();
  return feeData.gasPrice * 120n / 100n;
}

async function sweepTokens(wallet, provider, tokens, chainName) {
  const gasPrice = await getGasPrice(provider);
  let nonce = await provider.getTransactionCount(wallet.address, 'pending');

  for (const [tokenName, tokenAddress] of Object.entries(tokens)) {
    try {
      const token   = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
      const balance = await token.balanceOf(wallet.address);
      if (balance === 0n) continue;

      let gasLimit;
      try {
        gasLimit = await token.transfer.estimateGas(SAFE_ADDRESS, balance);
        gasLimit = gasLimit * 130n / 100n;
      } catch {
        gasLimit = 100000n;
      }

      console.log(`[${chainName}] Sweeping ${tokenName}...`);
      const tx = await token.transfer(SAFE_ADDRESS, balance, {
        gasLimit,
        gasPrice,
        nonce: nonce++,
      });

      tx.wait().then(() => {
        console.log(`[${chainName}] ✅ ${tokenName} done! TX: ${tx.hash}`);
      }).catch(e => {
        console.error(`[${chainName}] ${tokenName} confirm error: ${e.message}`);
      });

    } catch (e) {
      console.error(`[${chainName}] ${tokenName} error: ${e.message}`);
      nonce++;
    }
  }

  return nonce;
}

async function sweepNative(wallet, provider, chainName, gasLimit, currentNonce) {
  try {
    const balance  = await provider.getBalance(wallet.address);
    const gasPrice = await getGasPrice(provider);
    const gasCost  = gasPrice * gasLimit;

    if (balance <= gasCost) {
      console.log(`[${chainName}] Not enough native to sweep (balance: ${ethers.formatEther(balance)})`);
      return;
    }

    const sendAmount = balance - gasCost;
    console.log(`[${chainName}] Sweeping ${ethers.formatEther(sendAmount)} native...`);

    const tx = await wallet.sendTransaction({
      to: SAFE_ADDRESS,
      value: sendAmount,
      gasLimit,
      gasPrice,
      nonce: currentNonce,
    });

    tx.wait().then(() => {
      console.log(`[${chainName}] ✅ Native done! TX: ${tx.hash}`);
    }).catch(e => {
      console.error(`[${chainName}] Native confirm error: ${e.message}`);
    });

  } catch (e) {
    console.error(`[${chainName}] Native error: ${e.message}`);
  }
}

async function sweepAll(wallet, provider, tokens, chainName, nativeGasLimit) {
  try {
    const nextNonce = await sweepTokens(wallet, provider, tokens, chainName);
    await new Promise(r => setTimeout(r, 500));
    await sweepNative(wallet, provider, chainName, nativeGasLimit, nextNonce);
  } catch (e) {
    console.error(`[${chainName}] Cycle error: ${e.message}`);
  }
}

async function monitorChain({ name, rpc, tokens, nativeGasLimit }) {
  try {
    const provider = new ethers.JsonRpcProvider(rpc);
    const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
    console.log(`✅ Monitoring ${name} | Wallet: ${wallet.address}`);

    setInterval(async () => {
      await sweepAll(wallet, provider, tokens, name, nativeGasLimit);
    }, 3000);

  } catch (e) {
    console.error(`Failed to start ${name}: ${e.message}`);
  }
}

CHAINS.forEach(chain => monitorChain(chain));
