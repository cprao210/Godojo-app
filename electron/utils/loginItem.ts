// loginItem.ts
//
// The ONE place that registers / unregisters / reads "Open GoDojo when you
// log in".
//
// WHY: on Windows, Electron stores the login item as a value under
// HKCU\Software\Microsoft\Windows\CurrentVersion\Run whose NAME defaults to the
// app's current AppUserModelId. GoDojo changes that id at startup
// (AppState.applyInitialDisguise → app.setAppUserModelId(
// 'com.godojo.assistant.<mode>'; 'com.natively.assistant.<mode>' before the
// rebrand)), and the first-run "enable" ran BEFORE that
// change while the Settings toggle ran AFTER it. So the toggle wrote/deleted a
// differently-named value than the one actually registered: turning it off
// never removed the real 'electron.app.GoDojo AI' entry (GoDojo kept opening at
// login), and the OS getter "misreported" false. Every call now passes the
// same explicit name, captured below before any disguise can run, and stray
// entries written under the disguise ids are cleaned up.

import path from 'path';
import { app } from 'electron';

/**
 * Registry value name = Electron's own default AUMID for an un-disguised app,
 * `electron.app.<exe product name>` — verified against the registry: the
 * packaged app registers `electron.app.GoDojo AI` ("GoDojo AI.exe"), a dev run
 * `electron.app.Electron` ("electron.exe"; value names are case-insensitive).
 * Derived from the exe, not app.getName(), which the disguise code renames.
 * Matching it means existing installs' entries are the ones we control.
 */
const LOGIN_ITEM_NAME = `electron.app.${(process.platform === 'win32' ? path.win32 : path).parse(app.getPath('exe')).name}`;

/** Names an older build may have registered under (the disguise AUMIDs). */
// Disguise AUMIDs — current (com.godojo.*) and pre-rebrand (com.natively.*).
const LEGACY_LOGIN_ITEM_NAMES = ['godojo', 'natively']
    .flatMap((brand) => ['terminal', 'settings', 'activity', 'none'].map((mode) => `com.${brand}.assistant.${mode}`))
    .filter((n) => n !== LOGIN_ITEM_NAME);

const isWindows = process.platform === 'win32';

/** Register or unregister GoDojo as a login item. Never throws. */
export function applyOpenAtLogin(openAtLogin: boolean): void {
    const exe = app.getPath('exe');
    try {
        app.setLoginItemSettings({
            openAtLogin,
            openAsHidden: false,
            path: exe, // Explicitly point to executable for production reliability
            ...(isWindows ? { name: LOGIN_ITEM_NAME } : {}),
        });
    } catch (e) {
        console.warn('[LoginItem] setLoginItemSettings failed:', e);
    }
    if (!isWindows) return;
    // Remove any entry registered under a disguise id, whichever way the
    // toggle points — the canonical name above is the only one we keep.
    for (const name of LEGACY_LOGIN_ITEM_NAMES) {
        try {
            app.setLoginItemSettings({ openAtLogin: false, path: exe, name });
        } catch { /* absent value — nothing to remove */ }
    }
}

/**
 * Best-effort OS read, for installs with no persisted record only. On Windows
 * Electron 33's getter takes no `name` and looks up the CURRENT (disguise)
 * AUMID, so it can misreport — which is why the persisted setting is the
 * source of truth and reconcileOpenAtLogin() makes the OS match it.
 */
export function readOsOpenAtLogin(): boolean {
    try {
        return app.getLoginItemSettings({ path: app.getPath('exe') }).openAtLogin;
    } catch {
        return false;
    }
}

export const __test = { LOGIN_ITEM_NAME, LEGACY_LOGIN_ITEM_NAMES };
