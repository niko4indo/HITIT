(() => {
  'use strict';

  const DB_NAME = 'hitit-local-v17';
  const STORE_NAME = 'kv';
  const LOCAL_FORMAT = 'HITIT-LOCAL-AES-GCM-v1';
  const PBKDF2_ITERATIONS = 250000;
  let dbPromise;
  let writeQueue = Promise.resolve();
  let localKey = null;
  let localSalt = null;
  let localEncryption = false;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function openDb() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('此浏览器不支持 IndexedDB'));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(request.error || new Error('本地数据库无法打开'));
      request.onblocked = () => reject(new Error('本地数据库正在被其他页面占用，请关闭重复页面后重试'));
    }).catch(error => {
      dbPromise = null;
      throw error;
    });
    return dbPromise;
  }

  function get(key) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error || new Error('读取本地数据失败'));
    }));
  }

  function put(key, value) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('保存本地数据失败'));
    }));
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(binary);
  }

  function base64ToBytes(value) {
    return Uint8Array.from(atob(value), char => char.charCodeAt(0));
  }

  async function deriveLocalKey(password, salt, iterations = PBKDF2_ITERATIONS) {
    const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  function requestLocalPassphrase(errorMessage = '') {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#171a2188;display:grid;place-items:center;padding:20px;font:14px system-ui,-apple-system,"Segoe UI",sans-serif';
      const panel = document.createElement('form');
      panel.style.cssText = 'width:min(360px,100%);background:#fff;border-radius:16px;padding:22px;box-shadow:0 16px 48px #0003';
      const title = document.createElement('strong');
      title.textContent = '解锁本机账本';
      title.style.cssText = 'display:block;font-size:17px;margin-bottom:8px;color:#232833';
      const help = document.createElement('p');
      help.textContent = errorMessage || '本机数据已加密，请输入设置时使用的口令。';
      help.style.cssText = 'margin:0 0 14px;color:#737b86;font-size:12px;line-height:1.5';
      const input = document.createElement('input');
      input.type = 'password';
      input.autocomplete = 'current-password';
      input.placeholder = '本机加密口令';
      input.required = true;
      input.style.cssText = 'box-sizing:border-box;width:100%;height:44px;padding:0 12px;border:1px solid #e3e5e9;border-radius:9px;font:14px system-ui;margin-bottom:12px';
      const button = document.createElement('button');
      button.type = 'submit';
      button.textContent = '解锁';
      button.style.cssText = 'width:100%;height:42px;border:0;border-radius:9px;background:#16865d;color:#fff;font:600 14px system-ui';
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.textContent = '忘记口令？从加密备份恢复';
      restore.style.cssText = 'width:100%;margin-top:10px;padding:8px;border:0;background:transparent;color:#5968d6;font:12px system-ui';
      const backupFile = document.createElement('input');
      backupFile.type = 'file';
      backupFile.accept = 'application/json,.json';
      backupFile.hidden = true;
      restore.addEventListener('click', () => backupFile.click());
      backupFile.addEventListener('change', () => {
        const file = backupFile.files?.[0];
        if (!file) return;
        overlay.remove();
        resolve({ recoveryFile: file });
      });
      panel.append(title, help, input, button, restore, backupFile);
      overlay.append(panel);
      panel.addEventListener('submit', event => { event.preventDefault(); const password = input.value; overlay.remove(); resolve(password); });
      document.body.append(overlay);
      input.focus();
    });
  }

  async function unlockEnvelope(envelope) {
    if (!crypto?.subtle) throw new Error('当前环境不支持解锁本机加密账本，请在支持 Web Crypto 的浏览器或已安装应用中打开');
    let error = '';
    while (true) {
      const answer = await requestLocalPassphrase(error);
      if (answer && typeof answer === 'object' && answer.recoveryFile) {
        try { return await recoverFromBackup(answer.recoveryFile); }
        catch (restoreError) { error = restoreError.message || '无法恢复该备份，请确认文件和密码。'; continue; }
      }
      try {
        const salt = base64ToBytes(envelope.salt);
        const iv = base64ToBytes(envelope.iv);
        const key = await deriveLocalKey(answer, salt);
        const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('HITIT-LOCAL-v1') }, key, base64ToBytes(envelope.ciphertext));
        const data = JSON.parse(decoder.decode(clear));
        if (!data || typeof data !== 'object') throw new Error('账本格式损坏');
        localKey = key;
        localSalt = salt;
        localEncryption = true;
        try { localStorage.removeItem('ledger-final'); } catch {}
        return data;
      } catch {
        error = '口令不正确或本机加密数据损坏，请重试。若忘记口令，只能从加密备份恢复。';
      }
    }
  }

  async function recoverFromBackup(file) {
    const envelope = JSON.parse(await file.text());
    if (envelope.format !== 'HITIT-ENCRYPTED-BACKUP' || envelope.version !== 1 || envelope.kdf !== 'PBKDF2-SHA-256' || envelope.cipher !== 'AES-256-GCM') throw new Error('备份格式不受支持');
    const iterations = Number(envelope.iterations);
    if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000) throw new Error('备份加密参数无效');
    const backupPassword = prompt('请输入导出备份时设置的密码');
    if (backupPassword === null) throw new Error('已取消备份恢复');
    const key = await deriveLocalKey(backupPassword, base64ToBytes(envelope.salt), iterations);
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(envelope.iv), additionalData: encoder.encode('HITIT-BACKUP-v1') }, key, base64ToBytes(envelope.ciphertext));
    const payload = JSON.parse(decoder.decode(clear));
    const data = payload?.data;
    if (payload.app !== 'HITIT' || payload.version !== 1 || !data || typeof data !== 'object' || !Array.isArray(data.entries) || !Array.isArray(data.transfers) || !Array.isArray(data.income) || !Array.isArray(data.expense) || !Array.isArray(data.currencies)) throw new Error('备份账本内容不完整');

    const newPassword = prompt('设置新的本机解锁口令（至少 10 位）；留空则恢复为未加密本机数据');
    if (newPassword === null) throw new Error('已取消备份恢复');
    let record = JSON.parse(JSON.stringify(data));
    if (newPassword) {
      if (newPassword.length < 10) throw new Error('新本机口令至少需要 10 位');
      const confirmPassword = prompt('再次输入新的本机解锁口令');
      if (confirmPassword !== newPassword) throw new Error('两次输入的本机口令不一致');
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const localKeyNext = await deriveLocalKey(newPassword, salt);
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('HITIT-LOCAL-v1') }, localKeyNext, encoder.encode(JSON.stringify(data)));
      record = { format: LOCAL_FORMAT, version: 1, salt: bytesToBase64(salt), iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
      await put('ledger', record);
      localKey = localKeyNext;
      localSalt = salt;
      localEncryption = true;
    } else {
      await put('ledger', record);
      localKey = null;
      localSalt = null;
      localEncryption = false;
    }
    try { localStorage.removeItem('ledger-final'); } catch {}
    return data;
  }

  async function loadState() {
    const record = await get('ledger');
    if (record?.format === LOCAL_FORMAT) {
      try { return await unlockEnvelope(record); }
      catch (error) { error.code = 'HITIT_ENCRYPTED_LOCK'; throw error; }
    }
    localEncryption = false;
    return record && typeof record === 'object' ? record : null;
  }

  function getMeta(key) {
    return get('meta:' + key);
  }

  function setMeta(key, value) {
    return put('meta:' + key, value);
  }

  async function enableLocalEncryption(state, password) {
    if (!crypto?.subtle) throw new Error('当前页面不支持本机加密，请用 HTTPS 或已安装应用打开');
    if (password.length < 10) throw new Error('本机加密口令至少需要 10 位');
    await writeQueue.catch(() => {});
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveLocalKey(password, salt);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('HITIT-LOCAL-v1') }, key, encoder.encode(JSON.stringify(state)));
    const envelope = { format: LOCAL_FORMAT, version: 1, salt: bytesToBase64(salt), iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
    writeQueue = put('ledger', envelope);
    await writeQueue;
    localKey = key;
    localSalt = salt;
    localEncryption = true;
    try { localStorage.removeItem('ledger-final'); } catch {}
  }

  async function disableLocalEncryption(state) {
    await writeQueue.catch(() => {});
    writeQueue = put('ledger', JSON.parse(JSON.stringify(state)));
    await writeQueue;
    localEncryption = false;
    localKey = null;
    localSalt = null;
    return true;
  }

  async function persistenceStatus() {
    if (!('indexedDB' in window)) return { available: false, persistent: false };
    let persistent = false;
    try {
      persistent = !!(navigator.storage?.persisted && await navigator.storage.persisted());
    } catch {}
    return { available: true, persistent };
  }

  async function requestPersistentStorage() {
    if (!navigator.storage?.persist) return false;
    try {
      return !!(await navigator.storage.persist());
    } catch {
      return false;
    }
  }

  async function saveState(state) {
    const snapshot = JSON.parse(JSON.stringify(state));
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      let record = snapshot;
      if (localEncryption) {
        if (!localKey || !localSalt) throw new Error('本机账本尚未解锁');
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('HITIT-LOCAL-v1') }, localKey, encoder.encode(JSON.stringify(snapshot)));
        record = { format: LOCAL_FORMAT, version: 1, salt: bytesToBase64(localSalt), iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
      }
      await put('ledger', record);
    });
    return writeQueue;
  }

  window.HITITStorage = { loadState, saveState, getMeta, setMeta, persistenceStatus, requestPersistentStorage, enableLocalEncryption, disableLocalEncryption, isLocallyEncrypted: () => localEncryption };
})();

