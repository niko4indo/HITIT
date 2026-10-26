# HITIT Android wrapper

This folder packages the existing offline-first web app in a local Android WebView with Capacitor. The web files are bundled into the app; normal use does not depend on a browser tab or a network connection. IndexedDB data remains in the app's private WebView storage while the app is installed. Uninstalling the app removes that local copy, so keep an encrypted backup or use cloud sync.

## Build on Windows

1. Install Node.js 22 or newer and Android Studio. In Android Studio's SDK Manager, install an Android SDK. The current Capacitor 8 Android setup requires Android Studio 2025.2.1 or newer.
2. Open PowerShell in this folder and run:

   ```powershell
   npm install
   npm run copy:web
   npm run android:add
   npm run android:sync
   npm run android:open
   ```

3. In Android Studio, wait for Gradle sync, connect an Android 11+ device with USB debugging enabled, then use **Build → Build Bundle(s) / APK(s) → Build APK(s)**. Android Studio shows the output path when the build finishes.
4. When updating the web app later, copy the latest web files into the parent project and rerun `npm run android:sync` before building.

## Local security

The bundled app uses Android's app-private WebView storage. Optional local encryption protects the IndexedDB ledger with AES-256-GCM and asks for the password each time the app opens. Cloud sync and exported backup files are also encrypted in the web layer; encryption passwords are not saved. Keep the Android lock screen enabled and protect exported backup files.

Google OAuth is enabled for the Chrome website and installed PWA. This Capacitor wrapper intentionally blocks that button until a system-browser callback and Android deep link are configured; use the Chrome PWA for Google sign-in and cloud sync in the meantime.

