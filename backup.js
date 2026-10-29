(() => {
  'use strict';

  window.HITITAppReady.then(async app => {
    const clearButton = document.getElementById('clearLocalData');
    const passwordButton = document.getElementById('cleanupPasswordAction');
    const closeDialog = () => document.getElementById('dialog')?.classList.remove('open');

    async function refreshPasswordLabel() {
      if (!passwordButton) return;
      passwordButton.textContent = await window.HITITStorage.hasCleanupPassword() ? '修改密码' : '设置密码';
    }

    function setCleanupPassword(existing) {
      const currentField = existing ? '<input id="cleanupCurrentPassword" type="password" autocomplete="current-password" placeholder="当前密码">' : '';
      const heading = existing ? '修改清理密码' : '设置清理密码';
      app.dialog(
        '<h3>' + heading + '</h3><p>密码至少 6 位，只保存加密校验信息，不保存密码原文。忘记密码后，需通过系统清除应用数据才能移除本机账本。</p>' + currentField + '<input id="cleanupNewPassword" type="password" minlength="6" autocomplete="new-password" placeholder="新密码（至少 6 位）"><input id="cleanupNewPasswordAgain" type="password" minlength="6" autocomplete="new-password" placeholder="再次输入新密码"><div class="actions"><button data-cancel type="button">取消</button><button class="primary" data-ok type="button">保存密码</button></div>',
        async () => {
          const okButton = document.querySelector('#box [data-ok]');
          if (okButton) okButton.disabled = true;
          try {
            if (existing && !await window.HITITStorage.verifyCleanupPassword(document.getElementById('cleanupCurrentPassword').value)) {
              app.toast('当前清理密码不正确');
              if (okButton) okButton.disabled = false;
              return;
            }
            const password = document.getElementById('cleanupNewPassword').value;
            if (password.length < 6) {
              app.toast('清理密码至少需要 6 位');
              if (okButton) okButton.disabled = false;
              return;
            }
            if (password !== document.getElementById('cleanupNewPasswordAgain').value) {
              app.toast('两次输入的新密码不一致');
              if (okButton) okButton.disabled = false;
              return;
            }
            await window.HITITStorage.setCleanupPassword(password);
            closeDialog();
            await refreshPasswordLabel();
            app.toast(existing ? '清理密码已修改' : '清理密码已设置');
          } catch (error) {
            if (okButton) okButton.disabled = false;
            app.toast(error?.message || '保存清理密码失败');
          }
        }
      );
    }

    async function confirmAndClear() {
      app.dialog(
        '<h3>确认清理本机账本？</h3><p>本机记录、预算和设置将被删除，未同步的变更也会丢失。云端副本和清理密码会保留。</p><div class="actions"><button data-cancel type="button">取消</button><button class="danger-button" data-ok type="button">确认清理</button></div>',
        async () => {
          const okButton = document.querySelector('#box [data-ok]');
          if (okButton) okButton.disabled = true;
          try {
            await window.HITITStorage.clearLocalData();
            closeDialog();
            app.toast('本机账本已清理；云端副本仍保留');
            window.setTimeout(() => location.reload(), 450);
          } catch (error) {
            if (okButton) okButton.disabled = false;
            app.toast(error?.message || '清理失败，本机数据未更改');
          }
        }
      );
    }

    passwordButton?.addEventListener('click', async () => {
      try { setCleanupPassword(await window.HITITStorage.hasCleanupPassword()); }
      catch (error) { app.toast(error?.message || '读取清理密码状态失败'); }
    });

    clearButton?.addEventListener('click', async () => {
      try {
        if (!await window.HITITStorage.hasCleanupPassword()) {
          app.dialog(
            '<h3>请先设置清理密码</h3><p>清理本机数据前必须设置密码。设置完成后，再次点击清理按钮即可继续。</p><div class="actions"><button data-cancel type="button">取消</button><button class="primary" data-ok type="button">设置密码</button></div>',
            () => { closeDialog(); setCleanupPassword(false); }
          );
          return;
        }
        app.dialog(
          '<h3>验证清理密码</h3><p>密码正确后，还会再次询问是否确认清理。</p><input id="cleanupVerifyPassword" type="password" autocomplete="current-password" placeholder="输入清理密码"><div class="actions"><button data-cancel type="button">取消</button><button class="primary" data-ok type="button">验证</button></div>',
          async () => {
            const okButton = document.querySelector('#box [data-ok]');
            if (okButton) okButton.disabled = true;
            const valid = await window.HITITStorage.verifyCleanupPassword(document.getElementById('cleanupVerifyPassword').value);
            if (!valid) {
              app.toast('清理密码不正确');
              if (okButton) okButton.disabled = false;
              return;
            }
            closeDialog();
            confirmAndClear();
          }
        );
      } catch (error) {
        app.toast(error?.message || '无法验证清理密码');
      }
    });

    await refreshPasswordLabel().catch(() => {});
  }).catch(() => {});
})();
