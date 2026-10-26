# HITIT v17 设置路线

## 发布到 GitHub Pages

网页版本需要把 `index.html`、`storage.js`、`backup.js`、`cloud-sync.js`、`sw.js`、`manifest.webmanifest`、`icon-192.png` 和 `icon-512.png` 放在仓库根目录同一层。更新后等 Pages 部署完成，再在手机 Chrome 中重新打开页面；如仍看到旧版，关闭已打开的 HITIT 页面后重新载入一次。

## 打开云端加密同步

Supabase 项目已在新加坡区域创建，`hitit_vault` 与 `hitit_vault_history` 加密表及用户隔离策略已部署。网页应用已预填 Project URL 和 Publishable key，无需手动运行 SQL 或复制密钥。

1. 在 Google Auth Platform 创建 **Web application** OAuth 客户端。Authorized JavaScript origin 填 `https://niko4indo.github.io`；Authorized redirect URI 填 `https://ofkvradbvykqlikjjuad.supabase.co/auth/v1/callback`。若应用仍在测试模式，把你自己的 Google 账户添加为 test user。
2. 在 Supabase Dashboard 的 **Authentication → Sign-in providers → Google** 启用 Google 登录，并填入 OAuth Client ID 和 Client Secret。Client Secret 只保存在 Supabase，不能写入网页应用或提交到 GitHub。
3. 在 Supabase **Authentication → URL Configuration** 中，把 Site URL 和 Redirect URLs 都设置为 `https://niko4indo.github.io/HITIT/`；使用自定义域名时改为该域名。
4. 打开 HITIT 设置，点“使用 Google 继续”登录，再设置至少 10 位的加密口令并点“安全同步”。此口令不会发送到 Supabase，请妥善保管。
5. 在新浏览器或手机上登录同一个 Google 账户并使用相同的加密口令。首次发现云端账本时，选择采用云端或本机副本。覆盖云端账本前，旧版本会自动加密存入“历史备份”，可从最近 50 个版本中恢复。

应用仅使用可公开的 Publishable key，**绝不要把 `service_role`、Supabase Secret key 或 Google Client Secret 放进应用**。RLS 限制账户只能读写自己的加密快照和历史版本。

每台设备使用独立本地数据库。两边都发生变更时会要求选择保留哪一份，不会自动合并。加密口令遗失后，云端密文无法还原；请同时保留加密 JSON 备份。

## 本地存储和备份

- 首次启动会将旧版 `ledger-final` 数据迁到 IndexedDB。
- “申请保留存储”由浏览器决定是否批准，不能阻止用户手动清除站点数据。
- “启用本机加密”后，每次重新打开需输入口令；忘记时只能导入仍可解密的备份。
- JSON 备份包含账本设置和全部记录，并以 AES-GCM 加密。
- CSV 导出是未加密的交易明细；不要把个人账目 CSV 放进公开 GitHub 仓库。

## Android

Capacitor 离线应用工程在 `android-app/`。在安装 Node.js 22+ 和 Android Studio 2025.2.1+ 后，按 `android-app/README.md` 生成 Android 项目和 APK。手机本地数据保存在应用私有 WebView 存储中；卸载应用会删除本机副本，需通过云端同步或加密备份恢复。

