import { BrowserWindow, screen, app, Menu } from "electron"
import { AppState } from "./main"
import { KeybindManager } from "./services/KeybindManager"
import { startStaticServer } from "./staticServer"
import { isVerboseLogging } from "./verboseLog"
import path from "node:path"

const isEnvDev = process.env.NODE_ENV === "development"
const isPackaged = app.isPackaged;
const inAppBundle = process.execPath.includes('.app/') || process.execPath.includes('.app\\');

console.log(`[WindowHelper] isEnvDev: ${isEnvDev}, isPackaged: ${isPackaged}, inAppBundle: ${inAppBundle}`);

// Force production mode if running as packaged app or inside app bundle
const isDev = isEnvDev && !isPackaged;

// Must match FloatingDock's collapsed target height (52 — brand bar only).
// Every meeting starts collapsed (see useFloatingDock's onSessionReset
// handler), so switchToOverlay uses this directly on a fresh meeting start
// instead of a taller placeholder — see the freshMeetingStart param below
// for why. (Not useFloatingDock's DEFAULT_DOCK_HEIGHT — that is a
// pre-ResizeObserver fallback for panel positioning, not the dock's real
// rendered height.)
const COLLAPSED_OVERLAY_HEIGHT = 52;

// The dock's fixed content width — FloatingDock's outer container is
// `w-[430px]`, and the overlay window's body is `width: fit-content`, so the
// window content is always exactly this wide. The window must be created and
// snapped at the SAME width: it used to open at a 600px placeholder, and
// since the fit-content body sits at the window's left edge, the first
// content resize then re-anchored the right edge and teleported the visible
// dock ~170px sideways — on every meeting start, and again on the first
// resize after every hide/show (setBounds here re-widened the window each
// time). Matching the content width means widthChanged can never fire on the
// common path, so those re-anchors (and the jump they caused) are gone.
const OVERLAY_DOCK_WIDTH = 430;

// Z-order level the live-call overlay is pinned at, on every platform. The
// named level matters as much as the flag itself:
//   - "screen-saver" sits above fullscreen windows on macOS and above
//     "system demands" (kCGModalPanel / kCGScreenSaverWindowLevel) on Linux —
//     the default 'floating' level loses to both. On Windows the level
//     argument is a no-op; HWND_TOPMOST is absolute, so all platforms share
//     one constant.
//   - Re-asserted with this exact level everywhere we restore the pin
//     (watchdogs below), so a restore can never land on a weaker level than
//     the one chosen at creation time.
const OVERLAY_ALWAYS_ON_TOP_LEVEL: 'floating' | 'screen-saver' = 'screen-saver';

let startUrl = isDev ? "http://localhost:5180" : ""

/** Must be awaited before the first createWindow() call in production. */
export async function initRendererUrl(): Promise<void> {
  if (isDev) return
  const distDir = path.join(__dirname, "../../dist")
  startUrl = await startStaticServer(distDir)
}

export class WindowHelper {
  private launcherWindow: BrowserWindow | null = null
  private overlayWindow: BrowserWindow | null = null
  private isWindowVisible: boolean = false
  // Position/Size tracking for Launcher
  private launcherPosition: { x: number; y: number } | null = null
  private launcherSize: { width: number; height: number } | null = null
  // Track current window mode (persists even when overlay is hidden via Cmd+B)
  private currentWindowMode: 'launcher' | 'overlay' = 'launcher'

  // When true, the next time the overlay is shown it snaps to the bottom-right
  // of the reference display (Google-Meet-PiP style) instead of preserving its
  // previous position. Armed at creation and re-armed on every return to the
  // launcher (i.e. meeting end), so each "Start GoDojo" opens bottom-right,
  // while manual drags mid-meeting (and hide/show toggles) are respected.
  private overlayNeedsReposition: boolean = true
  // Gap (px) between the overlay and the screen work-area edges when snapped.
  private readonly overlayEdgeMargin: number = 24

  private appState: AppState
  private contentProtection: boolean = false
  // Set right before any hide() call WE intentionally trigger on the overlay
  // (hideMainWindow / hideOverlay / switchToLauncher). Lets the 'hide'
  // listener in setupWindowListeners() tell the difference between "we hid
  // it on purpose" and "the OS hid it out from under us" (see there for why
  // that distinction matters).
  private overlayHideIsExpected: boolean = false
  private opacityTimeout: NodeJS.Timeout | null = null
  // Interval handle for the overlay pinned-watchdog (reassertOverlayPinned).
  private overlayPinnedTimer: NodeJS.Timeout | null = null
  // Re-entrancy guard for the watchdog's showInactive() restore: an Electron
  // show can re-enter this method synchronously on some platforms (the show
  // event dispatches inline), which would otherwise recurse on itself.
  private overlayWatchdogRestoring: boolean = false

  // Initialize with explicit number type and 0 value
  private screenWidth: number = 0
  private screenHeight: number = 0

  // Movement variables (apply to active window)
  private step: number = 20
  private currentX: number = 0
  private currentY: number = 0

  constructor(appState: AppState) {
    this.appState = appState
  }

  public getContentProtection(): boolean {
    return this.contentProtection;
  }

  public setContentProtection(enable: boolean): void {
    this.contentProtection = enable
    this.applyContentProtection(enable)
  }

  private applyContentProtection(enable: boolean): void {
    const windows = [this.launcherWindow, this.overlayWindow]
    windows.forEach(win => {
      if (win && !win.isDestroyed()) {
        win.setContentProtection(enable);
      }
    });
  }

