# Releasing Winglet

## This fork's release identity

This fork publishes from [Broedkrummen/winglet](https://github.com/Broedkrummen/winglet).
Its Android package and reserved iOS bundle identifier are `io.github.broedkrummen.winglet`.
Android development builds use `io.github.broedkrummen.winglet.dev`.
The Wear OS companion uses the same production/development package IDs: Google's Data Layer also
requires matching phone/watch signing certificates. See [the watch build guide](../wear/README.md).

The fork installs separately from upstream Winglet (`io.github.vikasrp24.winglet`). It does not
replace, migrate or erase upstream pairings, messages or cache. Pair the fork with your server
on first use; keep the upstream installation until you have checked what you need. Future fork
updates must use the same fork package, a higher version code and the same release signing key.

The app's updater and About help link point to this fork. Until the first signed release is published,
the release page may contain no APKs; use a reviewed Actions build for testing. A development/debug-key
build is not a substitute for the stable release-signing key. The existing CI gates below remain required.
No release key or publication is created by changing these settings. Keep upstream copyright/license
attribution in LICENSE and plugin/THIRD_PARTY_NOTICES.md intact.

Pushing a tag like `v0.1.1` or `v0.2.0-beta.1` builds the Android APKs and the plugin bundle and publishes them as a
GitHub Release. There is one APK per CPU, `winglet-<version>-arm64-v8a.apk` (nearly every phone) and
`winglet-<version>-armeabi-v7a.apk` (older 32-bit phones), about 61 MB and 52 MB against 81 MB for a universal one. Both share
the release's versionCode, and the app's update check downloads the one that fits the phone.

The tag sets the app version: `v0.1.1` becomes version `0.1.1`, Android versionCode
`101` (major × 10000 + minor × 100 + patch), so every release installs as an update over the last.

## One-time setup: your signing key

Android only installs an update if it's signed with the same key as the version already installed,
and the key proves the APK came from you. CI refuses to publish a release without it.

1. Create a key (needs Java; any machine works). Keep the file and passwords somewhere safe and
   **never commit them**. If you lose this key, users have to uninstall to get future updates.

   ```bash
   keytool -genkeypair -v -keystore winglet-release.keystore -alias winglet \
     -keyalg RSA -keysize 4096 -validity 10000
   ```

2. Turn it into text for GitHub:

   ```bash
   base64 -w0 winglet-release.keystore > keystore.txt   # macOS: base64 -i winglet-release.keystore
   ```

3. In the repo on GitHub: **Settings → Secrets and variables → Actions → New repository secret**,
   add four secrets:

   | Name | Value |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | contents of `keystore.txt` |
   | `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
   | `ANDROID_KEY_ALIAS` | `winglet` |
   | `ANDROID_KEY_PASSWORD` | the key password |

## Cutting a release

```bash
git tag v0.1.1
git push origin v0.1.1
```

### Betas

A tag like `v0.2.0-beta.1` (or `-rc.1`) publishes a **pre-release**: the app shows `0.2.0-beta.1`,
and GitHub keeps "Latest release" on the last full release. A beta shares its release's versionCode
(`v0.2.0-beta.1` and `v0.2.0` are both `200`), so the final release installs over the beta as an update.

### Release notes

If `docs/releases/<tag>.md` exists (for example `docs/releases/v0.2.0-beta.1.md`), it becomes the top of
the release page, above GitHub's list of merged pull requests.

Manual runs from the Actions tab build test artifacts only. Without the key secrets those APKs are
signed with the public debug key and named `…-debugkey.apk`: fine for trying things out, not for
sharing.
