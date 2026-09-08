<h1 align="center">ConSSS Wars: Echoes of Chainoa</h1>
<h3 align="center">鏈州英雄傳：鏈之迴響</h3>

<p align="center">
  A hand-drawn, turn-based tactics RPG set on the chain-continent of <b>Chainoa</b> —
  where the battles you win become on-chain <b>Chronicles</b> and the sagas you write are
  preserved on <b>Walrus</b>.
</p>

<p align="center">
  <a href="https://play.conssswars.com"><b>▶ Play now</b></a> ·
  <a href="https://conssswars.com">Website</a> ·
  <a href="https://consss.wal.app">Limited event</a>
</p>

<p align="center">
  <img alt="engine" src="https://img.shields.io/badge/engine-Godot%204.6-478cbf">
  <img alt="chain" src="https://img.shields.io/badge/chain-Sui%20mainnet-6fbcf0">
  <img alt="storage" src="https://img.shields.io/badge/storage-Walrus-1f6feb">
  <img alt="rpc" src="https://img.shields.io/badge/rpc-Tatum-7c3aed">
  <img alt="host" src="https://img.shields.io/badge/host-Cloudflare%20Pages-f38020">
</p>

> This repository is the **deployment repo** for the playable web build at
> [play.conssswars.com](https://play.conssswars.com), **live on Sui mainnet**.
> The game source (Godot project, Move contracts) lives in sibling repos — see
> [Related repositories](#related-repositories).

---

## Overview

**ConSSS Wars** is a browser-first, web3-second tactics RPG. The full game plays
in any modern browser with no install and **no wallet required**. Connect a Sui
wallet and your results stop being throwaway: clear a battle and you can mint a
**Chronicle** — a Sui NFT that records *which* battle you cleared, *how well* you
fought (an on-chain tier), and a personal long-form saga you author, with the
saga JSON stored on **Walrus**.

This repo packages a [Godot 4.6](https://godotengine.org) HTML5 export together
with a vanilla-JS Sui + Walrus dApp bridge, and serves both from **Cloudflare
Pages** with a Pages Function handling the heavy lifting (binary streaming, a
Tatum-keyed RPC proxy, and an anti-cheat mint voucher).

## Features

**Gameplay**
- Turn-based tactical combat with multi-phase boss fights and mid-battle events.
- Painterly, hand-drawn art direction and an original score.
- Fully playable in the browser — no install, no wallet required.

**On-chain (optional, opt-in)**
- **Connect any Sui wallet** — Slush, Sui Wallet, Suiet and other
  [Wallet Standard](https://github.com/wallet-standard/wallet-standard) wallets.
  First-party page, no popup blocking.
- **Tiered Chronicle NFTs** — clearing a battle mints a Chronicle whose rank is
  computed **on-chain** from a per-battle clear counter and your remaining HP.
- **Mint integrity** — every mint is gated by an authority-signed ed25519
  voucher, so a Chronicle cannot be granted by hand-crafting a transaction.
- **Walrus sagas** — the chronicle JSON (battle log + long-form text) is uploaded
  to Walrus; only its blob id is pinned on-chain as `metadata_blob_id`.

## Hackathon integration points

This build integrates two of the track technologies as **core functionality**,
not decoration. The table maps each to exactly where it is used in this repo.

| Technology | Role | Where (browser side) | Where (server side) | Endpoint(s) used |
|------------|------|----------------------|---------------------|------------------|
| **Walrus** (decentralized storage) | Stores the player's Chronicle metadata JSON off-chain; only the returned blob id is pinned on-chain. | `bridge/src/walrus.js` — `uploadString()` **PUTs** the chronicle JSON to a Walrus **publisher** and returns a `blobId`; `fetchString()` / `blobUrl()` resolve it back from a Walrus **aggregator** (also used for NFT Display `image_url`). Exposed as `window.consss.uploadToWalrus` / `readFromWalrus`. | None — the publisher pays for storage, so no server proxy and no extra wallet tx are needed. | Publisher `PUT {publisherUrl}/v1/blobs?epochs={n}` · Aggregator `GET {aggregatorUrl}/v1/blobs/{blobId}` |
| **Tatum API** (Sui RPC gateway) | The track's RPC gateway for all Sui JSON-RPC reads (owned-object queries, etc.). | `bridge/src/sui-client.js` — `SuiClient` is pointed at the **same-origin** `/rpc` path (`config.rpcProxyPath`), never at Tatum directly. The Tatum key is never in the browser bundle. | `functions/[[path]].js` (`/rpc` branch) injects the **Tatum** API key as an `x-api-key` header server-side, forwards to the Tatum gateway, and **falls back to the public Sui fullnode** on any error. | `POST /rpc` → `https://sui-mainnet.gateway.tatum.io` (key from `TATUM_API_KEY`) → public fullnode fallback |

**Mainnet Walrus endpoints** (from `bridge/config.public.js`): publisher
`https://walrus-publisher.rubynodes.io`, aggregator
`https://aggregator.walrus-mainnet.walrus.space`, `storageEpochs = 5`.

> **Why the community rubynodes publisher?** Mysten does not run a free public
> **publisher** on Walrus mainnet (writes cost storage), so the bridge uses the
> community **rubynodes** publisher for uploads. Reads use the standard Walrus
> mainnet **aggregator**. Both are plain HTTP — the documented Walrus Web API
> pattern — so no client-side encoding or extra wallet signature is required.

## Architecture

A Godot 4 HTML5 export produces two binaries far larger than Cloudflare Pages'
per-file limit, so the build is split across hosts and stitched back together at
the edge. The browser only ever talks to `play.conssswars.com`.

```
                         play.conssswars.com  (Cloudflare Pages)
   browser ──────────────────────────┬─────────────────────────────────
                                      │
   public/  (static shell, < 2 MB)    │  functions/[[path]].js  (Pages Function)
   • index.html                       │  • /index.wasm ┐ proxied + edge-cached
   • index.js loader + audio worklets │  • /index.pck  ┘ from GitHub Releases
   • dist/ wallet bridge bundle       │      (same-origin; fixes CORS + Content-Type)
   • _headers · _redirects            │  • /rpc          → Tatum (server key) → public RPC
                                      │  • /mint-voucher → ed25519 voucher (anti-cheat)
                                      │
            GitHub Releases (ConsssLab/play, releases/latest/download):
                       index.pck (~385 MB) + index.wasm (~36 MB)

   Walrus (no proxy): browser ── PUT ──▶ rubynodes publisher  (write saga JSON)
                      browser ── GET ──▶ walrus-mainnet aggregator (read saga JSON)
```

What each piece does:

- **Static shell on Pages** — `index.html`, the Godot loader (`index.js`), the
  two audio worklets, the icon, and the built wallet bridge bundle.
- **Engine binaries on GitHub Releases** — `index.pck` (~385 MB) and
  `index.wasm` (~36 MB) exceed both Cloudflare Pages' 25 MiB/file limit and
  GitHub's 100 MB git limit, so each deploy uploads them as Release assets.
- **The Pages Function stitches it together** (`functions/[[path]].js`):
  - **Binary proxy** — a plain redirect to GitHub fails CORS (release assets send
    no `Access-Control-Allow-Origin`), so the Function fetches `index.wasm` /
    `index.pck` from `releases/latest/download/` server-side and streams them back
    **same-origin** with the correct `Content-Type` (so WASM streaming
    compilation works). It **edge-caches** them under a version-stamped key that
    the deploy script bumps per release, so repeat loads are fast and a new
    release retires the old cached bytes automatically.
  - **`/rpc`** — a Sui JSON-RPC proxy. The browser's `SuiClient` POSTs here; the
    Function injects the **Tatum** API key (`x-api-key`) server-side and forwards,
    falling back to the public Sui fullnode on any failure.
  - **`/mint-voucher`** — signs an authority ed25519 voucher binding the mint to
    `(registry, player, battle, hero, hp_pct, nonce, expiry)`. See
    [Security model](#security-model).
- **Single-threaded export** — cross-origin isolation is intentionally disabled
  (`ensureCrossOriginIsolationHeaders: false`, no COOP/COEP), so no
  SharedArrayBuffer setup is needed and the cross-origin engine load is not
  blocked. *Keep the Godot export single-threaded or this hosting model breaks.*

### dApp bridge

`bridge/` builds a vanilla-JS (no React, no dapp-kit) bundle that exposes
`window.consss = { connect, mint, uploadToWalrus, readFromWalrus,
getOwnedChronicles }` so the Godot HTML5 shell can drive Sui + Walrus via
`JavaScriptBridge`. The mint flow is:

1. Upload the chronicle JSON to **Walrus** (publisher HTTP API) → get a blob id.
2. `POST /mint-voucher` with the clear report → get an authority-signed voucher.
3. Build and sign `chronicle::chronicle::mint_chronicle` with the player's own
   wallet, passing the report + voucher + `metadata_blob_id`; the tier is
   computed on-chain. The server never holds player funds.

`bridge/config.public.js` contains **only public on-chain data** (network,
package/registry IDs, Walrus endpoints, `/rpc` path) — no secrets — and is safe
to commit and ship in the browser bundle.

## Configuration

### Public config (committed)

`bridge/config.public.js` — network, RPC proxy path, on-chain IDs, and Walrus
endpoints. Public data only; bundled into the browser. See
[On-chain deployments](#on-chain-deployments).

### Server-side secrets (Cloudflare only)

Secrets live **only** as Cloudflare Pages environment variables / bindings on the
`consss-play` project and are read solely inside the Pages Function. They are
never bundled, never committed, never shipped to the browser.

| Variable | Required | Purpose |
|----------|----------|---------|
| `TATUM_API_KEY` | yes | Tatum Sui gateway key injected into `/rpc` (falls back to public RPC if unset/failing). |
| `AUTHORITY_PRIVKEY_HEX` | yes | ed25519 private key that signs `/mint-voucher` vouchers. |
| `CHRONICLE_REGISTRY_ID` | yes | Registry id the voucher is bound to (anti cross-deployment replay). |
| `CHRONICLE_TYPE` | optional | Chronicle struct type (`0x<pkg>::chronicle::Chronicle`) — enables the progression gate. |
| `MINT_KV` | optional | KV binding for the per-`(wallet, battle)` mint rate limit. |
| `TATUM_RPC_URL` / `PUBLIC_RPC_URL` | optional | Override the default mainnet Tatum / public fullnode endpoints. |

> Deploying also requires a Cloudflare API token at `~/.cf_token` (Pages → Edit)
> and the account id via `CLOUDFLARE_ACCOUNT_ID` or `~/.cf_account`. These are
> local-only and never enter git. The token should be deleted/revoked after use.

## Security model

This is an honest, scoped model: a fully client-side game can never make the
client untrusted by itself, so we are explicit about what the current defenses
**do** guarantee, what they **don't yet**, and why that trade-off is acceptable
today.

### Defenses we have today

- **No secrets in the browser.** The Tatum API key and the voucher authority
  ed25519 signing key are Cloudflare **runtime secrets**, read only inside the
  Pages Function. Local deploys read a Cloudflare API token from a deploy-only
  `~/.cf_token`. None of these are ever in the committed browser bundle —
  `config.public.js` holds public IDs/URLs only. Rotating a key is a dashboard
  change, no rebuild.
- **Same-origin `/rpc` proxy.** The browser POSTs to `/rpc`; the Function
  attaches the Tatum key server-side and forwards, falling back to the public
  fullnode. The key never reaches the browser and there is no CORS surface.
- **Single mint chokepoint.** `/mint-voucher` is the *only* way to obtain a valid
  voucher, and the on-chain contract **rejects any mint without one**. So even
  though anyone can craft a Sui transaction, nobody can mint a Chronicle without
  going through our server. It signs an ed25519 voucher over `(registry, player,
  battle, hero, hp_pct, nonce, expiry)`; the contract verifies signature, sender,
  nonce (anti-replay), expiry, and computes the tier itself. Players sign the
  mint with their own wallet.
- **Layer-1 anti-scripting guards** on `/mint-voucher`:
  - **Origin check** — only requests from `https://play.conssswars.com` are
    served (filters casual `curl` / foreign-site scripting).
  - **KV rate limit** — a per-`(wallet, battle)` cooldown via the `MINT_KV`
    binding, throttling automated re-requests.
  - **Progression gate** — battle *N* requires already owning the battle *N-1*
    Chronicle (queried via RPC), so the sequence can't be skipped.
  - Rate limit and progression gate are **graceful** — they skip cleanly if
    `MINT_KV` / `CHRONICLE_TYPE` are unset.
- **Versioned edge caching** of the engine binaries, so a new release retires
  old cached bytes by key bump (no broad cache-purge token scope needed).

### What we do NOT (yet) do — stated plainly

The Layer-1 guards plus the voucher chokepoint give us **anti-scripting**: they
stop casual automation and they stop hand-crafted-PTB mints that bypass the
server. They do **not** stop a determined player from driving the real client
and reporting a *favorable* result, because `/mint-voucher` still **trusts the
client-reported `hp_pct` / `battle_id`**. There is no server-authoritative
simulation today, so that is the documented ceiling of the current design.

**Why we accept this for now.** Every mint costs **real Sui mainnet gas**, paid
by the attacker, and the reward is a collectible NFT — there is no token,
yield, or marketplace value to extract. For a small project, the cost and effort
of a sophisticated client-tampering exploit is high relative to that reward, so
hardening past anti-scripting is not yet worth it. We chose to ship an honest
chokepoint now rather than over-build.

### Planned future anti-cheat ("no real play, no mint")

The next hardening step makes the result **server-verified** instead of
client-trusted, in two layers:

1. **Server-authoritative validation** — the backend deterministically
   **re-simulates / replays** the battle from a server-seeded start using the
   recorded player inputs, and only issues a voucher if the replayed outcome
   matches the claimed `hp_pct` / clear.
2. **zk-proof of correct play** — a zero-knowledge proof that a valid play
   session produced the claimed result, so the server can verify *without*
   trusting (or even re-running) the raw client trace.

**Importantly, neither requires a smart-contract change.** The voucher interface
(`mint_chronicle` + the signed message format) stays exactly as it is today; only
the **backend's decision to sign** gets stricter. That keeps this upgrade path
fully forward-compatible with the deployed mainnet package.

## 0G Taipei Hackathon — 可驗證的敵方指揮官 Agent（hack/0g 分支）

> 賽道 A（可驗證推理）＋ B（有身份的 Agent）。把《鏈之迴響》關卡裡腳本化的敵方
> AI，換成兩個持有 **0G Agentic ID**（ERC-7857 ＋ 官方 ERC-8004）的 Agent：
> 偵察官讀盤面、指揮官下決定，每一跳都經 **0G Compute Router**（模型 `0GM-1.0-35B-A3B`，
> TEE 驗證）推理，並各封成一枚 **X-Agent-Proof 印章**；戰鬥結束一鍵開瀏覽器逐章驗證。
>
> **為什麼要做**：目前鏈上戰績靠我方伺服器自簽的 ed25519 voucher 才發得出去，
> 玩家必須先相信 ConSSS 沒作弊。換成 TEE 簽出的章之後，「AI 判了什麼」變成
> 任何人都能獨立驗證的事實，不需要相信我們。

**5 分鐘 Pitch 頁**：https://0g.conssswars.com/pitch （`public/pitch.html`）

### 目前做到哪（2026-09-09）

| 評審要求／加分項 | 狀態 | 證據 |
|---|---|---|
| 真的發出 0G API 請求 | ✅ | `router-api.0g.ai`，每回合兩次（偵察官、指揮官），回應帶 `x_0g_trace.tee_verified: true` |
| 能跑的 Demo | ✅ | Godot 桌面版第二關 Boss 戰；線上 https://0g.conssswars.com/verify 現場驗章 |
| 公開 repo ＋ README 指出整合點 | ✅ | 本節下方表格 |
| 現場驗證證明 | ✅ | 結算「在瀏覽器驗證」一鍵帶入全部印章，逐章亮綠（含鏈上 ownerOf 與 provider TEE 簽名） |
| 同時用上 Router 與 Agentic ID | ✅ | ERC-7857 `0xC1Af…0d97:1` ＋ 官方 ERC-8004 agentId 396 |
| 使用模型 0GM-1.0-35B-A3B | ✅ | Router id `0gm-1.0-35b-a3b`，Private tier（TeeML / TDX） |
| 多 Agent 協作 | ✅ | 偵察官 → 指揮官，每跳出章，`parent` 串成證明鏈 |
| 賽道 C：印章上鏈（Reputation Registry 留評） | ⏳ Roadmap | 見文末 |

### 整合點（評審請看這裡）

| 事情 | 檔案 | 位置 |
|---|---|---|
| **真的打到 0G Compute Router 的那一行** | `functions/agent/decide.js` | `callRouter()` 內的 `fetch(url, …)` → `https://router-api.0g.ai/v1/chat/completions`；模型 `0gm-1.0-35b-a3b`（Router 的 id，name 為 0GM-1.0-35B-A3B，TEE 型別 TDX）；請求帶 `verify_tee: true` |
| Router 驗證標頭（一行替換點 ①） | `functions/agent/decide.js` | `sign_request()`。`Authorization: Bearer sk-…`；0G 文件明載不需 per-request 錢包簽名 |
| **多 Agent 協作（每跳出章）** | `functions/agent/decide.js` | `onRequestPost`：偵察官 Agent（`buildScoutMessages`）→ 指揮官 Agent（`buildMessages`），兩跳都走 0G Router；指揮章的 `parent` = 偵察章 `proof_id`，串成證明鏈 |
| **ERC-8004 身份** | `public/agent-card.json` | 官方 Identity Registry（Galileo `0x8004A818…BD9e`）agentId **396**，agentURI 指向這份 registration-v1 卡片；每枚印章帶 `erc8004_agent_id` |
| TEE 證明取值（一行替換點 ②） | `functions/agent/decide.js` | `extract_proof()`。讀 `ZG-Res-Key` header ＋ `x_0g_trace.{request_id, provider, tee_verified}`，再向 provider 本人取 EIP-191 簽名 `{text, signature}` 與 `teeSignerAddress`，封成 JSON 字串進印章 |
| **印章在哪裡封出** | `functions/agent/decide.js` | `sealDecision()`：`proof_id = sha256(payload)[:16]`、`sig = EIP-191 personal_sign(payload)` by Agentic ID 持有者錢包（`eip191Sign()`，secp256k1）；`extract_proof()` 依官方 Verifiable Execution 流程向 provider 取 TEE 簽名（`getService` → `/v1/proxy/signature/{chatID}`）一併封入 |
| **印章在哪裡驗證** | `functions/agent/verify.js` | `onRequestPost`：重算 `proof_id`；`eip191Recover()` 還原簽名者並對照鏈上 ERC-7857 `ownerOf(1)` 與 ERC-8004 `ownerOf(396)`（Galileo eth_call）；`verify_router_proof()` 檢查 `tee_verified` 且 provider TEE 簽名 ecrecover == `teeSignerAddress` |
| 現場驗證頁 | `public/verify.html` | 純靜態、無 build、無外部依賴，手機可開。貼印章／`proof_id`，或由遊戲一鍵帶入 `#seals=<base64url>`（fragment 不經伺服器）→ 逐章亮燈 |
| ERC-7857 合約原始碼與部署腳本 | `agentic-id/` | `AgenticID.sol`、`deploy_and_mint.mjs` |
| 遊戲端 HTTP 封裝 | `app/godot/scripts/battle/agent_client.gd`（private repo） | `decide()` / `verify()`；逾時或非 2xx 回空 Dictionary |
| 遊戲端接線 | `app/godot/scripts/battle/turn_battle.gd`（private repo） | 玩家回合開始就預取（`_og_prefetch_commander_decision`）→ 敵方回合消費（`_og_consume_pending_decision`）→ 偵察簡報、指揮官思路與印章 hash 顯示在既有 `EnemyActionLabel` 旁（`_og_proof_label`）→ 結算「驗證這場戰鬥」逐章驗（`_on_og_verify_pressed`）與「在瀏覽器驗證」一鍵帶入全部印章（`_on_og_copy_pressed`） |

**回退哲學（沿用 `backend/src/llm.mjs`）**：key 未設、逾時、非 2xx、回覆解析失敗、
行動不在合法池內 —— `/agent/decide` 一律回 **HTTP 200 + `{ fallback: true }`**，
遊戲端退回既有的確定性 simple AI。網路完全拔掉，戰鬥照樣能打完。

**延遲藏在哪**：玩家回合一開始就向 `/agent/decide` 預取「下一回合」的指揮官決策，
LLM 的幾秒延遲落在玩家思考技能的時間裡；敵方回合開始時直接消費結果。

### Agentic ID（賽道 B：有身份的 Agent）

指揮官的身份是一枚 ERC-7857 Agentic ID，mint 在 **0G Galileo 測試網**（chain id 16602）：

| 項目 | 值 |
|---|---|
| AgenticID 合約 | [`0xC1Af70aB6Df042Ac0561e2758e2020B8caeE0d97`](https://chainscan-galileo.0g.ai/address/0xC1Af70aB6Df042Ac0561e2758e2020B8caeE0d97) |
| tokenId | `1`，持有者 `0x2CfB6fDc9764035cBb3407087D10Ae13193aFCB9` |
| 部署 tx | [`0x4c3f427f…4fc32a`](https://chainscan-galileo.0g.ai/tx/0x4c3f427f85f8f740479e8866fb1e8fc14085755fc9887599be5b10c1d44fc32a) |
| mint tx | [`0x65940b5b…362b5c`](https://chainscan-galileo.0g.ai/tx/0x65940b5b5046d8524faad8d4b418317770d1294c9d369fc5ad3bd37d34362b5c) |
| metadataHash | `0xbd196d21…205378` = sha256(指揮官 system prompt + 模型設定) |
| **ERC-8004 Identity Registry**（0G 官方） | Galileo `0x8004A818BFB912233c491871b3d84c89A494BD9e`，agentId **396**，[註冊 tx `0xa1cb1373…3f6145`](https://chainscan-galileo.0g.ai/tx/0xa1cb137353bf0ae671beaa5812ea11b485cf3370bdc860e16d85aa274b3f6145)，agentURI → [`/agent-card.json`](https://0g.conssswars.com/agent-card.json) |

合約介面照 [0G Agentic ID 整合指南](https://docs.0g.ai/developer-hub/building-on-0g/agentic-id/integration)：
`mint(recipient, encryptedURI, metadataHash)` / `ownerOf` / `getMetadataHash` / `getEncryptedURI`。
每一枚印章的 `agent_id` 欄位就是 `<合約>:<tokenId>`，由 `OG_AGENT_ID` 環境變數注入，
驗章時 `details.agent_id` 會回顯，評審可對照鏈上 `ownerOf(1)`。

### X-Agent-Proof 印章的簽章方式（v3）

- **誰簽**：Agentic ID 持有者錢包 `0x2CfB…FCB9` 以 **EIP-191 `personal_sign`（secp256k1）** 對正規化 payload 簽名。
  驗證器 `ecrecover` 出簽名者後，對照鏈上 ERC-7857 `ownerOf(1)` 與 ERC-8004 `ownerOf(396)`——
  **任何人可離線驗證、免 gas、不需要 ConSSS 的任何 secret**。
- **TEE 證據**：依 0G 官方 Verifiable Execution 文件，封章時向 provider 本人取
  `GET {provider.url}/v1/proxy/signature/{chatID}` 的 `{text, signature}`，連同鏈上 `teeSignerAddress` 封入；
  驗證時 `ecrecover(EIP-191(text), signature) == teeSignerAddress`，不信任 Router 也能核對。
- **證明鏈**：偵察官章 → 指揮官章（`parent`），一回合兩枚，皆帶 `erc8004_agent_id: 396`。
- **回退**：0G Router 失敗 → OpenAI 相容端點（印章標 `backend: openai-fallback`，無 TEE）→ 遊戲端確定性 AI。

### 印章長什麼樣（v3，真實樣本節錄）

```json
{
  "v": 3, "role": "commander", "parent": "f38a4dbdf37a8584", "backend": "0g-router",
  "erc8004_agent_id": "396", "agent_id": "0xC1Af70aB6Df042Ac0561e2758e2020B8caeE0d97:1",
  "model": "0gm-1.0-35b-a3b", "civilization": "sui", "turn": 3,
  "board_hash": "ec3e5c7c…c5cce", "action": "Overload Burst", "target": "player",
  "intent_text": "趁敵方架式高時，以爆發技擊潰其防線。",
  "chat_id": "chatcmpl-aa80c54a-…",
  "router_proof": "{\"res_key\":\"aa80c54a-…\",\"request_id\":\"6f1084c1-…\",\"provider\":\"0x4870CbC4…a4E9\",\"tee_verified\":true,\"tee_signer\":\"0xed42c0a6…5f22\",\"tee_text\":\"188f4e87…:c2b4a4b9…\",\"tee_signature\":\"0xc6238aba…\",\"reply_sha256\":\"ce5427bc…\"}",
  "ts": 1788891990200,
  "proof_id": "cbe4f49047f26289",
  "sig": "0x8f34b3e4…1b", "sig_scheme": "eip191-secp256k1",
  "signer": "0x2cfb6fdc9764035cbb3407087d10ae13193afcb9"
}
```

`verify.js` 逐項回報：`shape` / `proof_id_match` / `signer`（ecrecover）/ `owner_erc7857_onchain` /
`owner_erc8004_onchain` / `signer_is_owner` / `router_proof_valid` / `tee_signature_valid` / `parent`。
任何一個欄位被改（例如把 `action` 改掉），`proof_id_match` 與 `signer_is_owner` 立刻變 `false`。

### 本機執行

```bash
# 0. 依賴（@noble/secp256k1、@noble/hashes 供 EIP-191 簽章／ecrecover）
cd play && npm ci

# 1. 起 Pages Functions（同源，不需 CORS）。金鑰放 .dev.vars（已 gitignore），沒設也能跑：decide 會回 fallback。
cat > .dev.vars <<'EOF'
OG_API_KEY=sk-<在 pc.0g.ai 建的 API key>
OG_AGENT_ID=0xC1Af70aB6Df042Ac0561e2758e2020B8caeE0d97:1
OG_ERC8004_AGENT_ID=396
OG_SIGNER_KEY=0x<Agentic ID 持有者錢包私鑰，測試網用>
OG_SIGNER_ADDRESS=0x2CfB6fDc9764035cBb3407087D10Ae13193aFCB9
EOF
npx wrangler pages dev public --port 8788

# 2. 手動打一發
curl -s -X POST localhost:8788/agent/decide -H 'content-type: application/json' \
  -d '{"civilization":"sui","turn":3,"board_state":{"valid_actions":["Arc Slash","Heavy Strike"]}}'

# 3. 驗證頁
open http://localhost:8788/verify

# 4. 遊戲端：在 Godot 4.6 開 ../app/godot，切到 hack/0g 分支，直接跑任一關的 Boss 戰。
#    桌面版打 http://127.0.0.1:8788（agent_client.gd 頂端常數）；Web 版自動同源。
```

環境變數（CF Pages 專案設定或 `--binding`）：`OG_API_KEY`（必要，未設即 fallback；在 pc.0g.ai 連錢包、儲值、建 `sk-` key）、
`OG_ROUTER_URL`（預設 `https://router-api.0g.ai/v1/chat/completions`）、`OG_MODEL`（預設 `0gm-1.0-35b-a3b`）、
`OG_AGENT_ID`（ERC-7857 `<合約>:<tokenId>`）、`OG_ERC8004_AGENT_ID`（396）、
`OG_SIGNER_KEY` / `OG_SIGNER_ADDRESS`（Agentic ID 持有者錢包，EIP-191 封章；未設時退回 HMAC 開發模式 `sig_scheme: hmac-dev`）、
`OG_SEAL_SECRET`（HMAC 開發模式用）、`OPENAI_API_KEY`（選配第二層回退）、
`OG_TIMEOUT_MS`（預設 7000）、選配 KV 綁定 `AGENT_KV`。本機開發把這些放在 `.dev.vars`（已 gitignore）。

### Preview URL

部署到 Cloudflare Pages 的 **preview 分支**，不動正式站：

```bash
npx wrangler pages deploy public --project-name consss-play --branch hack-0g
```

- **子網域：https://0g.conssswars.com/**（CNAME → `hack-0g.consss-play.pages.dev`，正式站 play.conssswars.com 不受影響）
- Pitch：https://0g.conssswars.com/pitch · 驗證頁：https://0g.conssswars.com/verify · Agent 卡片：https://0g.conssswars.com/agent-card.json
- 端點：`POST /agent/decide`、`POST /agent/verify`
- 注意：線上首頁的遊戲仍是 v1.0.0 的 Web 匯出（未含本分支的 Godot 改動），戰鬥內的印章 Demo 走 Godot 桌面版；
  線上提供的是驗證頁、兩支 API、Agent 卡片與 Pitch。

### Roadmap（黑客松後）

- 賽道 C：每場戰鬥的印章 Merkle root 寫進 0G 官方 ERC-8004 Reputation Registry（Galileo `0x8004B663…8713`），成為 On-Chain Agent。
- 把「AI 判斷可驗證」延伸到「整場戰鬥可驗證」：server 重播或 zk-proof 驗證結算公式。
- Agentic ID 的智慧內容改存 0G Storage 加密 blob；Web 匯出重新打包，讓線上也能看到戰鬥內印章。

## Local development

Prerequisites: Node 18+ and (for serving Functions locally) `wrangler`.

```bash
# Build the wallet bridge bundle into public/dist/
cd bridge
npm install
npm run build          # or: npm run build:watch

# Serve the static shell + Pages Function locally
cd ..
npx wrangler pages dev public
```

Notes:
- The engine binaries (`index.wasm`, `index.pck`) are **not** in this repo; they
  are served from GitHub Releases in production. To run the full game locally,
  drop a fresh Godot Web export's `index.wasm` / `index.pck` into `public/`.
- For the wallet/mint/RPC paths to work locally, provide the server env vars
  above to `wrangler pages dev` (e.g. via `--binding` / a `.dev.vars` file).

## Deployment

Deploys are **manual by design** — a human gate against shipping a bad build, and
the Cloudflare token never lives in GitHub. One command runs the whole pipeline:

```bash
# 1. In Godot: export the "Web" preset (keep thread support OFF) to
#    ../app/exports/web/  (override the path as an arg if different)

# 2. From this repo root:
scripts/deploy.sh [EXPORT_DIR]   # default EXPORT_DIR = ../app/exports/web
```

`scripts/deploy.sh` will:
1. Copy the fresh export's loader + audio worklets into `public/` (the committed
   `index.icon.png` is intentionally kept).
2. Build the wallet bridge (no secrets baked in).
3. Upload `index.wasm` + `index.pck` to a timestamped GitHub Release.
4. Stamp the Function's edge-cache version with the release tag (automatic
   cache-bust), then restore the working tree afterward.
5. `wrangler pages deploy public` → the `consss-play` project.
6. Verify `/`, `/index.wasm`, `/index.pck` over HTTPS.

**One-time setup:** create the `consss-play` Pages project, set the server env
vars from [Configuration](#configuration), and point the custom domain
`play.conssswars.com` at the project. Remember to `rm -f ~/.cf_token` and revoke
the token when finished.

## Repository layout

```
public/                      Cloudflare Pages output (static shell)
├── index.html               game shell (cross-origin isolation off; loads bridge + engine)
├── index.js                 Godot Web loader
├── index.audio*.worklet.js  audio worklets
├── index.icon.png           committed favicon
├── dist/                    built wallet bridge bundle (gitignored)
├── _headers · _redirects    edge caching / routing policy
functions/
└── [[path]].js              Pages Function: binary proxy + /rpc (Tatum) + /mint-voucher
bridge/                      Sui + Walrus wallet bridge (esbuild → public/dist)
├── config.public.js         public IDs / URLs only — no secrets
├── scripts/build.mjs        esbuild driver
└── src/                     index · bridge · wallet · sui-client · walrus · mint · chronicles
scripts/
└── deploy.sh                one-command manual deploy
```

The built bridge (`public/dist/`) and the engine binaries (`*.wasm`, `*.pck`)
are gitignored: the bridge is built at deploy time, the binaries live in Releases.

## On-chain deployments

**Network: Sui mainnet.** IDs below are public on-chain data (mirrored in
`bridge/config.public.js`).

| Object | ID |
|--------|----|
| Chronicle package | `0x5760b2685d41bd45e2991dedc242e866b1aca9ff3c3a5e193445751c2b8dfe4b` |
| Chronicle registry (shared) | `0x9ff1d9e50e8feca77ccddf5901bd774d3baa4732dac37ae261ca36b2352ced8b` |
| Finale registry (shared) | `0x2c752d82144701e2b476cd35fd8c5482c9f3aabfe27e155729b657b369493d19` |
| Walrus (mainnet) | publisher `walrus-publisher.rubynodes.io` · aggregator `aggregator.walrus-mainnet.walrus.space` · 5 epochs |

## Tech stack

| Layer | Tech |
|-------|------|
| Game engine | Godot 4.6 → HTML5 (single-threaded, WebGL2) |
| Smart contracts | Sui Move (mainnet) — Chronicle NFT, tiers, mint voucher |
| Decentralized storage | Walrus — chronicle saga blobs (HTTP publisher/aggregator) |
| Wallet | `@mysten/wallet-standard` (vanilla JS, no React) |
| Sui SDK | `@mysten/sui` · `@mysten/walrus` |
| Hosting | Cloudflare Pages + Pages Functions + GitHub Releases (engine binaries) |
| RPC | Tatum Sui gateway (server-side key) with public fullnode fallback |
| Bundler | esbuild |

## Related repositories

| Site / repo | URL | Host |
|-------------|-----|------|
| Game source (Godot + Move) | [`ConsssLab/app`](https://github.com/ConsssLab/app), [`ConsssLab/contracts`](https://github.com/ConsssLab/contracts) | — |
| `conssswars.com` — official site | [`official-website`](https://github.com/ConsssLab/official-website) | Cloudflare Pages |
| `consss.wal.app` — limited event | [`official-limit-time-event`](https://github.com/ConsssLab/official-limit-time-event) | Walrus Sites |

## License

© ConsssLab. All rights reserved. Game art, music, and story are proprietary;
see the individual source repositories for any code-specific licensing.
