// Vercel Edge Function: /api/data — ポータルのデータをサーバー（Upstash Redis）に保存する
//
// ・アクセス制限は middleware.js（Basic認証）がこの /api/ にも効く。ここでは認証しない。
// ・保存先は Vercel の Storage（Upstash Redis）。接続情報は環境変数（連携すると自動で入る）：
//     KV_REST_API_URL / KV_REST_API_TOKEN （または UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN）
//   未設定のときは 503 を返す（画面側は、これまでどおり「このブラウザだけに保存」になる）。
// ・複数人が同時に使うため、保存には「版番号（rev）」を使う。
//     GET  /api/data[?rev=N]      → { rev, data, meta }（rev=N が最新なら { rev, unchanged:true }）
//     PUT  /api/data {baseRev,data} → baseRev が最新と一致したときだけ保存（不一致は 409 で最新を返す）
// ・保存のたびに、直前の内容を :prev に、その日の最初の保存前の内容を :day:YYYY-MM-DD（60日）に残す。

export const config = { runtime: 'edge' };

const NS = 'aibuddy';
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const MAX_BYTES = 900000;

// 版番号が一致したときだけ書き込む（Redis側で一度に実行するので、同時保存でも取り違えない）
const LUA = `
local ns = KEYS[1]
local cur = tonumber(redis.call('GET', ns .. ':rev') or '0')
if cur ~= tonumber(ARGV[1]) then return {0, cur} end
local old = redis.call('GET', ns .. ':data')
if old then
  redis.call('SET', ns .. ':prev', old)
  redis.call('SET', ns .. ':day:' .. ARGV[3], old, 'NX', 'EX', 5184000)
end
cur = cur + 1
redis.call('SET', ns .. ':data', ARGV[2])
redis.call('SET', ns .. ':rev', cur)
redis.call('SET', ns .. ':meta', ARGV[4])
return {1, cur}
`;

const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: HEADERS });

function storage() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

async function call(st, path, body) {
  const res = await fetch(st.url + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + st.token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('storage ' + res.status);
  return res.json();
}

async function readAll(st) {
  const r = await call(st, '/pipeline', [['GET', NS + ':rev'], ['GET', NS + ':data'], ['GET', NS + ':meta']]);
  const rev = Number(r[0] && r[0].result) || 0;
  const parse = (x) => { try { return x && x.result ? JSON.parse(x.result) : null; } catch (e) { return null; } };
  return { rev, data: parse(r[1]), meta: parse(r[2]) };
}

// 認証済みのユーザー名（誰が保存したかの記録用）
function userName(request) {
  try {
    const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(request.headers.get('authorization') || '');
    if (!m) return '';
    const text = new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)));
    return text.slice(0, Math.max(text.indexOf(':'), 0));
  } catch (e) {
    return '';
  }
}

function valid(d) {
  return !!d && d.v === 1 && Array.isArray(d.staff) && Array.isArray(d.clients) && Array.isArray(d.events);
}

export default async function handler(request) {
  const st = storage();
  if (!st) return reply({ error: 'storage-not-configured' }, 503);
  try {
    if (request.method === 'GET') {
      const all = await readAll(st);
      const q = new URL(request.url).searchParams.get('rev');
      if (q !== null && Number(q) === all.rev) return reply({ rev: all.rev, unchanged: true });
      return reply(all);
    }
    if (request.method === 'PUT') {
      let body;
      try { body = await request.json(); } catch (e) { return reply({ error: 'bad-json' }, 400); }
      if (!body || !Number.isInteger(body.baseRev) || body.baseRev < 0 || !valid(body.data)) return reply({ error: 'bad-request' }, 400);
      const str = JSON.stringify(body.data);
      if (str.length > MAX_BYTES) return reply({ error: 'too-large' }, 413);
      const ymd = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);   // 日本時間の日付
      const meta = JSON.stringify({ by: userName(request), at: new Date().toISOString() });
      const r = await call(st, '', ['EVAL', LUA, '1', NS, String(body.baseRev), str, ymd, meta]);
      const out = r && r.result;
      if (Array.isArray(out) && Number(out[0]) === 1) return reply({ rev: Number(out[1]), meta: JSON.parse(meta) });
      const all = await readAll(st);
      return reply({ conflict: true, ...all }, 409);
    }
    return reply({ error: 'method-not-allowed' }, 405);
  } catch (e) {
    return reply({ error: 'storage-error' }, 502);
  }
}
