(() => {
  'use strict';

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const ITERATIONS = 250000;
  const $ = id => document.getElementById(id);

  function bytesToBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    return Uint8Array.from(atob(value), char => char.charCodeAt(0));
  }

  async function deriveKey(password, salt) {
    const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  function download(name, content) {
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function setStorageStatus(status) {
    const label = $('storageStatus');
    if (!label) return;
    label.textContent = !status.available ? '不可用' : status.persistent ? '已获保留' : '可用（可能被清理）';
  }

  window.HITITAppReady.then(app => {
    const refreshStorageStatus = async () => {
      const status = await window.HITITStorage.persistenceStatus();
      setStorageStatus(status);
      const button = $('localEncryption');
      if (button) button.textContent = app.storage.isLocallyEncrypted() ? '关闭本机加密' : '启用本机加密';
      if (app.storage.isLocallyEncrypted()) $('storageStatus').textContent = '本机已加密';
    };
    refreshStorageStatus();

    $('localEncryption')?.addEventListener('click', () => {
      if (app.storage.isLocallyEncrypted()) {
        if (!confirm('关闭后本机账本将以未加密形式保存在浏览器存储中，是否继续？')) return;
        app.storage.disableLocalEncryption(app.getState()).then(() => {
          app.save();
          refreshStorageStatus();
          app.toast('已关闭本机加密');
        }).catch(() => app.toast('关闭本机加密失败，本地数据未更改'));
        return;
      }
      if (!crypto?.subtle) return app.toast('当前页面不支持加密，请通过 HTTPS 地址打开');
      app.dialog(
        '<h3>启用本机加密</h3><p>此口令用于加密本机数据库。每次重新打开 HITIT 都需要输入；忘记口令只能从加密备份恢复。</p><input id="localPassword" type="password" minlength="10" autocomplete="new-password" placeholder="设置至少 10 位口令"><input id="localPasswordAgain" type="password" minlength="10" autocomplete="new-password" placeholder="再次输入口令"><div class="actions"><button data-cancel>取消</button><button class="primary" data-ok>启用</button></div>',
        async () => {
          const password = $('localPassword').value;
          if (password.length < 10) return app.toast('本机加密口令至少需要 10 位');
          if (password !== $('localPasswordAgain').value) return app.toast('两次输入的口令不一致');
          try {
            await app.storage.enableLocalEncryption(app.getState(), password);
            document.getElementById('dialog').classList.remove('open');
            await refreshStorageStatus();
            app.toast('本机账本已加密；下次打开时需要此口令');
          } catch (error) {
            app.toast(error.message || '本机加密失败，本地数据未更改');
          }
        }
      );
    });

    $('requestPersistent')?.addEventListener('click', async () => {
      const granted = await window.HITITStorage.requestPersistentStorage();
      await refreshStorageStatus();
      app.toast(granted ? '浏览器已批准保留本地数据' : '浏览器未批准；请继续使用加密备份或云同步');
    });

    $('backupExport')?.addEventListener('click', () => {
      if (!crypto?.subtle) return app.toast('当前页面不支持加密，请通过 HTTPS 地址打开');
      app.dialog(
        '<h3>导出加密备份</h3><p>备份包含记录、预算、项目、汇率和固定收支。密码不会保存，请妥善记住。</p><input id="backupPassword" type="password" minlength="10" autocomplete="new-password" placeholder="设置至少 10 位密码"><input id="backupPasswordAgain" type="password" minlength="10" autocomplete="new-password" placeholder="再次输入密码"><div class="actions"><button data-cancel>取消</button><button class="primary" data-ok>导出</button></div>',
        async () => {
          const password = $('backupPassword').value;
          if (password.length < 10) return app.toast('备份密码至少需要 10 位');
          if (password !== $('backupPasswordAgain').value) return app.toast('两次输入的密码不一致');
          try {
            const salt = crypto.getRandomValues(new Uint8Array(16));
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const key = await deriveKey(password, salt);
            const payload = { app: 'HITIT', version: 1, exportedAt: new Date().toISOString(), data: app.getState() };
            const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('HITIT-BACKUP-v1') }, key, encoder.encode(JSON.stringify(payload)));
            const file = {
              format: 'HITIT-ENCRYPTED-BACKUP',
              version: 1,
              kdf: 'PBKDF2-SHA-256',
              iterations: ITERATIONS,
              cipher: 'AES-256-GCM',
              salt: bytesToBase64(salt),
              iv: bytesToBase64(iv),
              ciphertext: bytesToBase64(new Uint8Array(encrypted))
            };
            document.getElementById('dialog').classList.remove('open');
            download('HITIT-backup-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(file, null, 2));
            app.toast('加密备份已导出');
          } catch {
            app.toast('备份加密失败，请重试');
          }
        }
      );
    });

    $('backupImport')?.addEventListener('click', () => $('backupFile').click());
    $('backupFile')?.addEventListener('change', async event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        const envelope = JSON.parse(await file.text());
        if (envelope.format !== 'HITIT-ENCRYPTED-BACKUP' || envelope.version !== 1 || envelope.kdf !== 'PBKDF2-SHA-256' || envelope.cipher !== 'AES-256-GCM') throw new Error('文件格式无效');
        if (!crypto?.subtle) throw new Error('当前页面不支持解密，请通过 HTTPS 地址打开');
        app.dialog(
          '<h3>导入加密备份</h3><p>导入会替换此设备当前的账本数据。</p><input id="restorePassword" type="password" autocomplete="current-password" placeholder="输入导出时设置的密码"><div class="actions"><button data-cancel>取消</button><button class="primary" data-ok>解密并导入</button></div>',
          async () => {
            try {
              const key = await deriveKey($('restorePassword').value, base64ToBytes(envelope.salt));
              const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(envelope.iv), additionalData: encoder.encode('HITIT-BACKUP-v1') }, key, base64ToBytes(envelope.ciphertext));
              const payload = JSON.parse(decoder.decode(decrypted));
              const data = payload?.data;
              if (payload.app !== 'HITIT' || payload.version !== 1 || !data || typeof data !== 'object' || !Array.isArray(data.entries) || !Array.isArray(data.transfers) || !Array.isArray(data.income) || !Array.isArray(data.expense) || !Array.isArray(data.currencies)) throw new Error('备份内容不完整');
              if (!confirm('将用备份替换本设备账本。此操作无法自动合并，是否继续？')) return;
              document.getElementById('dialog').classList.remove('open');
              await app.replaceState(data);
            } catch (error) {
              app.toast(error instanceof DOMException && error.name === 'OperationError' ? '密码错误或备份文件损坏' : error.message || '解密失败');
            }
          }
        );
      } catch (error) {
        app.toast(error.message || '无法读取备份文件');
      }
    });

    window.addEventListener('hitit-storage-error', () => app.toast('本地存储写入失败，请立即导出备份'));
  }).catch(() => {});
})();

