(function () {
  const SESSION_KEY = 'work-record-supabase-session-v24';

  function getConfig() {
    return window.WORK_RECORD_SUPABASE_CONFIG || { enabled: false, url: '', anonKey: '', schema: 'public' };
  }

  const DEBUG_LOG_KEY = 'work-record-v25-last-supabase-debug';

  function safeJsonParse(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { return text; }
  }

  function maskSecret(value) {
    if (!value || typeof value !== 'string') return value;
    if (value.length <= 16) return '***';
    return value.slice(0, 8) + '...' + value.slice(-6);
  }

  function maskHeaders(raw) {
    const out = {};
    Object.entries(raw || {}).forEach(([k, v]) => {
      const key = String(k).toLowerCase();
      out[k] = (key === 'authorization' || key === 'apikey') ? maskSecret(String(v)) : v;
    });
    return out;
  }

  function rememberDebug(info) {
    window.WR_LAST_SUPABASE_DEBUG = info;
    try { localStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(info, null, 2)); } catch (_) {}
  }

  function getLastDebug() {
    if (window.WR_LAST_SUPABASE_DEBUG) return window.WR_LAST_SUPABASE_DEBUG;
    try { return JSON.parse(localStorage.getItem(DEBUG_LOG_KEY) || 'null'); } catch (_) { return null; }
  }

  function buildDebugInfo(url, options, res, responseData, responseText) {
    let parsedBody = null;
    if (options && options.body) parsedBody = safeJsonParse(options.body);
    const session = getSession();
    return {
      time: new Date().toISOString(),
      method: (options && options.method) || 'GET',
      url,
      table_hint: String(url).match(/\/rest\/v1\/([^?]+)/)?.[1] || '',
      status: res && res.status,
      statusText: res && res.statusText,
      requestHeaders: maskHeaders((options && options.headers) || {}),
      requestBody: parsedBody,
      response: responseData,
      responseText: typeof responseText === 'string' ? responseText : '',
      supabaseUser: session && session.user ? { id: session.user.id, email: session.user.email } : null,
      authTokenSource: session && session.access_token ? '登入者 access_token' : 'anonKey',
      likelyCause: '若錯誤為 RLS，請檢查 table_hint 指向資料表的 policy；若為 PATCH 軟刪除，WITH CHECK 不可限制 deleted_at is null。'
    };
  }

  class SupabaseRequestError extends Error {
    constructor(message, debugInfo) {
      super(message);
      this.name = 'SupabaseRequestError';
      this.debugInfo = debugInfo;
      this.code = debugInfo && debugInfo.response && debugInfo.response.code;
      this.details = debugInfo && debugInfo.response && debugInfo.response.details;
      this.hint = debugInfo && debugInfo.response && debugInfo.response.hint;
    }
  }

  function isReady() {
    const cfg = getConfig();
    return Boolean(cfg.enabled && cfg.url && cfg.anonKey);
  }

  function baseUrl() {
    return getConfig().url.replace(/\/$/, '');
  }

  function getSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
    catch (_) { return null; }
  }

  function normalizeSession(session) {
    if (!session) return null;
    const out = Object.assign({}, session);
    if (!out.expires_at && out.expires_in) {
      out.expires_at = Math.floor(Date.now() / 1000) + Number(out.expires_in || 0);
    }
    return out;
  }

  function setSession(session) {
    const normalized = normalizeSession(session);
    if (normalized) localStorage.setItem(SESSION_KEY, JSON.stringify(normalized));
    else localStorage.removeItem(SESSION_KEY);
  }

  function decodeJwtPayload(token) {
    try {
      const part = String(token || '').split('.')[1];
      if (!part) return null;
      const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(atob(base64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
      return JSON.parse(json);
    } catch (_) { return null; }
  }

  function getAccessTokenExp(session) {
    const s = session || getSession();
    if (!s) return 0;
    if (s.expires_at) return Number(s.expires_at);
    const payload = decodeJwtPayload(s.access_token);
    return payload?.exp ? Number(payload.exp) : 0;
  }

  function sessionNeedsRefresh(session) {
    const s = session || getSession();
    if (!s?.access_token) return false;
    const exp = getAccessTokenExp(s);
    if (!exp) return false;
    // 提前 60 秒刷新，避免操作途中剛好過期。
    return exp <= Math.floor(Date.now() / 1000) + 60;
  }

  function getUser() {
    return getSession()?.user || null;
  }

  function isAuthenticated() {
    return Boolean(getSession()?.access_token && getUser()?.id);
  }

  function authToken() {
    return getSession()?.access_token || getConfig().anonKey;
  }

  function headers(extra) {
    const cfg = getConfig();
    return Object.assign({
      apikey: cfg.anonKey,
      Authorization: `Bearer ${authToken()}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    }, extra || {});
  }

  async function fetchJson(url, options) {
    if (!isReady()) throw new Error('Supabase 尚未啟用，請先設定 js/config/supabaseConfig.js');
    const reqOptions = options || {};
    const res = await fetch(url, reqOptions);
    const text = await res.text();
    const data = safeJsonParse(text);
    if (!res.ok) {
      const message = data && (data.msg || data.message || data.error_description || data.error) ? (data.msg || data.message || data.error_description || data.error) : text || `HTTP ${res.status}`;
      const debugInfo = buildDebugInfo(url, reqOptions, res, data, text);
      rememberDebug(debugInfo);
      throw new SupabaseRequestError(message, debugInfo);
    }
    return data;
  }

  async function authRequest(path, body) {
    const cfg = getConfig();
    return fetchJson(`${baseUrl()}/auth/v1/${path}`, {
      method: 'POST',
      headers: {
        apikey: cfg.anonKey,
        Authorization: `Bearer ${cfg.anonKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body || {})
    });
  }

  async function refreshSession() {
    const session = getSession();
    if (!session?.refresh_token) {
      setSession(null);
      throw new Error('登入已過期，且沒有 refresh_token。請重新登入。');
    }
    const data = await authRequest('token?grant_type=refresh_token', { refresh_token: session.refresh_token });
    setSession(data);
    return data;
  }

  async function ensureFreshSession() {
    if (!isAuthenticated()) return null;
    if (sessionNeedsRefresh()) return refreshSession();
    return getSession();
  }

  function isExpiredJwtError(err) {
    const msg = String(err?.message || '').toLowerCase();
    return err?.code === 'PGRST303' || msg.includes('jwt expired') || msg.includes('invalid jwt') || msg.includes('expired');
  }

  async function signUp(email, password) {
    const data = await authRequest('signup', { email, password });
    if (data.access_token) setSession(data);
    return data;
  }

  async function signIn(email, password) {
    const data = await authRequest('token?grant_type=password', { email, password });
    setSession(data);
    return data;
  }

  function getPasswordResetRedirectUrl() {
    const configured = String(getConfig().passwordResetRedirectUrl || '').trim();
    if (configured) return configured;
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      return window.location.href.split('#')[0].split('?')[0];
    }
    return '';
  }

  async function requestPasswordReset(email) {
    const body = { email };
    const redirectTo = getPasswordResetRedirectUrl();
    if (redirectTo) body.redirect_to = redirectTo;
    return authRequest('recover', body);
  }

  function consumePasswordRecoveryFromUrl() {
    const hashParams = new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''));
    const queryParams = new URLSearchParams(window.location.search || '');
    const type = hashParams.get('type') || queryParams.get('type');
    const accessToken = hashParams.get('access_token') || queryParams.get('access_token');
    const refreshToken = hashParams.get('refresh_token') || queryParams.get('refresh_token') || '';
    const expiresIn = Number(hashParams.get('expires_in') || queryParams.get('expires_in') || 3600);
    if (type !== 'recovery' || !accessToken) return false;

    const payload = decodeJwtPayload(accessToken) || {};
    setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: expiresIn,
      token_type: hashParams.get('token_type') || queryParams.get('token_type') || 'bearer',
      user: { id: payload.sub || '', email: payload.email || '' }
    });
    return true;
  }

  async function updatePassword(newPassword) {
    const session = getSession();
    if (!session?.access_token) throw new Error('密碼重設連結無效或已過期，請重新寄送重設信。');
    const data = await fetchJson(`${baseUrl()}/auth/v1/user`, {
      method: 'PUT',
      headers: {
        apikey: getConfig().anonKey,
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ password: newPassword })
    });
    setSession(Object.assign({}, session, { user: data || session.user }));
    return data;
  }

  async function signOut() {
    const session = getSession();
    if (session?.access_token) {
      try {
        await fetchJson(`${baseUrl()}/auth/v1/logout`, { method: 'POST', headers: headers({ Prefer: '' }) });
      } catch (_) {}
    }
    setSession(null);
  }

  async function request(path, options) {
    if (!isAuthenticated()) throw new Error('請先登入，專案工作記錄版需要登入後才能讀寫資料。');
    await ensureFreshSession();
    const url = `${baseUrl()}/rest/v1/${path}`;
    const buildOptions = () => Object.assign({}, options || {}, { headers: headers(options && options.headers) });
    try {
      return await fetchJson(url, buildOptions());
    } catch (err) {
      // 若頁面放太久造成 access token 過期，刷新一次 session 後重試。
      if (isExpiredJwtError(err) && getSession()?.refresh_token) {
        await refreshSession();
        return fetchJson(url, buildOptions());
      }
      throw err;
    }
  }

  async function select(table, query) {
    return request(`${table}?${query || 'select=*'}`, { method: 'GET', headers: { Prefer: '' } });
  }

  async function upsert(table, rows, conflictTarget) {
    if (!rows || !rows.length) return [];
    const suffix = conflictTarget ? `?on_conflict=${encodeURIComponent(conflictTarget)}` : '';
    return request(`${table}${suffix}`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(rows)
    });
  }

  async function patchWhere(table, column, value, patch) {
    const encoded = encodeURIComponent(String(value));
    return request(`${table}?${column}=eq.${encoded}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch)
    });
  }

  async function softDeleteByColumn(table, column, value) {
    if (!value || !isAuthenticated()) return;
    return patchWhere(table, column, value, { deleted_at: new Date().toISOString(), deleted_by: getUser().id, updated_by: getUser().id });
  }

  async function softDeleteAllOwned(table) {
    if (!isAuthenticated()) return;
    return request(`${table}?owner_id=eq.${encodeURIComponent(getUser().id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ deleted_at: new Date().toISOString(), deleted_by: getUser().id })
    });
  }

  function ownerFields() {
    const user = getUser();
    return { owner_id: user?.id, created_by: user?.id, updated_by: user?.id };
  }

  function toRecordRow(r) {
    return Object.assign(ownerFields(), {
      id: String(r.id),
      record_date: r.record_date || new Date().toISOString().slice(0,10),
      customer: r.customer || '',
      product_name: r.product_name || '',
      spec: r.spec || '',
      work_type: r.work_type || '一般記事',
      stage: r.stage || '',
      status: r.status || '進行中',
      title: r.title || '',
      notes: r.notes || '',
      next_action: r.next_action || '',
      waiting_for: r.waiting_for || '',
      follow_up_date: r.follow_up_date || null,
      milestone_type: r.milestone_type || '',
      milestone_date: r.milestone_date || null,
      priority: r.priority || '普通',
      sample_version: r.sample_version || '',
      photo_path: r.photo_path || '',
      close_reason: r.close_reason || '',
      source_sheet: r.source_sheet || '',
      created_at: r.created_at || new Date().toISOString(),
      deleted_at: null,
      updated_at: new Date().toISOString()
    });
  }

  function sharedAuditFields() {
    const user = getUser();
    return { updated_by: user?.id || null };
  }

  function toCustomerRow(name) {
    return Object.assign(sharedAuditFields(), { name, deleted_at: null, updated_at: new Date().toISOString() });
  }

  function toProductSpecRow(p) {
    return Object.assign(sharedAuditFields(), {
      id: String(p.id),
      customer: p.customer || '',
      product_name: p.product_name || '',
      spec: p.spec || '',
      status: p.status || '進行中',
      deleted_at: null,
      updated_at: new Date().toISOString()
    });
  }

  function toScheduleNodeRow(n) {
    return Object.assign(sharedAuditFields(), {
      id: String(n.id),
      sort_order: Number(n.sort_order || 0),
      node_name: n.node_name || '',
      department: n.department || '',
      work_days: Number(n.work_days || 0),
      deleted_at: null,
      updated_at: new Date().toISOString()
    });
  }

  function toProjectScheduleRows(projectSchedules) {
    return Object.entries(projectSchedules || {}).map(([project_key, config]) => Object.assign(sharedAuditFields(), {
      project_key,
      config,
      deleted_at: null,
      updated_at: new Date().toISOString()
    }));
  }

  async function testConnection() {
    if (!isAuthenticated()) throw new Error('Supabase 已設定，但尚未登入。請先登入。');
    await select('customers', 'select=name&deleted_at=is.null&limit=1');
    return true;
  }

  async function pushAll(state) {
    if (!isAuthenticated()) throw new Error('請先登入後再同步資料。');
    const customers = (state.masters.customers || []).map(toCustomerRow);
    const productSpecs = (state.masters.productSpecs || []).map(toProductSpecRow);
    const scheduleNodes = (state.masters.scheduleNodes || []).map(toScheduleNodeRow);
    const projectSchedules = toProjectScheduleRows(state.projectSchedules || {});
    const records = (state.records || []).map(toRecordRow);
    await upsert('customers', customers, 'name');
    await upsert('product_specs', productSpecs, 'customer,product_name,spec');
    await upsert('schedule_nodes', scheduleNodes, 'id');
    await upsert('project_schedules', projectSchedules, 'project_key');
    await upsert('work_records', records, 'id');
    return true;
  }

  async function pullAll() {
    if (!isAuthenticated()) throw new Error('請先登入後再載入資料。');
    const [customers, productSpecs, scheduleNodes, projectSchedules, workRecords] = await Promise.all([
      select('customers', 'select=*&deleted_at=is.null&order=name.asc'),
      select('product_specs', 'select=*&deleted_at=is.null&order=customer.asc,product_name.asc,spec.asc'),
      select('schedule_nodes', 'select=*&deleted_at=is.null&order=sort_order.asc'),
      select('project_schedules', 'select=*&deleted_at=is.null'),
      select('work_records', 'select=*&deleted_at=is.null&order=record_date.desc,updated_at.desc')
    ]);
    const schedules = {};
    (projectSchedules || []).forEach(row => { schedules[row.project_key] = row.config || {}; });
    return {
      records: workRecords || [],
      masters: {
        customers: (customers || []).map(c => c.name).filter(Boolean),
        productSpecs: (productSpecs || []).map(p => ({ id: p.id, customer: p.customer, product_name: p.product_name, spec: p.spec, status: p.status || '進行中' })),
        scheduleNodes: (scheduleNodes || []).map(n => ({ id: n.id, sort_order: n.sort_order, node_name: n.node_name, department: n.department, work_days: n.work_days }))
      },
      projectSchedules: schedules
    };
  }

  async function listAuditLogs(limit) {
    return select('audit_logs', `select=*&order=created_at.desc&limit=${Number(limit || 50)}`);
  }

  window.WR_SUPABASE_SERVICE = { getConfig, isReady, getSession, getUser, isAuthenticated, getLastDebug, refreshSession, ensureFreshSession, signUp, signIn, requestPasswordReset, consumePasswordRecoveryFromUrl, updatePassword, signOut, testConnection, pushAll, pullAll, softDeleteByColumn, softDeleteAllOwned, listAuditLogs };
})();
