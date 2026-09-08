// Cloudflare Pages Function — POST /agent/decide
//
// 0G 指揮官 Agent 的單回合決策端點（多 Agent 協作：偵察官 → 指揮官，每跳出章）。
//   收：{ civilization, board_state, turn }
//   → 偵察官 Agent：以 0GM-1.0-35B-A3B 讀盤面，產出一句戰況簡報 → 封第 1 枚章
//   → 指揮官 Agent：讀盤面 + 偵察簡報，決定行動 → 封第 2 枚章（parent = 偵察章的 proof_id）
//   回：{ action, intent_text, proof, proof_id, scout: { brief, proof_id }, proofs: [偵察章, 指揮章] }
//   偵察官逾時或失敗時，指揮官單獨決策（proofs 只有一枚），遊戲照樣能跑。
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

// ── 一行替換點 ①：Router 位址與驗證方式（已依 docs.0g.ai 填入正式值）──────
// 0G Compute Router：OpenAI 相容，Authorization: Bearer sk-…，不需 per-request 錢包簽名。
// 文件：https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/overview
const OG_ROUTER_URL_DEFAULT = 'https://router-api.0g.ai/v1/chat/completions';
// Router 的模型 id 是小寫（GET /v1/models 回 "0gm-1.0-35b-a3b"，name 為 0GM-1.0-35B-A3B）。
const OG_MODEL = '0gm-1.0-35b-a3b';

// 一行替換點 ②：TEE 證明的來源（已依 docs.0g.ai 填入正式值）
//   請求帶 verify_tee: true → Router 同步驗證 provider 的 TEE 簽名，
//   回應 body 的 x_0g_trace 帶 { request_id, provider, tee_verified }，
//   回應 header ZG-Res-Key 帶 provider 的 response id（chatID），可對 provider 再驗一次。
const OG_PROOF_HEADER = 'ZG-Res-Key';

