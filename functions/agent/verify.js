// Cloudflare Pages Function — POST /agent/verify
//
// 離線驗證一枚 X-Agent-Proof 印章。
//   收：{ proof }            完整印章物件（decide.js 回的 proof）
//   或：{ proof_id }         只有 id；需綁 AGENT_KV 才查得到完整印章
//   回：{ valid, details }   details 逐項列出每個檢查的結果，永遠 HTTP 200
//
// 驗證規則與 decide.js 的封章規則一對一（依 0G 官方文件對齊）：
//   1. proof_id  == sha256(payload) 前 16 碼                      → 印章內容沒被竄改
//   2. sig：EIP-191 ecrecover(payload, sig) == Agentic ID 持有者   → 印章確實由這個身份簽出
//        持有者 = OG_SIGNER_ADDRESS，並 best-effort 對照鏈上 ERC-7857 ownerOf(tokenId)
//        與 ERC-8004 Identity Registry ownerOf(agentId)（Galileo）
//        （sig_scheme 為 hmac-dev 的舊印章仍以 HMAC 驗）
//   3. router_proof：x_0g_trace.tee_verified、provider 地址，
//        以及 provider 在 TEE 內的 EIP-191 簽名 ecrecover == teeSignerAddress
//   4. action 非空、turn 為正整數                                  → 基本形狀

import { buildSealPayload, sha256Hex, hmacHex, eip191Recover, keccakSelector } from './decide.js';

const OG_TESTNET_RPC = 'https://evmrpc-testnet.0g.ai';
// 0G 官方 ERC-8004 Identity Registry（Galileo，docs.0g.ai/developer-hub/building-on-0g/agentic-id/erc8004）
const ERC8004_IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const RPC_TIMEOUT_MS = 3000;

const DEV_SEAL_SECRET = 'consss-0g-dev-seal'; // 與 decide.js 相同

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonOut({ valid: false, details: { error: 'bad json' } });
  }

  let proof = body && body.proof;
  if ((!proof || typeof proof !== 'object') && body && body.proof_id) {
    proof = await lookupById(env, String(body.proof_id));
    if (!proof) {
      return jsonOut({ valid: false, details: { error: 'proof_id 查無印章（未綁 AGENT_KV 或已過期），請貼入完整印章' } });
    }
  }
  if (!proof || typeof proof !== 'object') {
    return jsonOut({ valid: false, details: { error: '缺少 proof' } });
  }

  const details = {};
  try {
    details.shape = typeof proof.action === 'string' && proof.action.length > 0
      && Number.isInteger(proof.turn) && proof.turn > 0
      && typeof proof.proof_id === 'string' && proof.proof_id.length === 16;

    const payload = buildSealPayload({
      v: proof.v || 1,
      role: proof.role,
      parent: proof.parent === undefined ? null : proof.parent,
      backend: proof.backend || '0g-router',
      erc8004_agent_id: proof.erc8004_agent_id === undefined ? null : proof.erc8004_agent_id,
      agent_id: proof.agent_id,
      model: proof.model,
      civilization: proof.civilization,
      turn: proof.turn,
      board_hash: proof.board_hash,
      action: proof.action,
      target: proof.target,
      intent_text: proof.intent_text,
      chat_id: proof.chat_id,
      router_proof: proof.router_proof === undefined ? null : proof.router_proof,
      ts: proof.ts,
    });

    const expectedId = (await sha256Hex(payload)).slice(0, 16);
    details.proof_id_match = expectedId === proof.proof_id;

    details.sig_scheme = proof.sig_scheme || 'hmac-dev';
    if (details.sig_scheme === 'eip191-secp256k1') {
      // 任何人都能做的離線驗證：ecrecover 出簽名者，對照 Agentic ID 持有者。
      const recovered = safeRecover(payload, proof.sig);
      details.signer = recovered;
      const expected = String(env.OG_SIGNER_ADDRESS || '').toLowerCase();
      details.signer_expected = expected || null;
      const [owner7857, owner8004] = await Promise.all([
        ownerOf(env, agenticIdContract(proof.agent_id), agenticIdToken(proof.agent_id)),
        proof.erc8004_agent_id ? ownerOf(env, ERC8004_IDENTITY_REGISTRY, proof.erc8004_agent_id) : Promise.resolve(null),
      ]);
      details.owner_erc7857_onchain = owner7857;
      details.owner_erc8004_onchain = owner8004;
      const r = recovered ? recovered.toLowerCase() : null;
      details.signer_is_owner = Boolean(r) && (
        (expected && r === expected) || (owner7857 && r === owner7857.toLowerCase()) || (owner8004 && r === owner8004.toLowerCase())
      );
      details.sig_match = details.signer_is_owner;
      details.dev_secret = false;
    } else {
      const secret = env.OG_SEAL_SECRET || DEV_SEAL_SECRET;
      const expectedSig = await hmacHex(secret, payload);
      details.sig_match = typeof proof.sig === 'string' && timingSafeEqualHex(expectedSig, proof.sig);
      details.dev_secret = !env.OG_SEAL_SECRET;
    }

    details.backend = proof.backend || '0g-router';
    details.erc8004_agent_id = proof.erc8004_agent_id || null;
    details.router_proof_present = Boolean(proof.router_proof);
    const rp = await verify_router_proof(proof.router_proof, payload, env);
    details.router_proof_valid = rp.valid;
    details.tee_provider = rp.provider;
    details.tee_signature_present = rp.sigPresent;
    details.tee_signature_valid = rp.sigValid;
    details.tee_signer = rp.teeSigner;

    details.role = proof.role || 'commander';
    details.parent = proof.parent || null;
    details.agent_id = proof.agent_id || null;
    details.model = proof.model || null;
    details.turn = proof.turn;
    details.action = proof.action;
    details.sealed_at = proof.ts ? new Date(Number(proof.ts)).toISOString() : null;
  } catch (e) {
    return jsonOut({ valid: false, details: { error: String((e && e.message) || e) } });
  }

  // TEE 證明缺席時不視為失敗（Router 尚未提供 header 也能驗我方封章），
  // 但若「有」證明且驗不過，整枚印章判定無效。
  const valid = details.shape && details.proof_id_match && details.sig_match
    && (!details.router_proof_present || details.router_proof_valid);
  return jsonOut({ valid, details });
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return jsonOut({ valid: false, details: { error: 'POST only' } });
}

