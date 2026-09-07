// Cloudflare Pages Function — POST /agent/decide
//
// 0G 指揮官 Agent 的單回合決策端點。
//   收：{ civilization, board_state, turn }
//   → 以模型 0GM-1.0-35B-A3B 呼叫 0G Compute Router（真的發出 API 請求）
//   → parseJsonLoose 解出行動物件
//   → extract_proof() 取得 TEE 證明，並封成一枚 X-Agent-Proof 印章
//   回：{ action, intent_text, proof, proof_id }
//
// 哲學（沿用 backend/src/llm.mjs）：key 未設、逾時、非 2xx、解析失敗，
// 一律回 HTTP 200 + { fallback: true }，讓遊戲端退回既有的確定性 simple AI。
// 這支端點絕對不回 500 —— 戰鬥永遠能打完。
//
// 印章的封法（verify.js 以同一套規則離線驗證）：
//   payload  = 決策的正規化欄位（見 buildSealPayload）
//   proof_id = sha256(payload) 前 16 碼
//   sig      = HMAC-SHA256(OG_SEAL_SECRET, payload)
//   router_proof = Router 回應中的 TEE 證明原文（由 extract_proof 取得）

// ── 一行替換點 ①：Router 位址與驗證方式 ─────────────────────────────
// Workshop 確認後只改這兩處。若需要 per-request 錢包簽名，只補在 sign_request()。
const OG_ROUTER_URL_DEFAULT = 'https://api.0g.ai/v1/chat/completions';
const OG_MODEL = '0GM-1.0-35B-A3B';

// 一行替換點 ②：TEE 證明放在哪個 response header。
const OG_PROOF_HEADER = 'X-Agent-Proof';

const DEFAULT_TIMEOUT_MS = 9000;
// OG_SEAL_SECRET 未設時的本機開發用金鑰；verify.js 使用同一個常數，
// 印章的 details.dev_secret 會標明 true，評審一眼可辨。
const DEV_SEAL_SECRET = 'consss-0g-dev-seal';

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonOut({ fallback: true, reason: 'bad json' });
  }
  const civilization = String((body && body.civilization) || 'unknown');
  const turn = Number((body && body.turn) || 0);
  const board = (body && body.board_state && typeof body.board_state === 'object') ? body.board_state : {};
  const validActions = Array.isArray(board.valid_actions) ? board.valid_actions.map(String) : [];

  if (!routerConfigured(env)) {
    return jsonOut({ fallback: true, reason: 'router not configured' });
  }

  try {
    const messages = buildMessages(civilization, board, turn, validActions);
    const { text, response, chatId } = await callRouter(env, messages);
    const parsed = parseJsonLoose(text);
    if (!parsed || typeof parsed !== 'object') {
      return jsonOut({ fallback: true, reason: 'unparseable reply' });
    }
    const actionName = String(parsed.action || '').trim();
    if (validActions.length > 0 && !validActions.includes(actionName)) {
      return jsonOut({ fallback: true, reason: `action not in pool: ${actionName}` });
    }
    const intentText = String(parsed.intent_text || parsed.reason || '').trim().slice(0, 140);
    const action = {
      name: actionName,
      target: String(parsed.target || 'player'),
    };

    const routerProof = extract_proof(response);
    const proof = await sealDecision(env, {
      civilization, turn, board, action, intentText, routerProof, chatId,
    });

    // 有綁 AGENT_KV 就順手存一份，讓 verify.html 只貼 proof_id 也查得到；沒綁就略過。
    if (env.AGENT_KV) {
      context.waitUntil(env.AGENT_KV.put(`seal:${proof.proof_id}`, JSON.stringify(proof), { expirationTtl: 7 * 24 * 3600 }));
    }

    return jsonOut({
      action,
      intent_text: intentText,
      proof,
      proof_id: proof.proof_id,
    });
  } catch (e) {
    return jsonOut({ fallback: true, reason: String((e && e.message) || e) });
  }
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return jsonOut({ fallback: true, reason: 'POST only' });
}

// ── 0G Compute Router 呼叫（形式沿用 backend/src/llm.mjs 的 callLLM）──────
function routerConfigured(env) {
  return Boolean(env && env.OG_API_KEY);
}