  public setWindowDimensions(width: number, height: number): void {
    const activeWindow = this.getMainWindow(); // Gets currently focused/relevant window
    if (!activeWindow || activeWindow.isDestroyed()) return

    const [currentX, currentY] = activeWindow.getPosition()

    const currentDisplay = screen.getDisplayNearestPoint({ x: currentX, y: currentY })
    const workArea = currentDisplay.workArea
    const maxAllowedWidth = Math.floor(workArea.width * 0.9)
    const newWidth = Math.min(width, maxAllowedWidth)
    const newHeight = Math.ceil(height)
    const maxX = workArea.x + workArea.width - newWidth
    const newX = Math.min(Math.max(currentX, workArea.x), maxX)

    activeWindow.setBounds({
      x: newX,
      y: currentY,
      width: newWidth,
      height: newHeight
    })

    // Update internal tracking if it's launcher
    if (activeWindow === this.launcherWindow) {
      this.launcherSize = { width: newWidth, height: newHeight }
      this.launcherPosition = { x: newX, y: currentY }
    }
  }

  // Dedicated method for overlay window resizing - decoupled from launcher
  public setOverlayDimensions(width: number, height: number): void {
    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) return

    // Fires once per discrete dock size change (and once per settled fallback
    // measurement) — gate behind verbose logging so a normal call's console
    // isn't spammed with a line per expand/collapse step.
    if (isVerboseLogging()) console.log('[WindowHelper] setOverlayDimensions:', width, height);

    const currentBounds = this.overlayWindow.getBounds()
    const currentDisplay = screen.getDisplayNearestPoint({ x: currentBounds.x, y: currentBounds.y });
    const workArea = currentDisplay.workArea
    const maxAllowedWidth = Math.floor(workArea.width * 0.9)
    const maxAllowedHeight = Math.floor(workArea.height * 0.9)
    const newWidth = Math.min(Math.max(width, 300), maxAllowedWidth) // min 300, max 90%
    const newHeight = Math.min(Math.max(height, 1), maxAllowedHeight) // min 1, max 90%

    // Sub-pixel jitter guards. getBoundingClientRect returns floats and the
    // renderer rounds them; clamps + display scaling can flip a settled size
    // by a pixel (e.g. 680 → 681 → 680 during a spring's last frames). Both
    // guards dedupe that to a no-op, because each accepted resize here is a
    // real native window resize — and the trailing-edge fallback observer
    // in useGodojoInterface re-measures after every animation, so without a
    // tolerance this method would keep bouncing the real window ±1px after
    // every expand/collapse settled.
    const WIDTH_JITTER_TOLERANCE_PX = 2
    const HEIGHT_JITTER_TOLERANCE_PX = 1
    const widthChanged = Math.abs(newWidth - currentBounds.width) > WIDTH_JITTER_TOLERANCE_PX
    const heightChanged = newHeight > currentBounds.height + HEIGHT_JITTER_TOLERANCE_PX
        || newHeight < currentBounds.height - HEIGHT_JITTER_TOLERANCE_PX
    if (!widthChanged && !heightChanged) return

    // Anchor the TOP edge: keep the window's top edge fixed as its content
    // grows/shrinks, so the dock's brand bar — which is pinned to the window
    // top (position: fixed; top: 6 in FloatingDock) — stays put on screen and
    // the nav dock + panels grow DOWNWARD beneath it. This matches the dock's
    // actual top-down DOM layout (brand bar on top, panels rendered below it at
    // panelTopOffset).
    //
    // Previously this anchored the BOTTOM-RIGHT corner, which grew the window
    // UPWARD. Because the brand bar is pinned to the (rising) top edge, every
    // expand dragged it upward on screen — a visible jump — and near the top of
    // the screen the upward growth hit the work-area ceiling and clamped
    // mid-animation, producing the abrupt spring the dock showed when expanded
    // after being moved to the top.
    //
    // newY is derived from the CURRENT top (not recomputed from a fixed bottom),
    // so it's preserved exactly across expand AND collapse whenever the window
    // fits on screen — no cross-cycle drift. It's only nudged upward (smoothly,
    // since the resize is tracked per animation frame) when a tall panel opened
    // near the bottom edge would otherwise run off-screen.
    const maxX = workArea.x + workArea.width - newWidth
    const maxY = workArea.y + workArea.height - newHeight
    // Only reposition when something actually changes: setPosition is a real
    // native call on every platform (and on X11 an async round-trip), so
    // firing it with the same x/y it already has nudged the window by a
    // rounding pixel after animations settled — the "dock drifted/jumped"
    // reports. The desired position derives identically from unchanged
    // inputs, so skipping the call is always safe.
    const newX = widthChanged
      ? Math.min(Math.max(currentBounds.x + currentBounds.width - newWidth, workArea.x), maxX)
      : Math.min(Math.max(currentBounds.x, workArea.x), maxX)
    const newY = Math.min(Math.max(currentBounds.y, workArea.y), maxY)

