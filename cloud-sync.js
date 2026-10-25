(() => {
  'use strict';

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const SESSION_KEY = 'hitit-cloud-session';
  const ITERATIONS = 250000;
  const $ = id => document.getElementById(id);
  // Supabase publishable keys are intended for browser clients. RLS keeps vault rows user-scoped.
  const DEFAULT_CLOUD_CONFIG = {
    url: 'https://ofkvradbvykqlikjjuad.supabase.co',
    key: 'sb_publishable_f3wIl9_RcrRnn-IhkcM2Fw_L7XgfKE_'
  };
  let app;
  let config = { ...DEFAULT_CLOUD_CONFIG };

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

  function getSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
  }

  function putSession(session) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  function authRedirectUrl() {
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

  async function fetchRemote(session) {
    const query = new URLSearchParams({ select: 'user_id,revision,salt,iv,ciphertext', user_id: 'eq.' + session.user_id, limit: '1' });
    const rows = await request('/rest/v1/hitit_vault?' + query.toString(), { headers: { Authorization: 'Bearer ' + session.access_token } });
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  async function putRemote(state, session, existing, password) {
    const salt = existing ? fromBase64(existing.salt) : crypto.getRandomValues(new Uint8Array(16));
    const encrypted = await encryptState(state, password, salt);
    const row = { user_id: session.user_id, revision: Number(existing?.revision || 0) + 1, salt: toBase64(salt), iv: encrypted.iv, ciphertext: encrypted.ciphertext };
    let result;
    if (existing) {
      const query = new URLSearchParams({ user_id: 'eq.' + session.user_id, revision: 'eq.' + existing.revision });
      result = await request('/rest/v1/hitit_vault?' + query.toString(), { method: 'PATCH', headers: { Authorization: 'Bearer ' + session.access_token, Prefer: 'return=representation' }, body: JSON.stringify(row) });
      if (!Array.isArray(result) || result.length !== 1) throw new Error('云端数据刚刚被另一台设备更新，请重新同步');
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

  async function syncNow() {
    if (!navigator.onLine) throw new Error('当前处于离线状态');
    if (!crypto?.subtle) throw new Error('当前页面不支持加密，请通过 HTTPS 地址打开');
    const password = $('vaultPassword').value;
    if (password.length < 10) throw new Error('加密口令至少需要 10 位，且不会保存在设备上');
    const session = await authenticatedSession();
    const local = app.getState();
    const localHash = await stateHash(local);
    const baseKey = 'cloudBase:' + session.user_id;
    const base = await window.HITITStorage.getMeta(baseKey);
    const remote = await fetchRemote(session);

    if (!remote) {
      if (base?.revision) {
        if (!confirm('检测到此前同步过的云端副本已不存在。是否用本机数据重新建立云端副本？')) return;
      }
      const saved = await putRemote(local, session, null, password);
      await window.HITITStorage.setMeta(baseKey, { revision: Number(saved.revision), hash: localHash });
      show('首次同步完成：本机账本已加密上传。');
      $('vaultPassword').value = '';
      return;
    }

    const remoteState = await decryptState(remote, password);
    const remoteHash = await stateHash(remoteState);
    if (!base) {
      const choice = await chooseConflict('发现云端账本', '这是该设备首次同步。请选择保留云端账本，或用本机账本覆盖云端。');
      if (choice === 'cloud') {
        await window.HITITStorage.setMeta(baseKey, { revision: Number(remote.revision), hash: remoteHash });
        show('已采用云端账本。');
        await app.replaceState(remoteState);
      } else if (choice === 'local') {
        const saved = await putRemote(local, session, remote, password);
        await window.HITITStorage.setMeta(baseKey, { revision: Number(saved.revision), hash: localHash });
        show('本机账本已加密上传并覆盖旧云端副本。');
        $('vaultPassword').value = '';
      }
      return;
    }

    const localChanged = localHash !== base.hash;
    const remoteChanged = remoteHash !== base.hash;
    if (localHash === remoteHash) {
      await window.HITITStorage.setMeta(baseKey, { revision: Number(remote.revision), hash: localHash });
      show('本机与云端数据一致，无需更新。');
    } else if (localChanged && remoteChanged) {
      const choice = await chooseConflict('两台设备都有新改动', '为避免丢失记录，请选择保留哪一份。本次不会自动合并两边的记录。');
      if (choice === 'cloud') {
        await window.HITITStorage.setMeta(baseKey, { revision: Number(remote.revision), hash: remoteHash });
        show('已采用云端账本。');
        await app.replaceState(remoteState);
      } else if (choice === 'local') {
        const saved = await putRemote(local, session, remote, password);
        await window.HITITStorage.setMeta(baseKey, { revision: Number(saved.revision), hash: localHash });
        show('已采用本机账本并更新云端。');
        $('vaultPassword').value = '';
      }
    } else if (remoteChanged) {
      await window.HITITStorage.setMeta(baseKey, { revision: Number(remote.revision), hash: remoteHash });
      show('已从云端恢复最新账本。');
      await app.replaceState(remoteState);
    } else if (localChanged) {
      const saved = await putRemote(local, session, remote, password);
      await window.HITITStorage.setMeta(baseKey, { revision: Number(saved.revision), hash: localHash });
      show('本机账本已加密同步到云端。');
      $('vaultPassword').value = '';
    } else {
      await window.HITITStorage.setMeta(baseKey, { revision: Number(remote.revision), hash: remoteHash });
      show('同步状态已更新。');
    }
  }

  window.HITITAppReady.then(async readyApp => {
    app = readyApp;
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
    if (getSession()?.access_token) show('云端账户已登录；加密口令仅保留在当前页面内。');

    $('cloudUrl').addEventListener('change', () => saveConfig().catch(() => {}));
    $('cloudAnonKey').addEventListener('change', () => saveConfig().catch(() => {}));
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
      $('cloudSync').disabled = true;
      show('正在加密并检查同步状态…');
      try { await syncNow(); } catch (error) { show(error.message || '同步失败；本机数据未更改', true); }
      finally { $('vaultPassword').value = ''; $('cloudSync').disabled = false; }
    });
    $('cloudLogout').addEventListener('click', async () => {
      const session = getSession();
      if (session?.access_token) {
        try { await request('/auth/v1/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + session.access_token } }); } catch {}
      }
      sessionStorage.removeItem(SESSION_KEY);
      $('cloudPassword').value = '';
      $('vaultPassword').value = '';
      show('已退出云端账户。');
    });
  }).catch(() => {});
})();
