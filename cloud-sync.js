(() => {
  'use strict';

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const SESSION_KEY = 'hitit-cloud-session';
  const OAUTH_VERIFIER_KEY = 'hitit-google-pkce-verifier';
  const ITERATIONS = 250000;
  const $ = id => document.getElementById(id);
  // Supabase publishable keys are intended for browser clients. RLS keeps vault rows user-scoped.
  const DEFAULT_CLOUD_CONFIG = {
    url: 'https://ofkvradbvykqlikjjuad.supabase.co',
    key: 'sb_publishable_f3wIl9_RcrRnn-IhkcM2Fw_L7XgfKE_'
  };
  let app;
  let config = { ...DEFAULT_CLOUD_CONFIG };
  let autoSyncPassword = '';
  let autoSyncTimer = 0;
  let autoSyncPending = false;
  let autoSyncPaused = false;
  let autoSyncNeedsManual = false;
  let syncInProgress = false;
  const handledNativeCallbacks = new Set();

  function toBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(binary);
  }

  function fromBase64(value) {
    return Uint8Array.from(atob(value), char => char.charCodeAt(0));
  }

  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.keys(value).sort().reduce((result, key) => { result[key] = canonical(value[key]); return result; }, {});
    return value;
  }

  async function stateHash(state) {
    const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(canonical(state))));
    return toBase64(new Uint8Array(bytes));
  }

  async function deriveKey(password, salt) {
    const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function encryptState(state, password, salt) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('HITIT-CLOUD-v1') }, key, encoder.encode(JSON.stringify(state)));
    return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(encrypted)) };
  }

  async function decryptState(row, password) {
    const key = await deriveKey(password, fromBase64(row.salt));
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(row.iv), additionalData: encoder.encode('HITIT-CLOUD-v1') }, key, fromBase64(row.ciphertext));
    const data = JSON.parse(decoder.decode(clear));
    if (!validState(data)) throw new Error('云端账本格式不完整');
    return data;
  }

  function validState(data) {
    return !!data && typeof data === 'object' && Array.isArray(data.entries) && Array.isArray(data.transfers) && Array.isArray(data.income) && Array.isArray(data.expense) && Array.isArray(data.currencies);
  }

  function show(message, error = false) {
    const element = $('cloudStatus');
    if (!element) return;
    const signedIn = Boolean(getSession()?.access_token);
    element.textContent = message;
    element.dataset.state = error ? 'error' : signedIn ? 'success' : 'neutral';
    const badge = $('cloudAccountState');
    if (badge) {
      badge.textContent = signedIn ? '已登录' : error ? '需处理' : '未登录';
      badge.dataset.state = signedIn ? 'active' : error ? 'error' : 'idle';
    }
    const sessionActions = $('cloudSync')?.parentElement;
    if (sessionActions) sessionActions.hidden = !signedIn;
    ['cloudSync', 'cloudHistory', 'cloudLogout'].forEach(id => {
      const button = $(id);
      if (button) button.hidden = !signedIn;
    });
  }

  async function saveConfig() {
    config = { url: $('cloudUrl').value.trim().replace(/\/+$/, ''), key: $('cloudAnonKey').value.trim() };
    await window.HITITStorage.setMeta('cloudConfig', config);
  }

  function parseError(body, fallback) {
    return body?.msg || body?.message || body?.error_description || body?.error || fallback;
  }

  async function request(path, options = {}) {
    await saveConfig();
    if (!/^https:\/\//i.test(config.url) || !config.key) throw new Error('请填写 HTTPS 项目地址和 Publishable / anon key');
    const response = await fetch(config.url + path, {
      ...options,
      headers: { apikey: config.key, 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) throw new Error(parseError(body, '云端请求失败（HTTP ' + response.status + '）'));
    return body;
  }

  function isNativeApp() {
    return window.Capacitor?.isNativePlatform?.() === true;
  }

  function authStorage() {
    return isNativeApp() ? localStorage : sessionStorage;
  }

  function getSession() {
    try { return JSON.parse(authStorage().getItem(SESSION_KEY) || 'null'); } catch { return null; }
  }

  function putSession(session) {
    authStorage().setItem(SESSION_KEY, JSON.stringify(session));
  }

  function authRedirectUrl() {
    if (isNativeApp()) return 'com.hitit.ledger://auth/callback';
    const target = new URL(window.location.href);
    target.search = '';
    target.hash = '';
    return target.href;
  }

  async function authenticatedSession() {
    let session = getSession();
    if (!session?.access_token || !session?.refresh_token) throw new Error('请先登录云端账户');
    if (Number(session.expires_at) > Math.floor(Date.now() / 1000) + 45) return session;
    const refreshed = await request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: session.refresh_token }) });
    session = { access_token: refreshed.access_token, refresh_token: refreshed.refresh_token, expires_at: Math.floor(Date.now() / 1000) + Number(refreshed.expires_in || 3600), user_id: refreshed.user?.id || session.user_id };
    putSession(session);
    return session;
  }

  async function accountAction(path) {
    await saveConfig();
    const email = $('cloudEmail').value.trim();
    const password = $('cloudPassword').value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password) throw new Error('请填写有效邮箱和账户密码');
    const endpoint = path === '/auth/v1/signup'
      ? path + '?redirect_to=' + encodeURIComponent(authRedirectUrl())
      : path;
    const result = await request(endpoint, { method: 'POST', body: JSON.stringify({ email, password }) });
    if (!result.access_token) {
      show('账户请求已提交。请查看收件箱；如该邮箱已有待验证账户，点“重发验证邮件”即可，无需重复创建。');
      return false;
    }
    putSession({ access_token: result.access_token, refresh_token: result.refresh_token, expires_at: Math.floor(Date.now() / 1000) + Number(result.expires_in || 3600), user_id: result.user?.id });
    $('cloudPassword').value = '';
    show('云端账户已登录；输入加密口令后可同步。');
    return true;
  }

  async function resendSignupEmail() {
    await saveConfig();
    const email = $('cloudEmail').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('请先填写有效的注册邮箱');
    const endpoint = '/auth/v1/resend?redirect_to=' + encodeURIComponent(authRedirectUrl());
    await request(endpoint, { method: 'POST', body: JSON.stringify({ email, type: 'signup' }) });
    show('Supabase 已接受重发请求。请检查收件箱和垃圾邮件，并只使用最新邮件中的链接。');
  }

  function base64Url(bytes) {
    return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  async function beginGoogleLogin() {
    await saveConfig();
    if (!crypto?.subtle) throw new Error('当前浏览器不支持安全登录，请更新浏览器后重试');
    const random = crypto.getRandomValues(new Uint8Array(48));
    const verifier = base64Url(random);
    const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
    authStorage().setItem(OAUTH_VERIFIER_KEY, verifier);
    const query = new URLSearchParams({
      provider: 'google',
      redirect_to: authRedirectUrl(),
      scopes: 'openid email profile',
      code_challenge: challenge,
      code_challenge_method: 's256'
    });
    // OAuth authorize responds with an HTTP redirect. Navigate the browser directly
    // instead of fetch(), which follows the cross-origin redirect and fails CORS.
    const authorizeUrl = new URL('/auth/v1/authorize', config.url);
    authorizeUrl.search = query.toString();
    if (isNativeApp()) {
      const browser = window.HITITNative?.Browser;
      if (!browser) throw new Error('APK 登录组件尚未加载，请更新或重新安装应用');
      await browser.open({ url: authorizeUrl.href });
      return;
    }
    window.location.assign(authorizeUrl.href);
  }

  async function completeGoogleRedirect(callbackUrl = window.location.href) {
    const current = new URL(callbackUrl);
    if (isNativeApp() && (current.protocol !== 'com.hitit.ledger:' || current.hostname !== 'auth' || current.pathname !== '/callback')) return false;
    const query = current.searchParams;
    const hash = new URLSearchParams(current.hash.replace(/^#/, ''));
    const code = query.get('code');
    const error = query.get('error_description') || query.get('error') || hash.get('error_description') || hash.get('error');
    const accessToken = query.get('access_token') || hash.get('access_token');
    const refreshToken = query.get('refresh_token') || hash.get('refresh_token');
    if (!code && !error && !(accessToken && refreshToken)) return false;

    if (!isNativeApp() && callbackUrl === window.location.href) {
      current.search = '';
      current.hash = '';
      window.history.replaceState({}, document.title, current.href);
    }
    if (error) {
      authStorage().removeItem(OAUTH_VERIFIER_KEY);
      show('Google 登录未完成：' + error, true);
      return false;
    }

    if (accessToken && refreshToken) {
      const user = await request('/auth/v1/user', { headers: { Authorization: 'Bearer ' + accessToken } });
      if (!user?.id) throw new Error('无法确认登录账户，请重新登录');
      putSession({ access_token: accessToken, refresh_token: refreshToken, expires_at: Number(hash.get('expires_at') || query.get('expires_at') || 0) || Math.floor(Date.now() / 1000) + Number(hash.get('expires_in') || query.get('expires_in') || 3600), user_id: user.id });
      authStorage().removeItem(OAUTH_VERIFIER_KEY);
      show('账户验证完成，已登录云端。输入加密口令并点“安全同步”即可同步账本。');
      return true;
    }

    const verifier = authStorage().getItem(OAUTH_VERIFIER_KEY);
    if (!verifier) throw new Error('登录状态已过期，请重新使用 Google 登录');
    const tokens = await request('/auth/v1/token?grant_type=pkce', {
      method: 'POST',
      body: JSON.stringify({ auth_code: code, code_verifier: verifier })
    });
    if (!tokens?.access_token || !tokens?.refresh_token) throw new Error('Google 登录成功返回了不完整的会话，请重试');
    const user = tokens.user || await request('/auth/v1/user', { headers: { Authorization: 'Bearer ' + tokens.access_token } });
    if (!user?.id) throw new Error('无法确认登录账户，请重新登录');
    putSession({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + Number(tokens.expires_in || 3600),
      user_id: user.id
    });
    $('cloudPassword').value = '';
    authStorage().removeItem(OAUTH_VERIFIER_KEY);
    show('Google 登录成功。输入加密口令并点“安全同步”，即可开启本次打开期间的自动同步。');
    return true;
  }

  async function handleNativeAuthCallback(url) {
    if (!url || handledNativeCallbacks.has(url)) return;
    handledNativeCallbacks.add(url);
    try {
      const completed = await completeGoogleRedirect(url);
      if (completed) await window.HITITNative?.Browser?.close?.();
    } catch (error) {
      show(error.message || '登录回跳处理失败，请重新登录', true);
    }
  }

  async function fetchRemote(session) {
    const query = new URLSearchParams({ select: 'user_id,revision,salt,iv,ciphertext', user_id: 'eq.' + session.user_id, limit: '1' });
    const rows = await request('/rest/v1/hitit_vault?' + query.toString(), { headers: { Authorization: 'Bearer ' + session.access_token } });
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  async function fetchRemoteHistory(session) {
    const query = new URLSearchParams({
      select: 'revision,archived_at,salt,iv,ciphertext',
      user_id: 'eq.' + session.user_id,
      order: 'revision.desc',
      limit: '50'
    });
    const rows = await request('/rest/v1/hitit_vault_history?' + query.toString(), {
      headers: { Authorization: 'Bearer ' + session.access_token }
    });
    return Array.isArray(rows) ? rows : [];
  }

  async function archiveRemoteSnapshot(existing, session) {
    const headers = { Authorization: 'Bearer ' + session.access_token };
    const query = new URLSearchParams({
      select: 'revision,salt,iv,ciphertext',
      user_id: 'eq.' + session.user_id,
      revision: 'eq.' + existing.revision,
      limit: '1'
    });
    const matches = rows => Array.isArray(rows) && rows.length === 1 &&
      Number(rows[0].revision) === Number(existing.revision) &&
      rows[0].salt === existing.salt && rows[0].iv === existing.iv && rows[0].ciphertext === existing.ciphertext;
    const prior = await request('/rest/v1/hitit_vault_history?' + query.toString(), { headers });
    if (matches(prior)) return;
    if (Array.isArray(prior) && prior.length) throw new Error('云端历史版本校验失败，为保护数据已取消覆盖');
    try {
      await request('/rest/v1/hitit_vault_history', {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({
          user_id: session.user_id,
          revision: Number(existing.revision),
          salt: existing.salt,
          iv: existing.iv,
          ciphertext: existing.ciphertext
        })
      });
    } catch (error) {
      const retry = await request('/rest/v1/hitit_vault_history?' + query.toString(), { headers });
      if (!matches(retry)) throw error;
    }
  }

  async function pruneRemoteHistory(session, currentRevision) {
    const keepFrom = Math.max(1, Number(currentRevision) - 50);
    if (keepFrom <= 1) return;
    const query = new URLSearchParams({
      user_id: 'eq.' + session.user_id,
      revision: 'lt.' + keepFrom
    });
    await request('/rest/v1/hitit_vault_history?' + query.toString(), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + session.access_token }
    });
  }

  async function putRemote(state, session, existing, password) {
    const salt = existing ? fromBase64(existing.salt) : crypto.getRandomValues(new Uint8Array(16));
    const encrypted = await encryptState(state, password, salt);
    const row = { user_id: session.user_id, revision: Number(existing?.revision || 0) + 1, salt: toBase64(salt), iv: encrypted.iv, ciphertext: encrypted.ciphertext };
    let result;
    if (existing) {
      await archiveRemoteSnapshot(existing, session);
      const query = new URLSearchParams({ user_id: 'eq.' + session.user_id, revision: 'eq.' + existing.revision });
      result = await request('/rest/v1/hitit_vault?' + query.toString(), { method: 'PATCH', headers: { Authorization: 'Bearer ' + session.access_token, Prefer: 'return=representation' }, body: JSON.stringify(row) });
      if (!Array.isArray(result) || result.length !== 1) throw new Error('云端数据刚刚被另一台设备更新，请重新同步');
      try { await pruneRemoteHistory(session, row.revision); } catch {}
    } else {
      result = await request('/rest/v1/hitit_vault', { method: 'POST', headers: { Authorization: 'Bearer ' + session.access_token, Prefer: 'return=representation' }, body: JSON.stringify(row) });
      if (!Array.isArray(result) || result.length !== 1) throw new Error('云端没有确认保存，请刷新后重试');
    }
    return result[0];
  }

  function chooseConflict(title, detail) {
    return new Promise(resolve => {
      app.dialog('<h3>' + title + '</h3><p>' + detail + '</p><div class="actions"><button data-cancel>暂不处理</button><button id="chooseCloud" type="button">采用云端</button><button id="chooseLocal" class="primary" type="button">采用本机</button><button data-ok hidden type="button">关闭</button></div>', () => {});
      const dialog = $('dialog');
      dialog.querySelector('[data-cancel]').onclick = () => { dialog.classList.remove('open'); resolve(null); };
      $('chooseCloud').onclick = () => { dialog.classList.remove('open'); resolve('cloud'); };
      $('chooseLocal').onclick = () => { dialog.classList.remove('open'); resolve('local'); };
    });
  }

  async function syncNow(passwordOverride = null, { automatic = false } = {}) {
    if (!navigator.onLine) throw new Error('当前处于离线状态');
    if (!crypto?.subtle) throw new Error('当前页面不支持加密，请通过 HTTPS 地址打开');
    const password = passwordOverride ?? $('vaultPassword').value;
    if (password.length < 10) throw new Error('加密口令至少需要 10 位，且不会保存在设备上');
    const session = await authenticatedSession();
    const local = app.getState();
    const localHash = await stateHash(local);
    const baseKey = 'cloudBase:' + session.user_id;
    const base = await window.HITITStorage.getMeta(baseKey);
    const remote = await fetchRemote(session);

    if (!remote) {
      if (base?.revision) {
        if (automatic) {
          show('云端副本状态与本机记录不一致，请点“安全同步”确认后再继续。', true);
          return false;
        }
        if (!confirm('检测到此前同步过的云端副本已不存在。是否用本机数据重新建立云端副本？')) return false;
      }
      const saved = await putRemote(local, session, null, password);
      await window.HITITStorage.setMeta(baseKey, { revision: Number(saved.revision), hash: localHash });
      show('首次同步完成：本机账本已加密上传。');
      return true;
    }

    const remoteState = await decryptState(remote, password);
    const remoteHash = await stateHash(remoteState);
    if (!base) {
      if (automatic) {
        show('检测到已有云端账本，请点“安全同步”并选择采用云端或本机后再开启自动同步。', true);
        return false;
      }
      const choice = await chooseConflict('发现云端账本', '这是该设备首次同步。请选择保留云端账本，或用本机账本覆盖云端。');
      if (choice === 'cloud') {
        await window.HITITStorage.setMeta(baseKey, { revision: Number(remote.revision), hash: remoteHash });
        show('已采用云端账本。');
        await app.replaceState(remoteState);
        return true;
      }
      if (choice === 'local') {
        const saved = await putRemote(local, session, remote, password);
        await window.HITITStorage.setMeta(baseKey, { revision: Number(saved.revision), hash: localHash });
        show('本机账本已加密上传并覆盖旧云端副本。');
        return true;
      }
      return false;
    }

    const localChanged = localHash !== base.hash;
    const remoteChanged = remoteHash !== base.hash;
    const settingsAtRisk = ['income', 'expense', 'fixed'].filter(key =>
      Array.isArray(local[key]) && local[key].length > 0 &&
      (!Array.isArray(remoteState[key]) || remoteState[key].length === 0)
    );
    if (remoteChanged && settingsAtRisk.length) {
      const groups = settingsAtRisk.map(key => key === 'income' ? '收入项目' : key === 'expense' ? '支出项目' : '固定收支').join('、');
      if (automatic) {
        autoSyncNeedsManual = true;
        show('云端缺少本机的' + groups + '，自动同步已暂停以保护本机数据。请点“安全同步”并选择“采用本机”。', true);
        return false;
      }
      const choice = await chooseConflict('云端项目列表不完整', '本机有' + groups + '，云端列表为空。请选择采用本机保留项目，或采用云端覆盖本机。');
      if (choice === 'local') {
        const saved = await putRemote(local, session, remote, password);
        await window.HITITStorage.setMeta(baseKey, { revision: Number(saved.revision), hash: localHash });
        show('已保留本机项目并同步到云端。');
        return true;
      }
      if (choice === 'cloud') {
        await window.HITITStorage.setMeta(baseKey, { revision: Number(remote.revision), hash: remoteHash });
        show('已采用云端账本。');
        await app.replaceState(remoteState);
        return true;
      }
      return false;
    }
    if (localHash === remoteHash) {
      await window.HITITStorage.setMeta(baseKey, { revision: Number(remote.revision), hash: localHash });
      show('本机与云端数据一致，无需更新。');
    } else if (localChanged && remoteChanged) {
      if (automatic) {
        show('本机和云端都有新改动。为避免覆盖，自动同步已暂停；请点“安全同步”选择保留版本。', true);
        return false;
      }
      const choice = await chooseConflict('两台设备都有新改动', '为避免丢失记录，请选择保留哪一份。本次不会自动合并两边的记录。');
      if (choice === 'cloud') {
        await window.HITITStorage.setMeta(baseKey, { revision: Number(remote.revision), hash: remoteHash });
        show('已采用云端账本。');
        await app.replaceState(remoteState);
      } else if (choice === 'local') {
        const saved = await putRemote(local, session, remote, password);
        await window.HITITStorage.setMeta(baseKey, { revision: Number(saved.revision), hash: localHash });
        show('已采用本机账本并更新云端。');
      } else {
        return false;
      }
    } else if (remoteChanged) {
      await window.HITITStorage.setMeta(baseKey, { revision: Number(remote.revision), hash: remoteHash });
      show('已从云端恢复最新账本。');
      await app.replaceState(remoteState);
    } else if (localChanged) {
      const saved = await putRemote(local, session, remote, password);
      await window.HITITStorage.setMeta(baseKey, { revision: Number(saved.revision), hash: localHash });
      show('本机账本已加密同步到云端。');
    } else {
      await window.HITITStorage.setMeta(baseKey, { revision: Number(remote.revision), hash: remoteHash });
      show('同步状态已更新。');
    }
    return true;
  }

  function scheduleAutoSync(delay = 1000) {
    autoSyncPending = true;
    if (!autoSyncPassword || !getSession()?.access_token || autoSyncPaused || autoSyncNeedsManual) return;
    if (!navigator.onLine) {
      show('当前离线：记录已保存在本机，联网后会自动同步。');
      return;
    }
    clearTimeout(autoSyncTimer);
    autoSyncTimer = window.setTimeout(runAutoSync, delay);
  }

  async function runAutoSync() {
    if (!autoSyncPending || !autoSyncPassword || !getSession()?.access_token || autoSyncPaused || autoSyncNeedsManual) return;
    if (!navigator.onLine) {
      show('当前离线：记录已保存在本机，联网后会自动同步。');
      return;
    }
    if (syncInProgress) {
      clearTimeout(autoSyncTimer);
      autoSyncTimer = window.setTimeout(runAutoSync, 500);
      return;
    }

    autoSyncPending = false;
    syncInProgress = true;
    show('正在自动加密同步…');
    try {
      const completed = await syncNow(autoSyncPassword, { automatic: true });
      if (!completed) {
        autoSyncPending = true;
        autoSyncNeedsManual = true;
      }
    } catch (error) {
      autoSyncPending = true;
      autoSyncPaused = true;
      show('自动同步失败；本机记录仍已保存。' + (error.message || '请检查网络') + '。可点“安全同步”重试。', true);
    } finally {
      syncInProgress = false;
      if (autoSyncPending && !autoSyncPaused && !autoSyncNeedsManual && navigator.onLine) scheduleAutoSync(400);
    }
  }

  function showRemoteHistory(versions, session) {
    const items = versions.map(version => {
      const revision = Number(version.revision);
      const when = new Date(version.archived_at);
      const label = Number.isFinite(when.getTime()) ? when.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '时间未知';
      return '<button type="button" class="cloud-history-row" data-revision="' + revision + '"><span><b>版本 ' + revision + '</b><small>' + label + '</small></span><span aria-hidden="true">恢复</span></button>';
    }).join('');
    app.dialog('<h3>云端历史备份</h3><p>每次覆盖云端账本前，旧版本会先加密归档。最多保留最近 50 个历史版本。</p><div class="cloud-history-list">' + (items || '<div class="cloud-history-empty">还没有历史版本。下一次同步产生更新后，旧版本会自动归档。</div>') + '</div><div class="actions"><button data-cancel>关闭</button><button data-ok hidden>关闭</button></div>', () => {});
    document.querySelectorAll('.cloud-history-row').forEach(button => {
      button.addEventListener('click', async () => {
        const selected = versions.find(item => Number(item.revision) === Number(button.dataset.revision));
        if (selected) promptRestoreVersion(selected, session);
      });
    });
  }

  function promptRestoreVersion(version, session) {
    app.dialog('<h3>恢复历史版本 ' + Number(version.revision) + '</h3><p>将用此版本替换当前云端账本和本机账本。当前云端版本会先归档；两份数据不会自动合并。</p><input id="historyVaultPassword" type="password" autocomplete="new-password" placeholder="输入加密口令"><div class="actions"><button data-cancel>取消</button><button class="primary" data-ok>恢复</button></div>', async () => {
      const password = $('historyVaultPassword').value;
      if (password.length < 10) return app.toast('请输入正确的加密口令');
      const action = $('box').querySelector('[data-ok]');
      action.disabled = true;
      try {
        const restoredState = await decryptState(version, password);
        const current = await fetchRemote(session);
        if (!current) throw new Error('云端当前账本不存在，无法安全恢复');
        const restoredHash = await stateHash(restoredState);
        const saved = await putRemote(restoredState, session, current, password);
        await window.HITITStorage.setMeta('cloudBase:' + session.user_id, { revision: Number(saved.revision), hash: restoredHash });
        $('dialog').classList.remove('open');
        await app.replaceState(restoredState);
      } catch (error) {
        action.disabled = false;
        app.toast(error.message || '恢复失败；当前账本未更改');
      }
    });
  }

  window.HITITAppReady.then(async readyApp => {
    app = readyApp;
    window.addEventListener('hitit-state-saved', () => scheduleAutoSync());
    window.addEventListener('online', () => {
      if (autoSyncPending && autoSyncPassword && !autoSyncNeedsManual) {
        autoSyncPaused = false;
        scheduleAutoSync(300);
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && autoSyncPending && !autoSyncPaused && !autoSyncNeedsManual) scheduleAutoSync(300);
    });
    const saved = await window.HITITStorage.getMeta('cloudConfig').catch(() => null);
    config = {
      url: saved?.url || DEFAULT_CLOUD_CONFIG.url,
      key: saved?.key || DEFAULT_CLOUD_CONFIG.key
    };
    $('cloudUrl').value = config.url;
    $('cloudAnonKey').value = config.key;
    const authEmail = $('cloudEmail');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authEmail.value.trim())) {
      authEmail.value = '';
      $('cloudPassword').value = '';
    }
    if (getSession()?.access_token) show('云端账户已登录。输入加密口令并点“安全同步”，即可开启本次打开期间的自动同步。');
    if (isNativeApp()) {
      const nativeApp = window.HITITNative?.App;
      if (!nativeApp) {
        show('APK 登录组件尚未加载，请更新或重新安装应用。', true);
      } else {
        await nativeApp.addListener('appUrlOpen', event => handleNativeAuthCallback(event?.url));
        const launch = await nativeApp.getLaunchUrl();
        if (launch?.url) await handleNativeAuthCallback(launch.url);
      }
    } else {
      try { await completeGoogleRedirect(); } catch (error) { show(error.message || 'Google 登录失败，请重试', true); }
    }

    $('cloudUrl').addEventListener('change', () => saveConfig().catch(() => {}));
    $('cloudAnonKey').addEventListener('change', () => saveConfig().catch(() => {}));
    $('cloudGoogleLogin').addEventListener('click', async () => {
      const button = $('cloudGoogleLogin');
      button.disabled = true;
      try { await beginGoogleLogin(); } catch (error) { show(error.message || 'Google 登录暂时不可用', true); button.disabled = false; }
    });
    $('cloudSignup').addEventListener('click', async () => {
      try { await accountAction('/auth/v1/signup'); } catch (error) { show(error.message, true); }
    });
    $('cloudResend').addEventListener('click', async () => {
      $('cloudResend').disabled = true;
      try { await resendSignupEmail(); } catch (error) { show(error.message, true); }
      finally { $('cloudResend').disabled = false; }
    });
    $('cloudLogin').addEventListener('click', async () => {
      try { await accountAction('/auth/v1/token?grant_type=password'); } catch (error) { show(error.message, true); }
    });
    $('cloudSync').addEventListener('click', async () => {
      const button = $('cloudSync');
      if (syncInProgress) return show('已有同步正在进行，请稍候。');
      const password = $('vaultPassword').value;
      button.disabled = true;
      clearTimeout(autoSyncTimer);
      autoSyncPending = false;
      syncInProgress = true;
      show('正在加密并检查同步状态…');
      let completed = false;
      try {
        completed = await syncNow(password);
        if (completed) {
          autoSyncPassword = password;
          autoSyncPaused = false;
          autoSyncNeedsManual = false;
          show('同步完成；本次打开期间已开启自动同步。关闭页面后需重新输入加密口令。');
        } else if (autoSyncPassword) {
          autoSyncNeedsManual = true;
        }
      } catch (error) {
        show(error.message || '同步失败；本机数据未更改', true);
      } finally {
        $('vaultPassword').value = '';
        syncInProgress = false;
        button.disabled = false;
        if (completed && autoSyncPending && !autoSyncNeedsManual) scheduleAutoSync(400);
      }
    });
    $('cloudHistory').addEventListener('click', async () => {
      const button = $('cloudHistory');
      button.disabled = true;
      try {
        const session = await authenticatedSession();
        const versions = await fetchRemoteHistory(session);
        showRemoteHistory(versions, session);
      } catch (error) { show(error.message || '读取历史备份失败', true); }
      finally { button.disabled = false; }
    });
    $('cloudLogout').addEventListener('click', async () => {
      clearTimeout(autoSyncTimer);
      autoSyncPassword = '';
      autoSyncPending = false;
      autoSyncPaused = false;
      autoSyncNeedsManual = false;
      const session = getSession();
      if (session?.access_token) {
        try { await request('/auth/v1/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + session.access_token } }); } catch {}
      }
      authStorage().removeItem(SESSION_KEY);
      $('cloudPassword').value = '';
      $('vaultPassword').value = '';
      show('已退出云端账户。');
    });
  }).catch(() => {});
})();


