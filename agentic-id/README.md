# Agentic ID（ERC-7857 精簡版）

指揮官身份合約與部署腳本。已部署在 0G Galileo 測試網（chain id 16602）：

- 合約：`0xC1Af70aB6Df042Ac0561e2758e2020B8caeE0d97` → https://chainscan-galileo.0g.ai/address/0xC1Af70aB6Df042Ac0561e2758e2020B8caeE0d97
- tokenId `1`，持有者 `0x2CfB6fDc9764035cBb3407087D10Ae13193aFCB9`
- 印章的 `agent_id` = `0xC1Af70aB6Df042Ac0561e2758e2020B8caeE0d97:1`

重新部署（需要 `ethers@6`、`solc@0.8.28`，私鑰放在 `~/.og_minter_key`，不進 repo）：

```bash
npm i ethers@6 solc@0.8.28
node -e "const solc=require('solc'),fs=require('fs');const o=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'AgenticID.sol':{content:fs.readFileSync('AgenticID.sol','utf8')}},settings:{optimizer:{enabled:true,runs:200},outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}})));const c=o.contracts['AgenticID.sol'].AgenticID;fs.writeFileSync('AgenticID.json',JSON.stringify({abi:c.abi,bytecode:'0x'+c.evm.bytecode.object}))"
node deploy_and_mint.mjs <持有者地址>
```
