// Vercel Routing Middleware（Edge）— Basic認証でアクセスを制限する
//
// ユーザー名とパスワードはコードに書かず、Vercelの環境変数 AUTH_USERS に設定する。
//   AUTH_USERS = ユーザー名:パスワード,ユーザー名2:パスワード2
//   （区切りは「,」。パスワードに「,」は使えない。パスワードに「:」は使える）
// AUTH_USERS が未設定のときは、誰もアクセスできない（設定忘れで公開されないための安全側の動作）。

export const config = { matcher: ['/((?!_vercel/).*)'] };

// HTTPヘッダーには日本語を入れられないため、英数字にする
const REALM = 'AI BUDDY';
const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };

function parseUsers(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(':');
      return i > 0 ? { user: s.slice(0, i), pass: s.slice(i + 1) } : null;
    })
    .filter((u) => u && u.pass.length > 0);
}

// 長さや一致位置で処理時間が変わらない比較
function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  const n = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function decodeBasic(header) {
  try {
    const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header || '');
    if (!m) return null;
    const bin = atob(m[1]);
    const text = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const i = text.indexOf(':');
    return i < 0 ? null : { user: text.slice(0, i), pass: text.slice(i + 1) };
  } catch (e) {
    return null;
  }
}

function unauthorized() {
  return new Response('認証が必要です', {
    status: 401,
    headers: {
      ...BASE_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
    },
  });
}

export default function middleware(request) {
  const users = parseUsers(process.env.AUTH_USERS);
  if (!users.length) {
    return new Response('認証が設定されていません（環境変数 AUTH_USERS を設定してください）', {
      status: 503,
      headers: { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  const cred = decodeBasic(request.headers.get('authorization'));
  if (!cred) return unauthorized();
  // 全ユーザーと比較して、一致したかどうかを最後にまとめて判定する
  let ok = false;
  for (const u of users) {
    const a = safeEqual(cred.user, u.user);
    const b = safeEqual(cred.pass, u.pass);
    if (a && b) ok = true;
  }
  if (!ok) return unauthorized();
  // 認証OK：通常どおりページを返す（Vercel の next() と同じ指定）
  return new Response(null, { headers: { 'x-middleware-next': '1' } });
}
