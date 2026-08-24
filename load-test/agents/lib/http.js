// load-test/agents/lib/http.js
//
// Per-agent HTTP session for the underwriter-agent simulation. Each
// AgentSession owns its own cookie jar (auth_token + csrf_token from the
// real name-login flow), injects the CSRF double-submit header on every
// mutation, and records per-call latency + status for the run report.
//
// Deliberately dependency-free: Node >= 20 global fetch (undici) only.

/** One recorded HTTP call (for latency/error aggregation). */
export class CallRecord {
  constructor({ method, path, label, status, ms, ok, error }) {
    this.method = method;
    this.path = path;
    this.label = label;      // endpoint template, e.g. "PUT /treaties/:id"
    this.status = status;    // HTTP status (0 on transport error)
    this.ms = ms;
    this.ok = ok;
    this.error = error || null;
  }
}

export class AgentSession {
  /**
   * @param {{ baseUrl: string, name: string, metrics?: CallRecord[] }} opts
   */
  constructor({ baseUrl, name, metrics }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.name = name;          // agent display name, e.g. "Amara Boateng"
    this.userId = null;        // filled after login
    this.cookies = new Map();  // cookie name -> value
    this.metrics = metrics || [];
  }

  _cookieHeader() {
    if (!this.cookies.size) return null;
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  _storeSetCookies(res) {
    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    for (const line of setCookies) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      // An expired clear (Max-Age=0) removes the cookie from the jar.
      if (/max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  /**
   * Perform one API call. `label` should be the route template (used for
   * latency bucketing); `path` the concrete URL path (with real ids).
   * Returns { status, headers, json, text, ms }.
   */
  async call(method, path, { label, body, headers = {}, timeoutMs = 60000 } = {}) {
    const url = `${this.baseUrl}${path}`;
    const h = { accept: 'application/json', ...headers };
    const cookie = this._cookieHeader();
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    // CSRF double-submit: mutations under cookie auth must echo the csrf cookie.
    const m = method.toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(m)) {
      const csrf = this.cookies.get('csrf_token');
      if (csrf && !h['x-csrf-token']) h['x-csrf-token'] = csrf;
    }
    const started = performance.now();
    let res, text = '', error = null;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
      try {
        res = await fetch(url, {
          method: m,
          headers: h,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'manual',
          signal: ac.signal,
        });
        text = await res.text();
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      error = e?.message || String(e);
    }
    const ms = performance.now() - started;
    if (res) this._storeSetCookies(res);
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    }
    const status = res ? res.status : 0;
    this.metrics.push(new CallRecord({
      method: m, path, label: label || `${m} ${path}`,
      status, ms, ok: !!res && res.ok, error,
    }));
    return { status, headers: res ? res.headers : new Map(), json, text, ms, error };
  }

  get(path, opts = {}) { return this.call('GET', path, opts); }
  post(path, body, opts = {}) { return this.call('POST', path, { ...opts, body }); }
  put(path, body, opts = {}) { return this.call('PUT', path, { ...opts, body }); }
  del(path, opts = {}) { return this.call('DELETE', path, opts); }

  /**
   * Sign in through the real passwordless name-login flow (ALLOW_NAME_AUTH).
   * First call creates the underwriter account; the session cookie + CSRF
   * cookie land in the jar exactly as they would for a browser.
   */
  async login() {
    const [first, ...rest] = this.name.split(' ');
    const r = await this.post('/api/auth/name-login', { first_name: first, surname: rest.join(' ') }, {
      label: 'POST /auth/name-login',
    });
    if (r.status !== 200 || !r.json?.session?.userId) {
      throw new Error(`name-login failed for ${this.name}: HTTP ${r.status} ${r.text?.slice(0, 300)}`);
    }
    this.userId = r.json.session.userId;
    this.role = r.json.session.roleCode || null;
    return r.json.session;
  }
}
