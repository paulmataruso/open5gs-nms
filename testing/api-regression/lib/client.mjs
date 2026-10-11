// Minimal, zero-dependency HTTP client for the open5gs-nms REST API.
// Uses Node's built-in fetch (stable since Node 18) — no npm install needed,
// so this works against any open5gs-nms instance with just `node` on PATH.
//
// Auth is a single HttpOnly session cookie (POST /api/auth/login sets
// Set-Cookie; every other authenticated call needs it echoed back as
// Cookie). We don't use a general cookie-jar library — there's exactly one
// cookie that matters here, so we just capture and replay it by hand.

export class ApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.cookie = null;
  }

  async login(username, password) {
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const setCookie = res.headers.get('set-cookie');
    const data = await safeJson(res);
    if (!res.ok || !data?.success) {
      throw new Error(`Login failed (HTTP ${res.status}): ${data?.error ?? res.statusText}`);
    }
    if (!setCookie) {
      throw new Error('Login succeeded but no Set-Cookie header was returned — cannot maintain a session');
    }
    // Only need the cookie's own name=value pair, not the Path/HttpOnly/etc attributes.
    this.cookie = setCookie.split(';')[0];
    return data.data?.user ?? null;
  }

  async request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.cookie) headers['Cookie'] = this.cookie;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await safeJson(res);
    return { status: res.status, ok: res.ok, data };
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body); }
  put(path, body) { return this.request('PUT', path, body); }
  patch(path, body) { return this.request('PATCH', path, body); }
  delete(path, body) { return this.request('DELETE', path, body); }
}

async function safeJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Some endpoints (streaming installs, etc.) don't return JSON at all —
    // callers that hit those should use raw text, not this helper.
    return { __nonJsonBody: text.slice(0, 500) };
  }
}
