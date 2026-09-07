// Cloudflare Pages Function — POST /agent/verify
//
// 離線驗證一枚 X-Agent-Proof 印章。
//   收：{ proof }            完整印章物件（decide.js 回的 proof）
//   或：{ proof_id }         只有 id；需綁 AGENT_KV 才查得到完整印章
//   回：{ valid, details }   details 逐項列出每個檢查的結果，永遠 HTTP 200
//
// 驗證規則與 decide.js 的封章規則一對一：
//   1. proof_id  == sha256(payload) 前 16 碼     → 印章內容沒被竄改
//   2. sig       == HMAC-SHA256(secret, payload) → 印章確實是我方端點封出
//   3. router_proof（TEE 證明原文）              → verify_router_proof() 一行替換點
//   4. action 非空、turn 為正整數                → 基本形狀

import { buildSealPayload, sha256Hex, hmacHex } from './decide.js';

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

    const secret = env.OG_SEAL_SECRET || DEV_SEAL_SECRET;
    const expectedSig = await hmacHex(secret, payload);
    details.sig_match = typeof proof.sig === 'string' && timingSafeEqualHex(expectedSig, proof.sig);
    details.dev_secret = !env.OG_SEAL_SECRET;

    details.router_proof_present = Boolean(proof.router_proof);
    details.router_proof_valid = await verify_router_proof(proof.router_proof, payload, env);

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

// ── 一行替換點：TEE 證明的驗證方式 ──────────────────────────────────
// 目前 Router 的證明格式要等 Workshop 才確認；先做「存在且非空字串」檢查。
// 確認後（例如 ECDSA over sha256(payload) 對 0G TEE 公鑰），只改這個函式。
async function verify_router_proof(routerProof, _payload, _env) {
  if (!routerProof) return false;
  return typeof routerProof === 'string' && routerProof.trim().length > 0;
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
