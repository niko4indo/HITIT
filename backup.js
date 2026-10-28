(() => {
  'use strict';

  window.HITITAppReady.then(app => {
    const button = document.getElementById('clearLocalData');
    if (!button) return;

    button.addEventListener('click', () => {
      app.dialog(
        '<h3>清理本机账本</h3><p>这会删除本设备上的记录、预算和设置，并恢复默认状态。云端副本和登录配置会保留，可在清理后重新同步。</p><div class="actions"><button data-cancel type="button">取消</button><button class="danger-button" data-ok type="button">继续清理</button></div>',
        async () => {
          const confirmButton = document.querySelector('#box [data-ok]');
          if (confirmButton) confirmButton.disabled = true;
          try {
            await window.HITITStorage.clearLocalData();
            document.getElementById('dialog')?.classList.remove('open');
            app.toast('本机账本已清理；云端副本仍保留');
            window.setTimeout(() => location.reload(), 450);
          } catch (error) {
            if (confirmButton) confirmButton.disabled = false;
            app.toast(error?.message || '清理失败，本机数据未更改');
          }
        }
      );
    });
  }).catch(() => {});
})();