// 一行替換點 ①（續）：每個請求的驗證標頭都在這裡產生。
// 目前假設標準 Authorization: Bearer。若 Workshop 確認需要錢包簽名，
// 只在此函式內補上（例如以 OG_WALLET_PRIVKEY 對 body 簽名後放進標頭）。
async function sign_request(env, _bodyText) {
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${env.OG_API_KEY}`,
  };
  if (env.OG_AGENT_ID) headers['x-agent-id'] = env.OG_AGENT_ID; // 0G Agentic ID
  return headers;
}

async function callRouter(env, messages) {
  const url = env.OG_ROUTER_URL || OG_ROUTER_URL_DEFAULT;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(env.OG_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  try {
    const bodyText = JSON.stringify({
      model: env.OG_MODEL || OG_MODEL,
      messages,
      temperature: 0.4,
      max_tokens: 200,
    });
    // ↓ 這一行就是真正打到 0G Compute Router 的請求。
    const r = await fetch(url, {
      method: 'POST',
      headers: await sign_request(env, bodyText),
      body: bodyText,
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`router ${r.status}`);
    const j = await r.json();
    const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!txt) throw new Error('router empty');
    return { text: txt, response: r, chatId: String((j && j.id) || '') };
  } finally {
    clearTimeout(timer);
  }
}

// 一行替換點 ②（續）：TEE 證明的取值邏輯「只」存在這個函式。
// 目前假設 Router 以 response header 回傳；若 Workshop 確認是放在 body
// 的某個欄位，改這裡即可（callRouter 已把 response 物件整個傳進來）。
function extract_proof(response) {
  const v = response && response.headers && response.headers.get(OG_PROOF_HEADER);
  return v ? String(v) : null;
}

function buildMessages(civilization, board, turn, validActions) {
  const system = [
    '你是《鏈之迴響》裡持有 0G Agentic ID 的敵方指揮官。',
    '每回合根據戰況，從 valid_actions 中「只能」挑一個行動。',
    '只回傳一個 JSON 物件，不要多餘文字：',
    '{"action":"<valid_actions 之一，原字串>","target":"player","intent_text":"<一句 30 字內的戰術意圖，繁體中文>"}',
  ].join('\n');
  const user = JSON.stringify({
    civilization,
    turn,
    board_state: board,
    valid_actions: validActions,
  });
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ── 印章 ──────────────────────────────────────────────────────────────
// 正規化欄位：鍵名固定排序、值皆為字串／數字，兩端計算出的 bytes 才會一致。
export function buildSealPayload(p) {
  return JSON.stringify({
    v: 1,
    agent_id: p.agent_id,
    model: p.model,
    civilization: p.civilization,
    turn: p.turn,
    board_hash: p.board_hash,
    action: p.action,
    target: p.target,
    intent_text: p.intent_text,
    chat_id: p.chat_id,
    router_proof: p.router_proof,
    ts: p.ts,
  });
}

async function sealDecision(env, { civilization, turn, board, action, intentText, routerProof, chatId }) {
  const fields = {
    agent_id: String(env.OG_AGENT_ID || 'unregistered'),
    model: String(env.OG_MODEL || OG_MODEL),
    civilization,
    turn,
    board_hash: await sha256Hex(canonicalJson(board)),
    action: action.name,
    target: action.target,
    intent_text: intentText,
    chat_id: chatId,
    router_proof: routerProof,
    ts: Date.now(),
  };
  const payload = buildSealPayload(fields);
  const proof_id = (await sha256Hex(payload)).slice(0, 16);
  const secret = env.OG_SEAL_SECRET || DEV_SEAL_SECRET;
  const sig = await hmacHex(secret, payload);
  return { ...fields, proof_id, sig, dev_secret: !env.OG_SEAL_SECRET };
}

// 遞迴排序鍵名，讓同一個盤面永遠得到同一個 hash。
export function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(new Uint8Array(buf));
}

export async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return toHex(new Uint8Array(sig));
}

function toHex(u) { return Array.from(u).map((x) => x.toString(16).padStart(2, '0')).join(''); }

// 與 backend/src/llm.mjs 的 parseJsonLoose 逐字相同（該 repo 為 private，
// Pages Function 無法 import，故原封照抄，不改任何一行）。
export function parseJsonLoose(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

function jsonOut(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
