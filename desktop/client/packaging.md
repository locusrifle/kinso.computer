# Renter desktop testers

This is a window into a rented computer, **not** the Linux kiosk or server.
One install and lockfile at the repository root; `desktop/client/package.json`
is standalone app metadata, not another installation. Electron 44.5.1 and
`electron-builder` 26.15.3 are pinned at the root.

## Build

From the repository root, with Node 22.19+:

```sh
# Stop if node_modules is a symlink: never install into another checkout.
test ! -L node_modules || { echo 'Use independent root node_modules'; exit 1; }
npm ci
# Electron 44 supplies an explicit installer, not an npm postinstall hook.
node node_modules/electron/install.js
npm run desktop:client

# Output MUST be outside the repository. Default: ../artifacts/desktop-client.
export IMPERFECT_DESKTOP_OUTPUT="$HOME/Downloads/imperfect-desktop-testers"
npm run desktop:linux                 # x64 AppImage + deb, on Linux
npm run desktop:win                   # x64 NSIS; Linux cross-build needs Wine
npm run desktop:mac                   # x64 + arm64 zip/dmg, ONLY on a Mac
npm test -- --test-concurrency=4
# CI shell + remote-view isolation, Linux with sway/dbus-run-session:
node desktop/client/smoke.mjs /tmp/imperfect-desktop-smoke.json
# Test a packaged/extracted Linux binary through the same isolated compositor:
IMPERFECT_DESKTOP_SMOKE_BINARY=/absolute/path/to/imperfect-client node desktop/client/smoke.mjs /tmp/imperfect-packaged-smoke.json
```

Long installs/builds should run in separate user systemd units on Linux, with
explicit cwd, PATH/HOME/output, log and exit-code files; see the task's
`package-worker/report.md` for the actual commands used. Never run these against
the live checkout, install on somebody's device, or publish without approval.

`build/stage.mjs` copies an explicit client-file allowlist into external
`.stage-*` directories and bundles **only** the installed root `ws` dependency.
It rejects source/dependency symlinks, a shared root `node_modules` symlink,
version mismatches, and an output directory inside the repository. LICENSE and
the goat icon are included. No server, kiosk, credentials, user profile, `.env`,
account grants or fixtures enter the package. Add any new client imports/assets
to the allowlist. Client version is taken from the root package at build time.

Identity: `computer.imperfect.client`, executable `imperfect-client`, separate
runtime userData `imperfect-desktop`, persistent partition `persist:renter`
only with a real OS key store. `imperfect://` is registered for future links;
**v1 sign-in uses a loopback PKCE callback, not deep links**. Registration is not
an implemented account/deep-link grant. Real sign-in depends on the undeployed
broker/door bridge specified in `accounts.md`.

The icon reuses the existing painted goat in
`apps/code/native/public/goat/goat.webp`, padded on black and resized to 512px.
No replacement brand artwork was generated. Linux, Windows app and installer
icons are branded. `win.signExecutable: false` preserves PE icon/version
resources while disabling signing. Linux NSIS generation still needs Wine to
extract the generated uninstaller; use an isolated external WINEPREFIX.

## Testers are unsigned

- **Linux:** mark AppImage executable and open it. FUSE may be required;
  `--appimage-extract` permits checking the extracted app without FUSE. Inspect
  the deb before installing; installation requires the tester's permission.
- **Windows:** expect SmartScreen/unknown publisher warnings. Only proceed with
  a separately verified checksum from a trusted source. NSIS is per-user;
  installer generation on Linux is **not** a Windows runtime test.
- **macOS:** unsigned/unnotarized builds may be blocked by Gatekeeper. A tester
  can use the explicit Open Anyway workflow in Privacy & Security after
  verifying provenance. Do not recommend globally disabling Gatekeeper.

On each real target OS verify launch/quit/relaunch, system-browser sign-in,
remembered-session behavior, origin/navigation isolation, screen recording,
file access, shell execution, Stop/revocation, disconnect, suspend/resume,
update/uninstall and that the kiosk's profile remains untouched. Permissions
start off and are not persisted. Commands execute as the local user, not in a
sandbox; OS screen permissions may still be required. Linux CI smoke checks
with `--no-sandbox` are not proof that the normal installed sandbox works.

## Sign later, with explicit approval

No signing credentials/accounts are accessed by these builds. There is no
publishing or auto-update configuration. Release signing needs a deliberate
release configuration, rather than changing tester defaults silently.

**Apple:** Apple Developer Program membership is **US$99/year**, or Apple's
local-currency price/tax; verified against [Apple enrollment](https://developer.apple.com/programs/enroll/)
on 11 Oct 2026. Membership covers Developer ID distribution; no separate
per-notarization fee is advertised. A **Mac is required** here for dmg creation,
signing, notarization and real runtime/permission checks (test both Intel and
Apple Silicon). Enroll as the intended publisher, obtain a Developer ID
Application certificate in its keychain, use a release config that removes
`mac.identity: null`, enables hardened runtime, adds reviewed Electron JIT/
unsigned-executable-memory entitlements, and enables notarization with an
approved App Store Connect API key or keychain profile. Build, submit with
`xcrun notarytool`, staple the app/dmg with `xcrun stapler`, and verify with
`codesign --verify --deep --strict`, `spctl --assess`, and a clean Mac download.
Do not treat a zip produced on Linux as a signed/notarized Mac app.

**Windows:** there is no universal mandatory developer subscription for direct
NSIS downloads, and unsigned distribution is free but warning-prone. Current
[Microsoft Artifact Signing pricing](https://azure.microsoft.com/en-us/pricing/details/artifact-signing/)
(checked 11 Oct 2026) lists Basic at **US$9.99/month** (5,000 signatures), Premium
at **US$99.99/month**, with overages/local currency/tax subject to the current
quote. [Public Trust eligibility](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
is country/entity dependent: Australian organizations are listed, but
individual developers are currently limited to the US/Canada. Do **not** assume
Noah qualifies for the cheap plan. Traditional OV/EV code-signing certificates
are an alternative: budget roughly **US$200–700+ per year** as an indicative,
not verified-vendor quote, plus possible hardware token/cloud key fees; request
an actual eligible-provider quote before purchasing. Signing does not guarantee
instant SmartScreen reputation. On a Windows release builder remove
`win.signExecutable: false`, configure an approved timestamped Authenticode
certificate/provider (or builder's Artifact Signing adapter), and sign the app,
uninstaller and installer. Check `Get-AuthenticodeSignature`, install/run on a
clean Windows machine, then publish checksums. Keep all credential material
outside the repository and documentation.
