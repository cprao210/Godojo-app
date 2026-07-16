const { execSync } = require('child_process');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// INTERIM ad-hoc signer (macOS).
//
// This applies an ad-hoc code signature so unsigned local/test builds can launch
// on Apple Silicon (V8's JIT requires the allow-jit / allow-unsigned-executable-
// memory entitlements, which must be attached via a signature).
//
// This is a stopgap. It will be DELETED once Developer ID signing + notarization
// is configured in the electron-builder `mac` block (set `notarize: true`, remove
// `identity: null`, provide CSC_LINK/CSC_KEY_PASSWORD + APPLE_* env). At that point
// electron-builder performs proper deep signing and this afterPack hook is removed.
//
// NOTE: A previous version of this hook also rewrote the Electron helper processes'
// display names to "CoreServices Helper" to hide the app in Activity Monitor. That
// deceptive disguise has been removed — it fails Apple notarization review, trips
// antivirus heuristics, and is inappropriate for a distributed application.
// ─────────────────────────────────────────────────────────────────────────────

exports.default = async function (context) {
    // macOS only.
    if (process.platform !== 'darwin') {
        return;
    }

    const appOutDir = context.appOutDir;
    const appName = context.packager.appInfo.productFilename;
    const appPath = path.join(appOutDir, `${appName}.app`);

    const entitlementsPath = path.join(
        context.packager.info.projectDir,
        'assets',
        'entitlements.mac.plist'
    );

    console.log(`[Ad-Hoc Signing] Signing ${appPath} with entitlements from ${entitlementsPath}...`);

    try {
        // --force: replace any existing signature
        // --deep: sign nested code (helpers, frameworks)
        // --entitlements: attach JIT/memory entitlements (required on Apple Silicon)
        // --sign -: ad-hoc signature (no identity)
        execSync(
            `codesign --force --deep --entitlements "${entitlementsPath}" --sign - "${appPath}"`,
            { stdio: 'inherit' }
        );
        console.log('[Ad-Hoc Signing] Successfully signed the application with entitlements.');
    } catch (error) {
        console.error('[Ad-Hoc Signing] Failed to sign the application:', error);
        throw error;
    }
};