    // setBounds in ONE native call: setContentSize+setPosition back-to-back
    // produces two commits (intermediate frame possible), and several WM/DWM
    // combinations transiently re-stack or re-composite a resized window —
    // pairing the calls doubles that surface for no benefit.
    this.overlayWindow.setBounds({ x: newX, y: newY, width: newWidth, height: newHeight })
  }

  public createWindow(): void {
    if (this.launcherWindow !== null) return // Already created

    const primaryDisplay = screen.getPrimaryDisplay()
    const workArea = primaryDisplay.workArea
    this.screenWidth = workArea.width
    this.screenHeight = workArea.height

    // Fixed dimensions per user request
    const width = 1200;
    const height = 800;

    // Calculate centered X, and top-centered Y (5% from top)
    const x = Math.round(workArea.x + (workArea.width - width) / 2);
    // Ensure y is at least workArea.y (don't go offscreen top)
    const topMargin = Math.round(workArea.height * 0.05);
    const y = Math.round(workArea.x + topMargin);

    // --- 1. Create Launcher Window ---
    const isMac = process.platform === "darwin";

    const launcherSettings: Electron.BrowserWindowConstructorOptions = {
      width: width,
      height: height,
      x: x,
      y: y,
      minWidth: 600,
      minHeight: 400,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "preload.js"),
        scrollBounce: true,
        webSecurity: !isDev, // DEBUG: Disable web security only in dev
      },
      show: false, // DEBUG: Force show -> Fixed white screen, now relies on ready-to-show
      // Platform-specific frame settings
      ...(isMac
        ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 14, y: 14 },
          // Without this, the green traffic-light button enters native
          // macOS fullscreen (a new Space) instead of a simple maximize —
          // that's what the dock/menu-bar auto-hiding into floating
          // overlays actually is. Combined with transparent + vibrancy
          // below, that fullscreen Space transition is a known Electron/
          // macOS bug where the vibrant surface fails to repaint and goes
          // solid black. Disabling native fullscreen makes the button do
          // a plain zoom-to-screen-bounds instead, avoiding both.
          fullscreenable: false,
        }
        : { frame: false, titleBarOverlay: false, autoHideMenuBar: true }),
      ...(isMac ? { vibrancy: 'under-window' as const, visualEffectState: 'followWindow' as const } : {}),
      transparent: isMac,
      hasShadow: true,
      backgroundColor: isMac ? "#00000000" : "#000000",
      focusable: true,
      resizable: true,
      movable: true,
      center: true,
      icon: (() => {
        const isMac = process.platform === "darwin";
        const isWin = process.platform === "win32";
        const mode = this.appState.getDisguise();

        if (mode === 'none') {
          if (isMac) {
            return app.isPackaged
              ? path.join(process.resourcesPath, "natively.icns")
              : path.resolve(__dirname, "../../assets/natively.icns");
          } else if (isWin) {
            return app.isPackaged
              ? path.join(process.resourcesPath, "assets/icons/win/icon.ico")
              : path.resolve(__dirname, "../../assets/icons/win/icon.ico");
          } else {
            return app.isPackaged
              ? path.join(process.resourcesPath, "icon.png")
              : path.resolve(__dirname, "../../assets/icon.png");
          }
        }

        // Disguise mode icons
        let iconName = "terminal.png";
        if (mode === 'settings') iconName = "settings.png";
        if (mode === 'activity') iconName = "activity.png";

        const platformDir = isWin ? "win" : "mac";
        return app.isPackaged
          ? path.join(process.resourcesPath, `assets/fakeicon/${platformDir}/${iconName}`)
          : path.resolve(__dirname, `../../assets/fakeicon/${platformDir}/${iconName}`);
      })()
    }

    console.log(`[WindowHelper] Icon Path: ${launcherSettings.icon}`);
    console.log(`[WindowHelper] Start URL: ${startUrl}`);

    try {
      this.launcherWindow = new BrowserWindow(launcherSettings)
      console.log('[WindowHelper] BrowserWindow created successfully');
    } catch (err) {
      console.error('[WindowHelper] Failed to create BrowserWindow:', err);
      return;
    }

    this.launcherWindow.setContentProtection(this.contentProtection)

    this.launcherWindow.loadURL(`${startUrl}?window=launcher`)
      .then(() => console.log('[WindowHelper] loadURL success'))
      .catch((e) => { console.error("[WindowHelper] Failed to load URL:", e) })

    this.launcherWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      console.error(`[WindowHelper] did-fail-load: ${errorCode} ${errorDescription}`);
    });

    // Allow Firebase Google OAuth popup windows.
    // signInWithPopup() asks Electron to open a new BrowserWindow for the
    // accounts.google.com consent screen. Without this handler Electron
    // silently blocks every new-window request, so the popup never appears
    // and the sign-in call hangs / throws "popup-blocked".
    this.launcherWindow.webContents.setWindowOpenHandler(({ url }) => {
      // Parse the URL strictly — substring checks on raw strings can be
      // bypassed by an attacker embedding the trusted hostname in a path or
      // query string (e.g. `evil.com/accounts.google.com`).
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        // Unparseable URL — deny silently
        return { action: 'deny' };
      }

      const { protocol, hostname, pathname } = parsed;

      // Only https is ever allowed into an app-owned popup
      const isHttps = protocol === 'https:';

      const isGoogleAuth = isHttps && (
        // Google's own consent screen
        hostname === 'accounts.google.com' ||
        // www.google.com only for the /accounts/... path family
        (hostname === 'www.google.com' && pathname.startsWith('/accounts/')) ||
        // Firebase auth relay — must be *.firebaseapp.com AND the /__/auth path
        (hostname.endsWith('.firebaseapp.com') && pathname.startsWith('/__/auth')) ||
        // Google OAuth2 token endpoint
        (hostname === 'accounts.google.com' && pathname.startsWith('/o/oauth2'))
      );

      if (isGoogleAuth) {
        // Center the popup on whichever display the launcher window is currently
        // on. Without explicit x/y Electron defaults to the primary display
        // (usually the laptop), so moving the app to an external monitor and
        // clicking "Continue with Google" would open the popup on the wrong screen.
        const popupWidth = 500;
        const popupHeight = 650;

        let popupX: number | undefined;
        let popupY: number | undefined;

        try {
          const { screen } = require('electron');
          const winBounds = this.launcherWindow?.getBounds();
          if (winBounds) {
            // Find the display that contains the centre of the launcher window
            const winCenterX = winBounds.x + Math.floor(winBounds.width / 2);
            const winCenterY = winBounds.y + Math.floor(winBounds.height / 2);
            const currentDisplay = screen.getDisplayNearestPoint({ x: winCenterX, y: winCenterY });
            const { workArea } = currentDisplay;
            // Place popup in the centre of that display's work area
            popupX = workArea.x + Math.floor((workArea.width - popupWidth) / 2);
            popupY = workArea.y + Math.floor((workArea.height - popupHeight) / 2);
          }
        } catch (e) {
          console.warn('[WindowHelper] Could not determine current display for auth popup:', e);
        }

        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: popupWidth,
            height: popupHeight,
            ...(popupX !== undefined && popupY !== undefined ? { x: popupX, y: popupY } : {}),
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              partition: 'persist:google-auth',
            },
            parent: this.launcherWindow ?? undefined,
            modal: false,
            autoHideMenuBar: true,
          },
        };
      }

      // For all other external links, open in the system browser.
      // Only allow http/https — deny mailto, file, javascript, custom schemes etc.
      if (isHttps || protocol === 'http:') {
        require('electron').shell.openExternal(url);
      } else {
        console.warn('[WindowHelper] Blocked non-http(s) external URL:', url);
      }
      return { action: 'deny' };
    });

    // Forward the Google-auth popup's real close event to the renderer.
    // Why this is needed: signInWithPopup()'s own "user closed the popup"
    // detection polls the child window's `.closed` property, which is
    // unreliable for popups created via setWindowOpenHandler's
    // overrideBrowserWindowOptions (Electron's native BrowserWindow, not a
    // true DOM window.open() child) — in practice the SDK's promise can hang
    // forever if the user closes the window before finishing consent,
    // instead of throwing 'auth/popup-closed-by-user'. did-create-window
    // gives us a direct handle to that BrowserWindow so we can listen to its
    // real 'closed' event ourselves and tell the renderer explicitly.
    this.launcherWindow.webContents.on('did-create-window', (childWindow, details) => {
      let isGoogleAuthPopup = false;
      try {
        isGoogleAuthPopup = new URL(details.url).hostname.endsWith('google.com') || new URL(details.url).hostname.endsWith('.firebaseapp.com');
      } catch { /* unparseable — leave false */ }
      if (!isGoogleAuthPopup) return;

      childWindow.once('closed', () => {
        this.launcherWindow?.webContents.send('google-signin-popup-closed');
      });
    });

    // if (isDev) {
    //   this.launcherWindow.webContents.openDevTools({ mode: 'detach' }); // DEBUG: Open DevTools
    // }

    // --- 2. Create Overlay Window (Hidden initially) ---
    const overlaySettings: Electron.BrowserWindowConstructorOptions = {
      width: OVERLAY_DOCK_WIDTH,
      height: 1,
      minWidth: 300,
      minHeight: 1,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "preload.js"),
        scrollBounce: true,
      },
      show: false,
      frame: false, // Frameless
      transparent: true,
      backgroundColor: "#00000000",
      alwaysOnTop: true,
      focusable: true,
      resizable: false, // Enforce automatic resizing only
      movable: true,
      skipTaskbar: true, // Don't show separately in dock/taskbar
      hasShadow: false, // Prevent shadow from adding perceived size/artifacts
    }

    this.overlayWindow = new BrowserWindow(overlaySettings)
    this.overlayWindow.setContentProtection(this.contentProtection)

    if (process.platform === "darwin") {
      // Order matters on macOS: the window level must be raised BEFORE the
      // all-workspaces collection behavior is applied, or the
      // visibleOnFullScreen flag can land on a window still at the default
      // ('floating') level and be ignored — leaving the dock behind any
      // fullscreen Space (exactly the "overlay vanished during a call" bug).
      this.overlayWindow.setAlwaysOnTop(true, OVERLAY_ALWAYS_ON_TOP_LEVEL)
      this.overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      this.overlayWindow.setHiddenInMissionControl(true)
    } else if (process.platform !== 'win32') {
      // Linux: request a level above fullscreen windows AND follow the user
      // across virtual desktops, so switching workspaces mid-call can't leave
      // the dock stranded on the previous one. (Windows has no workspaces;
      // HWND_TOPMOST from alwaysOnTop above already covers everything.)
      this.overlayWindow.setAlwaysOnTop(true, OVERLAY_ALWAYS_ON_TOP_LEVEL)
      this.overlayWindow.setVisibleOnAllWorkspaces(true)
    }

    this.overlayWindow.loadURL(`${startUrl}?window=overlay`).catch(e => {
      console.error('[WindowHelper] Failed to load Overlay URL:', e);
    })

    // --- 3. Startup Sequence ---
    this.launcherWindow.once('ready-to-show', () => {
      this.switchToLauncher()
      this.isWindowVisible = true
    })

    this.setupWindowListeners()
  }

  private setupWindowListeners(): void {
    if (!this.launcherWindow) return

    // Suppress Windows system context menu on right-click (title bar)
    this.launcherWindow.on('system-context-menu', (e, point) => {
      e.preventDefault();
      if (!this.appState.getUndetectable()) {
        this.showContextMenu(this.launcherWindow!, point);
      }
    });

    this.launcherWindow.on("move", () => {
      if (this.launcherWindow) {
        const bounds = this.launcherWindow.getBounds()
        this.launcherPosition = { x: bounds.x, y: bounds.y }
        this.appState.settingsWindowHelper.reposition(bounds)
      }
    })

    this.launcherWindow.on("resize", () => {
      if (this.launcherWindow) {
        const bounds = this.launcherWindow.getBounds()
        this.launcherSize = { width: bounds.width, height: bounds.height }
        this.appState.settingsWindowHelper.reposition(bounds)
      }
    })

    // On Windows/Linux: intercept close and hide to tray instead of quitting,
    // unless the app is actually quitting (e.g. from tray "Quit" menu).
    if (process.platform !== 'darwin') {
      this.launcherWindow.on('close', (e) => {
        if (!this.appState.isQuitting()) {
          e.preventDefault();
          this.launcherWindow?.hide();
          this.isWindowVisible = false;
        }
      });

      // Sync maximize state to renderer so WindowControls stays in sync (Windows/Linux only)
      this.launcherWindow.on('maximize', () => {
        this.launcherWindow?.webContents.send('window-maximized-changed', true);
      });
      this.launcherWindow.on('unmaximize', () => {
        this.launcherWindow?.webContents.send('window-maximized-changed', false);
      });
    }

    this.launcherWindow.on("closed", () => {
      this.launcherWindow = null
      this.stopOverlayPinnedWatchdog()
      // If launcher closes, we should probably quit app or close overlay
      if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
        this.overlayWindow.close()
      }
      this.overlayWindow = null
      this.isWindowVisible = false
    })

    // The OS can silently drop the "always on top" flag on the overlay window
    // without us ever calling setAlwaysOnTop(false) ourselves — e.g. switching
    // between the editor/browser tabs, another app briefly requesting topmost
    // status, or (on Windows) DWM re-ordering z-order during Alt-Tab. When
    // that happens the dock falls one layer back and looks like it "vanished"
    // behind whatever the user just switched to. Electron fires
    // 'always-on-top-changed' whenever the flag changes for ANY reason, so we
    // use it as a watchdog: if the flag ever comes back false while the
    // overlay should still be floating, restore it immediately. This only
    // fires on an actual state change, so it won't spam setAlwaysOnTop() on
    // every show/hide the way a naive "always reassert" fix would.
    if (this.overlayWindow) {
      this.overlayWindow.on('always-on-top-changed', (_e, isAlwaysOnTop) => {
        if (isAlwaysOnTop) return;
        if (!this.overlayWindow || this.overlayWindow.isDestroyed()) return;
        // Restore at the same level the window was pinned at originally —
        // restoring to a weaker level here would silently downgrade the dock
        // below fullscreen windows (the original bug).
        this.overlayWindow.setAlwaysOnTop(true, OVERLAY_ALWAYS_ON_TOP_LEVEL);
      });

      // Windows' screen-capture UI (Win+Shift+S / Snipping Tool, and other
      // capture tools) forces a DWM re-composition pass to build its
      // dimmed-desktop selection overlay. On some GPU/driver combos, a
      // window using setContentProtection(true) (WDA_EXCLUDEFROMCAPTURE) —
      // like ours — gets silently hidden by Windows during that pass and
      // never told to come back, since nothing in our own code called
      // hide() for it. The result: the dock vanishes and the user is left
      // looking at their desktop until they manually reopen the app.
      // overlayHideIsExpected is only set true immediately before OUR OWN
      // hide() calls (see hideOverlayWindowInternal), so any 'hide' event
      // that arrives without it set came from the OS, not us — restore the
      // overlay right away, without stealing focus.
      this.overlayWindow.on('hide', () => {
        const wasExpected = this.overlayHideIsExpected;
        this.overlayHideIsExpected = false;
        if (wasExpected) return;
        if (!this.isWindowVisible || this.currentWindowMode !== 'overlay') return;
        if (!this.overlayWindow || this.overlayWindow.isDestroyed()) return;

        console.warn('[WindowHelper] Overlay was hidden unexpectedly (likely OS screen-capture UI) — restoring it');
        this.overlayWindow.showInactive();
        this.overlayWindow.setAlwaysOnTop(true, OVERLAY_ALWAYS_ON_TOP_LEVEL);
      });

      // "Show desktop" (Win+D), shell/DWM cleanups and some window managers
      // MINIMIZE windows instead of hiding them, and Electron emits only
      // 'minimize' for that — never 'hide' — so the OS-hide watchdog above
      // can't see it. The overlay is frameless, has no minimize affordance of
      // its own and is hidden from the taskbar (skipTaskbar), so nothing in
      // our code and no user gesture through the window can minimize it: any
      // minimize while a meeting overlay is showing came from the OS, and the
      // user has no taskbar button to restore it from. Minimizing also drops
      // the window out of the topmost band, so re-assert the pin after
      // bringing it back (showInactive/restore never steal focus).
      this.overlayWindow.on('minimize', () => {
        if (!this.isWindowVisible || this.currentWindowMode !== 'overlay') return;
        if (!this.overlayWindow || this.overlayWindow.isDestroyed()) return;

        console.warn('[WindowHelper] Overlay was minimized unexpectedly (likely OS "show desktop") — restoring it');
        if (this.overlayWindow.isMinimized()) this.overlayWindow.restore();
        this.overlayWindow.showInactive();
        this.overlayWindow.setAlwaysOnTop(true, OVERLAY_ALWAYS_ON_TOP_LEVEL);
      });

      this.overlayWindow.on('system-context-menu', (e, point) => {
        e.preventDefault();
        if (!this.appState.getUndetectable()) {
          this.showContextMenu(this.overlayWindow!, point);
        }
      });

      this.overlayWindow.on('close', (e) => {
        // The isQuitting() guard matters for credentials: `before-quit` scrubs the
        // in-memory key store, so vetoing the close here leaves the app running
        // with an emptied CredentialsManager. The launcher's close handler already
        // checks this; the overlay's did not, which is one way a running session
        // ended up with no keys (and, before the write guard, wrote that emptiness
        // back to disk).
        if (this.appState.isQuitting()) return;
        if (this.overlayWindow?.isVisible()) {
          e.preventDefault();
          if (this.appState.getIsMeetingActive()) {
            // Meeting running — just hide the overlay; user can resume from the
            // launcher's "Meeting ongoing" button which calls setWindowMode('overlay').
            this.hideOverlay();
          } else {
            this.switchToLauncher();
          }
        }
      })

      // Belt-and-braces watchdog: the event-driven paths above can't see every
      // way a compositor / window manager can demote a window (some WM
      // re-stacks never fire 'always-on-top-changed' because the FLAG survives
      // while the stacking does not; Win+D goes through 'minimize' only;
      // capture overlays and DWM passes can hide without either event). Every
      // OVERLAY_WATCHDOG_INTERVAL_MS while an overlay session is live, re-pin
      // the flag/level and re-show if the OS dropped the window. All three
      // calls are idempotent no-ops when nothing changed, never steal focus
      // (showInactive), and the overlayWatchdogRestoring guard keeps the
      // re-show re-entrant-safe if a restore attempt itself gets swallowed.
      this.startOverlayPinnedWatchdog();
    }
  }

  // The interval and the reasons above are heuristic tuning, not exactness
  // requirements: the watchdog only needs to run often enough that a demoted
  // overlay is noticeable-and-recovered well within a second.
  private static readonly OVERLAY_WATCHDOG_INTERVAL_MS = 500;

  // One watchdog tick. Shared by the periodic timer and available to any
  // future recovery path that wants to force a full re-pin.
  private reassertOverlayPinned(): void {
    const overlay = this.overlayWindow;
    if (!overlay || overlay.isDestroyed()) return;
    if (!this.isWindowVisible || this.currentWindowMode !== 'overlay') return;

    // Re-assert the topmost pin. On Windows/Linux this is idempotent and
    // focus-free (SWP_NOACTIVATE / gtk keep-above), and matters because WMs
    // can drop the stacking without flipping Electron's flag. On macOS the
    // flag/level are absolute once set, and redundant setAlwaysOnTop calls
    // were observed to trigger [NSApp activate] (see switchToOverlay) — so
    // only call it there when the flag has actually been dropped.
    if (process.platform !== 'darwin' || !overlay.isAlwaysOnTop()) {
      overlay.setAlwaysOnTop(true, OVERLAY_ALWAYS_ON_TOP_LEVEL);
    }

    if (overlay.isMinimized()) {
      console.warn('[WindowHelper] Watchdog: overlay was minimized — restoring it');
      overlay.restore();
    }
    if (!overlay.isVisible() && !this.overlayWatchdogRestoring) {
      console.warn('[WindowHelper] Watchdog: overlay was hidden — restoring it');
      this.overlayWatchdogRestoring = true;
      try {
        overlay.showInactive();
      } finally {
        this.overlayWatchdogRestoring = false;
      }
    }
  }

  private startOverlayPinnedWatchdog(): void {
    if (this.overlayPinnedTimer) return; // already running
    this.overlayPinnedTimer = setInterval(() => {
      try {
        this.reassertOverlayPinned();
      } catch (e) {
        // A tick racing a destroy must never take the app down.
        console.warn('[WindowHelper] Overlay pinned watchdog tick failed:', e);
      }
    }, WindowHelper.OVERLAY_WATCHDOG_INTERVAL_MS);
    // Keep the timer from holding the event loop open at quit; every exit
    // path goes through app.quit() and unref'd timers die with the process.
    this.overlayPinnedTimer.unref?.();
  }

  private stopOverlayPinnedWatchdog(): void {
    if (this.overlayPinnedTimer) {
      clearInterval(this.overlayPinnedTimer);
      this.overlayPinnedTimer = null;
    }
  }

  // Helper to get whichever window should be treated as "Main" for IPC
  public getMainWindow(): BrowserWindow | null {
    if (this.currentWindowMode === 'overlay' && this.overlayWindow) {
      return this.overlayWindow;
    }
    return this.launcherWindow;
  }

  // Specific getters if needed
  public getLauncherWindow(): BrowserWindow | null { return this.launcherWindow }
  public getOverlayWindow(): BrowserWindow | null { return this.overlayWindow }
  public getCurrentWindowMode(): 'launcher' | 'overlay' { return this.currentWindowMode }

  public getLastOverlayBounds(): Electron.Rectangle | null {
    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) return null;
    return this.overlayWindow.getBounds();
  }

  public getLastOverlayDisplayId(): number | null {
    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) return null;
    const bounds = this.overlayWindow.getBounds();
    return screen.getDisplayMatching(bounds).id;
  }

  public isVisible(): boolean {
    return this.isWindowVisible
  }

  public isMainWindowMaximized(): boolean {
    const win = this.launcherWindow;
    return !!win && !win.isDestroyed() && win.isMaximized();
  }

  public hideMainWindow(): void {
    this.launcherWindow?.hide()
    this.hideOverlayWindowInternal()
    this.isWindowVisible = false
  }

  // Every intentional overlay hide funnels through here so the 'hide'
  // listener (setupWindowListeners) knows not to treat it as an OS-triggered
  // disappearance that needs recovering from.
  private hideOverlayWindowInternal(): void {
    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) return;
    this.overlayHideIsExpected = true;
    this.overlayWindow.hide();
    // If the window was already hidden, Electron won't emit 'hide' at all,
    // so the flag would otherwise stay stuck true and mask a real
    // OS-triggered hide later. Clear it on the next tick as a safety net —
    // the 'hide' listener already clears it synchronously on the normal path.
    setImmediate(() => { this.overlayHideIsExpected = false; });
  }

  // Apply or remove click-through (mouse passthrough) on the overlay window.
  // Called whenever the passthrough state changes in AppState.
  public syncOverlayInteractionPolicy(): void {
    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) return;

    const passthrough = this.appState.getOverlayMousePassthrough();
    if (passthrough) {
      // forward: true — pointer events are still delivered to the OS layer beneath
      this.overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      // Focusable must stay false while in passthrough so keyboard focus can't land here
      this.overlayWindow.setFocusable(false);
      console.log('[WindowHelper] Overlay mouse passthrough ON');
    } else {
      this.overlayWindow.setIgnoreMouseEvents(false);
      this.overlayWindow.setFocusable(true);
      console.log('[WindowHelper] Overlay mouse passthrough OFF');
    }
  }

  // Show overlay directly without going through full switchToOverlay flow.
  // Used by IPC handlers to show the overlay independently.
  public showOverlay(): void {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      // Always use showInactive when passthrough is on — never steal focus
      this.overlayWindow.showInactive();
      // Keep isWindowVisible truthful: the overlay pinned-watchdog and the
      // unexpected-hide/minimize recovery listeners both gate on it, so an
      // out-of-sync flag would disable those recoveries for a live session.
      this.isWindowVisible = true;
    }
  }

  // Hide overlay directly without switching to launcher.
  // Used by IPC handlers to hide the overlay independently.
  public hideOverlay(): void {
    this.hideOverlayWindowInternal();
    // Mirror of showOverlay: an intentional overlay hide must also clear the
    // session-visible flag, or the pinned-watchdog/'hide' recovery listeners
    // would treat this hide as an OS glitch and pop the overlay right back.
    this.isWindowVisible = false;
  }

  public showMainWindow(inactive?: boolean): void {
    // Show the window corresponding to the current mode
    if (this.currentWindowMode === 'overlay') {
      this.switchToOverlay(inactive);
    } else {
      this.switchToLauncher(inactive);
    }
  }

  public toggleMainWindow(): void {
    if (this.isWindowVisible) {
      this.hideMainWindow()
    } else {
      // Always show without stealing focus — Natively is a ghost overlay.
      // The user is in another app; show the window on top but leave OS focus alone.
      // They can click the window to focus it if they need to type.
      this.showMainWindow(true)
    }
  }

  public toggleOverlayWindow(): void {
    this.toggleMainWindow();
  }

  public centerAndShowWindow(): void {
    // If a meeting is active (overlay mode), bring the overlay up instead of the
    // launcher — switching to the launcher during a meeting would expose it in the
    // taskbar/dock and break stealth.
    if (this.currentWindowMode === 'overlay') {
      this.switchToOverlay(); // explicit user action, so we want to grant focus
    } else {
      this.switchToLauncher();
      this.launcherWindow?.center();
    }
  }

  // --- Swapping Logic ---

  public switchToOverlay(inactive?: boolean, freshMeetingStart?: boolean, skipReposition?: boolean): void {
    console.log(`[WindowHelper] Switching to OVERLAY (inactive: ${!!inactive})`);
    this.currentWindowMode = 'overlay';
    KeybindManager.getInstance().setMode('overlay'); // Adapted from public PR #123 — verify premium interaction

    // Tell the overlay renderer to expand to full size (e.g. after being minimised)
    this.overlayWindow?.webContents.send('ensure-expanded');

    // Show Overlay FIRST
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      // AFTER
      // On a fresh meeting start, the dock always renders collapsed (brand
      // bar only) — see useFloatingDock's onSessionReset handler, which
      // fires in the same tick. Sizing the window to the OLD height (or the
      // 216 floor below, which is itself taller than the collapsed dock)
      // before that collapse/resize round-trip completes is exactly what
      // caused the visible flicker: window shown briefly at the wrong,
      // taller size with the previous session's expanded content still
      // painted, then snapping down once the renderer catches up. Skip the
      // stale-bounds/216 floor entirely in that case and go straight to the
      // known-correct collapsed height.
      const targetHeight = freshMeetingStart
        ? COLLAPSED_OVERLAY_HEIGHT
        : Math.max(this.overlayWindow.getBounds().height, 216);

      // Always follow the launcher's current display — it may have been moved to an
      // external monitor. Using the cursor or the overlay's stale bounds both fail
      // because getDisplayMatching() never returns falsy (it always picks the nearest).
      //
      // skipReposition bypasses ALL of this and keeps the overlay exactly where it
      // was. It's set when we're restoring the overlay right after our OWN
      // hide()/show() cycle (e.g. hiding it briefly to take a screenshot) — the
      // overlay's bounds never actually changed, only its visibility did. Without
      // this, every screenshot would silently snap the overlay back to whatever
      // display the (permanently hidden, never-moved) launcher window happens to
      // sit on — normally the primary display — even when the user had deliberately
      // positioned the dock on a different monitor.
      const currentBounds = this.overlayWindow.getBounds();
      let x = currentBounds.x;
      let y = currentBounds.y;

      if (!skipReposition) {
        const launcherBounds = this.launcherWindow?.getBounds();
        const referenceDisplay = launcherBounds
          ? screen.getDisplayMatching(launcherBounds)
          : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

        const workArea = referenceDisplay.workArea;

        // If the overlay is already on the same display as the launcher, keep its
        // current x/y so the user's manual repositioning is respected.
        const currentDisplay = screen.getDisplayMatching(currentBounds);
        const onSameDisplay = currentDisplay.id === referenceDisplay.id;

        // Snap to the TOP-right of the reference display on a fresh meeting
        // start (overlayNeedsReposition) or whenever the overlay isn't already on
        // the launcher's display. Otherwise keep the user's manual position from
        // earlier in this meeting. Top-right (not bottom-right) so the dock's
        // top-pinned brand bar has the full screen height BELOW it to expand
        // into: setOverlayDimensions anchors the TOP edge and grows the window
        // downward, so starting at the top means panels open straight down in
        // place — no upward slide or ceiling clamp. Width is the dock's real
        // content width (OVERLAY_DOCK_WIDTH), so the window lands exactly where
        // the visible dock will be on the very first frame — the old 600px
        // placeholder made the first content resize re-anchor the right edge
        // and slide the dock sideways right after it appeared.
        const shouldSnap = this.overlayNeedsReposition || !onSameDisplay;
        x = shouldSnap ? workArea.x + workArea.width - OVERLAY_DOCK_WIDTH - this.overlayEdgeMargin : currentBounds.x;
        y = shouldSnap ? workArea.y + this.overlayEdgeMargin : currentBounds.y;
        this.overlayNeedsReposition = false;
      }

      this.overlayWindow.setBounds({ x, y, width: OVERLAY_DOCK_WIDTH, height: targetHeight });

      if (process.platform === 'win32' && this.contentProtection) {
        // Opacity Shield: Show at 0 opacity first to prevent frame leak
        this.overlayWindow.setOpacity(0);
        if (inactive) this.overlayWindow.showInactive(); else this.overlayWindow.show();
        this.overlayWindow.setContentProtection(true);
        // Small delay to ensure Windows DWM processes the flag before making it opaque

        if (this.opacityTimeout) clearTimeout(this.opacityTimeout);
        this.opacityTimeout = setTimeout(() => {
          if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
            this.overlayWindow.setOpacity(1);
            if (!inactive) this.overlayWindow.focus();
            // Note: do NOT call setAlwaysOnTop here — it triggers NSApp activation on macOS
          }
        }, 60);
      } else {
        this.overlayWindow.setContentProtection(this.contentProtection);
        if (inactive) this.overlayWindow.showInactive(); else this.overlayWindow.show();
        // Only grab focus for explicit user-initiated shows (not shortcut/ghost shows)
        if (!inactive) this.overlayWindow.focus();
        // Do NOT re-assert setAlwaysOnTop on every show — it was set at creation time and
        // persists across hide/show cycles. Calling it again triggers [NSApp activate] on
        // macOS, stealing focus from Zoom/browser even when showInactive() was used.
      }
      this.isWindowVisible = true;
    }

    // Hide Launcher SECOND
    if (this.launcherWindow && !this.launcherWindow.isDestroyed()) {
      this.launcherWindow.hide();
    }
  }

  public switchToLauncher(inactive?: boolean): void {
    console.log(`[WindowHelper] Switching to LAUNCHER (inactive: ${!!inactive})`);
    this.currentWindowMode = 'launcher';
    // Returning to the launcher ends the current overlay "session" — re-arm the
    // bottom-right snap so the next Start GoDojo opens the dock in the corner.
    this.overlayNeedsReposition = true;
    KeybindManager.getInstance().setMode('launcher'); // Adapted from public PR #123 — verify premium interaction

    // Show Launcher FIRST
    if (this.launcherWindow && !this.launcherWindow.isDestroyed()) {
      try {

        if (process.platform === 'win32' && this.contentProtection) {
          // Opacity Shield: Show at 0 opacity first
          this.launcherWindow.setOpacity(0);
          if (inactive) this.launcherWindow.showInactive(); else this.launcherWindow.show();
          this.launcherWindow.setContentProtection(true);

          if (this.opacityTimeout) clearTimeout(this.opacityTimeout);
          this.opacityTimeout = setTimeout(() => {
            if (this.launcherWindow && !this.launcherWindow.isDestroyed()) {
              this.launcherWindow.setOpacity(1);
              if (!inactive) this.launcherWindow.focus();
            }
          }, 60);
        } else {
          this.launcherWindow.setContentProtection(this.contentProtection);
          if (inactive) this.launcherWindow.showInactive(); else this.launcherWindow.show();
          if (!inactive) this.launcherWindow.focus();
        }

        this.isWindowVisible = true;

      } catch (e) {
        console.warn("[WindowHelper] Ignored crash while switching to launcher (window destroying):", e);
      }
    }

    // Hide Overlay SECOND
    this.hideOverlayWindowInternal();
  }

  // Simplified setWindowMode that just calls switchers
  public setWindowMode(mode: 'launcher' | 'overlay', inactive?: boolean, freshMeetingStart?: boolean): void {
    if (mode === 'launcher') {
      this.switchToLauncher(inactive);
    } else {
      this.switchToOverlay(inactive, freshMeetingStart);
    }
  }

  // --- Window Movement (Applies to Overlay mostly, but generalized to active) ---
  private moveActiveWindow(dx: number, dy: number): void {
    const win = this.getMainWindow();
    if (!win) return;

    const [x, y] = win.getPosition();
    win.setPosition(x + dx, y + dy);

    this.currentX = x + dx;
    this.currentY = y + dy;
  }

  public moveWindowRight(): void { this.moveActiveWindow(this.step, 0) }
  public moveWindowLeft(): void { this.moveActiveWindow(-this.step, 0) }
  public moveWindowDown(): void { this.moveActiveWindow(0, this.step) }
  public moveWindowUp(): void { this.moveActiveWindow(0, -this.step) }

  private showContextMenu(win: BrowserWindow, point: { x: number; y: number }): void {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'Developer Console',
        click: () => { win.webContents.toggleDevTools(); }
      },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'forceReload' },
      { type: 'separator' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ];
    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: win, x: point.x, y: point.y });
  }

  public minimizeWindow(): void {
    const win = this.launcherWindow;
    if (!win || win.isDestroyed()) return;
    if (this.opacityTimeout) clearTimeout(this.opacityTimeout);
    win.minimize();
  }

  public maximizeWindow(): void {
    const win = this.launcherWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  }

  public closeWindow(): void {
    const win = this.launcherWindow;
    if (!win || win.isDestroyed()) return;
    if (this.opacityTimeout) clearTimeout(this.opacityTimeout);
    if (process.platform === 'darwin') {
      // macOS convention: the red traffic-light close button hides the
      // window but leaves the app running (Dock icon stays) — unchanged.
      win.close();
    } else {
      // Windows/Linux: the titlebar ✕ button should fully exit the app,
      // not minimize to tray. Mark quitting first so the 'close' listener's
      // hide-to-tray guard in setupWindowListeners() lets this through,
      // then quit so the process actually terminates and disappears from
      // Task Manager (tray icon, background helpers, etc. all torn down
      // via the existing "before-quit" cleanup in main.ts).
      this.appState.setQuitting(true);
      app.quit();
    }
  }
}