const DEFAULT_TIMEOUT_MS = 7000;   // 單次 Router 呼叫；兩跳合計仍在遊戲端 14 秒逾時內
const SCOUT_TIMEOUT_MS = 5000;     // 偵察官逾時就跳過，指揮官單獨決策
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
    // ── 第 1 跳：偵察官 Agent（失敗就略過，不影響指揮官）──
    let scout = null;
    try {
      const sr = await callRouter(env, buildScoutMessages(civilization, board, turn, validActions), SCOUT_TIMEOUT_MS);
      const sp = parseJsonLoose(sr.text);
      const brief = sp && typeof sp === 'object' ? String(sp.brief || '').trim().slice(0, 120) : '';
      if (brief) {
        const scoutProof = await sealDecision(env, {
          role: 'scout', parent: null,
          civilization, turn, board,
          action: { name: String(sp.recommend || ''), target: 'player' },
          intentText: brief,
          routerProof: extract_proof(sr.response, sr.json), chatId: sr.chatId,
        });
        scout = { brief, recommend: String(sp.recommend || ''), proof: scoutProof, proof_id: scoutProof.proof_id };
      }
    } catch (_) {
      scout = null;
    }

    // ── 第 2 跳：指揮官 Agent ──
    const messages = buildMessages(civilization, board, turn, validActions, scout ? scout.brief : '');
    const { text, response, json, chatId } = await callRouter(env, messages);
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

    const routerProof = extract_proof(response, json);
    const proof = await sealDecision(env, {
      role: 'commander', parent: scout ? scout.proof_id : null,
      civilization, turn, board, action, intentText, routerProof, chatId,
    });

    const proofs = scout ? [scout.proof, proof] : [proof];
    // 有綁 AGENT_KV 就順手存一份，讓 verify.html 只貼 proof_id 也查得到；沒綁就略過。
    if (env.AGENT_KV) {
      for (const p of proofs) {
        context.waitUntil(env.AGENT_KV.put(`seal:${p.proof_id}`, JSON.stringify(p), { expirationTtl: 7 * 24 * 3600 }));
      }
    }

    return jsonOut({
      action,
      intent_text: intentText,
      proof,
      proof_id: proof.proof_id,
      scout: scout ? { brief: scout.brief, recommend: scout.recommend, proof_id: scout.proof_id } : null,
      proofs,
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
// 0G Router 文件明載「no wallet signature per request」，只需 Bearer sk- key；
// 若日後改成需要簽名，只在此函式內補上。
async function sign_request(env, _bodyText) {
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${env.OG_API_KEY}`,
  };
  // 0G Agentic ID（ERC-7857 token，格式 "<contract>:<tokenId>"）只封進印章，Router 本身不認這個標頭。
  return headers;
}

async function callRouter(env, messages, timeoutMs) {
  const url = env.OG_ROUTER_URL || OG_ROUTER_URL_DEFAULT;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || Number(env.OG_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  try {
    const bodyText = JSON.stringify({
      model: env.OG_MODEL || OG_MODEL,
      messages,
      temperature: 0.4,
      max_tokens: 400,
      // 0GM 預設開 thinking；關掉以免 max_tokens 被思考吃光、content 空白。
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: 'json_object' },
      // 0G Router 擴充欄位：要求同步驗證 provider 的 TEE 簽名。
      verify_tee: true,
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
    return { text: txt, response: r, json: j, chatId: String((j && j.id) || '') };
  } finally {
    clearTimeout(timer);
  }
}

// 一行替換點 ②（續）：TEE 證明的取值邏輯「只」存在這個函式。
// 把 0G Router 的 TEE 證據封成一個固定鍵序的 JSON 字串，原文進印章：
//   res_key      ZG-Res-Key header（provider 的 response id / chatID）
//   request_id   x_0g_trace.request_id（Router 端的請求 id）
//   provider     x_0g_trace.provider（provider 的鏈上地址）
//   tee_verified x_0g_trace.tee_verified（Router 同步驗過 TEE 簽名的結果）
// 若 Router 完全沒回這些欄位（例如換了別的 OpenAI 相容端點），回 null。
function extract_proof(response, json) {
  const resKey = response && response.headers && response.headers.get(OG_PROOF_HEADER);
  const trace = json && json.x_0g_trace;
  if (!resKey && !trace) return null;
  return JSON.stringify({
    res_key: resKey ? String(resKey) : null,
    request_id: trace && trace.request_id ? String(trace.request_id) : null,
    provider: trace && trace.provider ? String(trace.provider) : null,
    tee_verified: trace && typeof trace.tee_verified !== 'undefined' ? trace.tee_verified : null,
  });
}

// 偵察官 Agent：只讀盤面、不下決定，產出一句戰況簡報與建議行動，交給指揮官。
function buildScoutMessages(civilization, board, turn, validActions) {
  const system = [
    '你是《鏈之迴響》敵方陣營的偵察官 Agent，負責替指揮官分析戰況。',
    '根據 board_state 判斷：玩家血量與架式（stance）、我方 Boss 血量與架式、回合壓力。',
    '只回傳一個 JSON 物件，不要多餘文字：',
    '{"brief":"<一句 40 字內的戰況簡報，繁體中文>","recommend":"<valid_actions 之一，原字串>"}',
  ].join('\n');
  const user = JSON.stringify({ civilization, turn, board_state: board, valid_actions: validActions });
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// 指揮官 Agent：讀盤面與偵察簡報，做最終決定。
function buildMessages(civilization, board, turn, validActions, scoutBrief) {
  const system = [
    '你是《鏈之迴響》裡持有 0G Agentic ID 的敵方指揮官。',
    '每回合根據戰況與偵察官的簡報，從 valid_actions 中「只能」挑一個行動；偵察簡報只是參考，可以不採納。',
    '只回傳一個 JSON 物件，不要多餘文字：',
    '{"action":"<valid_actions 之一，原字串>","target":"player","intent_text":"<一句 30 字內的戰術意圖，繁體中文>"}',
  ].join('\n');
  const user = JSON.stringify({
    civilization,
    turn,
    board_state: board,
    valid_actions: validActions,
    scout_brief: scoutBrief || null,
  });
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ── 印章 ──────────────────────────────────────────────────────────────
// 正規化欄位：鍵名固定排序、值皆為字串／數字，兩端計算出的 bytes 才會一致。
export function buildSealPayload(p) {
  const v = Number(p.v) || 1;
  if (v === 1) {
    return JSON.stringify({
      v: 1,
      agent_id: p.agent_id, model: p.model, civilization: p.civilization, turn: p.turn,
      board_hash: p.board_hash, action: p.action, target: p.target, intent_text: p.intent_text,
      chat_id: p.chat_id, router_proof: p.router_proof, ts: p.ts,
    });
  }
  // v2：多 Agent 每跳出章 —— role 標明是哪個 Agent，parent 指向上一跳的 proof_id，串成證明鏈。
  return JSON.stringify({
    v: 2,
    role: p.role,
    parent: p.parent,
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

async function sealDecision(env, { role, parent, civilization, turn, board, action, intentText, routerProof, chatId }) {
  const fields = {
    v: 2,
    role: role || 'commander',
    parent: parent || null,
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
