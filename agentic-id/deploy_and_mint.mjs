// 在 0G Galileo 測試網部署 AgenticID（ERC-7857 精簡版）並 mint 一枚給指揮官持有者。
// 私鑰只從 ~/.og_minter_key 讀，不進 repo、不印出。用法：node deploy_and_mint.mjs <持有者地址>
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const RPC = 'https://evmrpc-testnet.0g.ai';
const TO = process.argv[2];
const { abi, bytecode } = JSON.parse(readFileSync(new URL('./AgenticID.json', import.meta.url), 'utf8'));

const agentMeta = JSON.stringify({
  name: 'ConSSS Wars — Chainoa Enemy Commander',
  model: '0gm-1.0-35b-a3b',
  router: 'https://router-api.0g.ai/v1',
  role: '《鏈之迴響》敵方指揮官：每回合從 valid_actions 選一個行動並附一句戰術意圖',
  seal: 'X-Agent-Proof v1 (sha256 + HMAC + 0G x_0g_trace)',
});
const metadataHash = '0x' + createHash('sha256').update(agentMeta).digest('hex');
const encryptedURI = 'https://hack-0g.consss-play.pages.dev/verify'; // 公開驗證頁；正式版換成 0G Storage 加密 blob

const provider = new ethers.JsonRpcProvider(RPC, 16602);
const wallet = new ethers.Wallet(readFileSync(process.env.HOME + '/.og_minter_key', 'utf8').trim(), provider);
console.log('minter:', wallet.address, 'balance:', ethers.formatEther(await provider.getBalance(wallet.address)), '0G');

const factory = new ethers.ContractFactory(abi, bytecode, wallet);
const contract = await factory.deploy();
console.log('deploy tx:', contract.deploymentTransaction().hash);
await contract.waitForDeployment();
const addr = await contract.getAddress();
console.log('AgenticID contract:', addr);

const tx = await contract.mint(TO, encryptedURI, metadataHash);
console.log('mint tx:', tx.hash);
const rc = await tx.wait();
const ev = rc.logs.map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'Minted');
const tokenId = ev.args.tokenId.toString();
console.log('owner:', await contract.ownerOf(tokenId), 'metadataHash:', await contract.getMetadataHash(tokenId));
console.log('AGENTIC_ID=' + addr + ':' + tokenId);
console.log('explorer: https://chainscan-galileo.0g.ai/address/' + addr);