// ── TEE 證明的驗證（依 0G 官方 Verifiable Execution 文件）──
// router_proof 是 decide.js extract_proof() 封進的 JSON 字串：
//   { res_key, request_id, provider, tee_verified, tee_signer, tee_text, tee_signature, reply_sha256 }
// 判定：
//   a) tee_verified === true、provider 是合法地址、request_id 非空（Router 同步驗過）
//   b) 若封章時拿到了 provider 的簽名：ecrecover(EIP-191(tee_text), tee_signature) == tee_signer
//      —— 這是不信任 Router 也能做的離線核對；拿到卻驗不過則整枚無效。
async function verify_router_proof(routerProof, _payload, _env) {
  const out = { valid: false, provider: null, sigPresent: false, sigValid: null, teeSigner: null };
  if (!routerProof || typeof routerProof !== 'string') return out;
  let p;
  try { p = JSON.parse(routerProof); } catch (_) { return out; }
  if (!p || typeof p !== 'object') return out;
  const providerOk = typeof p.provider === 'string' && /^0x[0-9a-fA-F]{40}$/.test(p.provider);
  const idOk = typeof p.request_id === 'string' && p.request_id.length > 0;
  out.provider = providerOk ? p.provider : null;
  out.teeSigner = p.tee_signer || null;
  out.sigPresent = Boolean(p.tee_signature && p.tee_text && p.tee_signer);
  if (out.sigPresent) {
    const rec = safeRecover(p.tee_text, p.tee_signature);
    out.sigValid = Boolean(rec) && rec.toLowerCase() === String(p.tee_signer).toLowerCase();
  }
  out.valid = p.tee_verified === true && providerOk && idOk && (!out.sigPresent || out.sigValid === true);
  return out;
}

function safeRecover(message, sig) {
  try { return eip191Recover(message, sig); } catch (_) { return null; }
}

// Agentic ID 字串格式 "<ERC-7857 合約>:<tokenId>"
function agenticIdContract(agentId) {
  const m = /^(0x[0-9a-fA-F]{40}):(\d+)$/.exec(String(agentId || ''));
  return m ? m[1] : null;
}
function agenticIdToken(agentId) {
  const m = /^(0x[0-9a-fA-F]{40}):(\d+)$/.exec(String(agentId || ''));
  return m ? m[2] : null;
}

// ERC-721 ownerOf(uint256) via eth_call（Galileo）；失敗回 null，不阻擋驗證。
async function ownerOf(env, contract, tokenId) {
  if (!contract || tokenId === null || tokenId === undefined) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  try {
    const data = '0x' + keccakSelector('ownerOf(uint256)') + BigInt(tokenId).toString(16).padStart(64, '0');
    const r = await fetch(env.OG_TESTNET_RPC || OG_TESTNET_RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: contract, data }, 'latest'] }),
    });
    const j = await r.json();
    const hex = (j && j.result || '').replace(/^0x/, '');
    if (hex.length !== 64) return null;
    return '0x' + hex.slice(24);
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function lookupById(env, id) {
  if (!env.AGENT_KV) return null;
  try {
    const raw = await env.AGENT_KV.get(`seal:${id}`);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function jsonOut(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
