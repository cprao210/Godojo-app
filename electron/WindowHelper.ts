
import { BrowserWindow, screen, app, Menu } from "electron"
import { AppState } from "./main"
import { KeybindManager } from "./services/KeybindManager"
import { startStaticServer } from "./staticServer"
import path from "node:path"

const isEnvDev = process.env.NODE_ENV === "development"
const isPackaged = app.isPackaged;
const inAppBundle = process.execPath.includes('.app/') || process.execPath.includes('.app\\');

console.log(`[WindowHelper] isEnvDev: ${isEnvDev}, isPackaged: ${isPackaged}, inAppBundle: ${inAppBundle}`);

// Force production mode if running as packaged app or inside app bundle
const isDev = isEnvDev && !isPackaged;

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
  private opacityTimeout: NodeJS.Timeout | null = null

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
    console.log('[WindowHelper] setOverlayDimensions:', width, height);

    const currentBounds = this.overlayWindow.getBounds()
    const currentDisplay = screen.getDisplayNearestPoint({ x: currentBounds.x, y: currentBounds.y });
    const workArea = currentDisplay.workArea
    const maxAllowedWidth = Math.floor(workArea.width * 0.9)
    const maxAllowedHeight = Math.floor(workArea.height * 0.9)
    const newWidth = Math.min(Math.max(width, 300), maxAllowedWidth) // min 300, max 90%
    const newHeight = Math.min(Math.max(height, 1), maxAllowedHeight) // min 1, max 90%

    // Anchor the BOTTOM-RIGHT corner: keep the window's right and bottom edges
    // fixed as its content grows/shrinks. This makes panels expand UPWARD from
    // the corner and lets the compact dock settle back into the corner when a
    // panel closes. (The previous top-left origin let the dock drift upward
    // across open/close cycles once it was near the bottom of the screen.)
    const WIDTH_JITTER_TOLERANCE_PX = 2
    const widthChanged = Math.abs(newWidth - currentBounds.width) > WIDTH_JITTER_TOLERANCE_PX
    const bottom = currentBounds.y + currentBounds.height
    const maxX = workArea.x + workArea.width - newWidth
    const maxY = workArea.y + workArea.height - newHeight
    const newX = widthChanged
      ? Math.min(Math.max(currentBounds.x + currentBounds.width - newWidth, workArea.x), maxX)
      : Math.min(Math.max(currentBounds.x, workArea.x), maxX)
    const newY = Math.min(Math.max(bottom - newHeight, workArea.y), maxY)

    this.overlayWindow.setContentSize(newWidth, newHeight)
    this.overlayWindow.setPosition(newX, newY)
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

    // if (isDev) {
    //   this.launcherWindow.webContents.openDevTools({ mode: 'detach' }); // DEBUG: Open DevTools
    // }

    // --- 2. Create Overlay Window (Hidden initially) ---
    const overlaySettings: Electron.BrowserWindowConstructorOptions = {
      width: 600,
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
      this.overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      this.overlayWindow.setHiddenInMissionControl(true)
      this.overlayWindow.setAlwaysOnTop(true, "floating")
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
      // If launcher closes, we should probably quit app or close overlay
      if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
        this.overlayWindow.close()
      }
      this.overlayWindow = null
      this.isWindowVisible = false
    })

    // Listen for overlay close (e.g. Cmd+W). Never truly destroy it — either
    // hide it (during a meeting) or switch back to launcher (between meetings).
    if (this.overlayWindow) {
      this.overlayWindow.on('system-context-menu', (e, point) => {
        e.preventDefault();
        if (!this.appState.getUndetectable()) {
          this.showContextMenu(this.overlayWindow!, point);
        }
      });

      this.overlayWindow.on('close', (e) => {
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
    this.overlayWindow?.hide()
    this.isWindowVisible = false
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
      if (this.appState.getOverlayMousePassthrough()) {
        this.overlayWindow.showInactive();
      } else {
        this.overlayWindow.showInactive();
      }
    }
  }

  // Hide overlay directly without switching to launcher.
  // Used by IPC handlers to hide the overlay independently.
  public hideOverlay(): void {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.hide();
    }
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

  public switchToOverlay(inactive?: boolean): void {
    console.log(`[WindowHelper] Switching to OVERLAY (inactive: ${!!inactive})`);
    this.currentWindowMode = 'overlay';
    KeybindManager.getInstance().setMode('overlay'); // Adapted from public PR #123 — verify premium interaction

    // Tell the overlay renderer to expand to full size (e.g. after being minimised)
    this.overlayWindow?.webContents.send('ensure-expanded');

    // Show Overlay FIRST
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      // AFTER
      const targetHeight = Math.max(this.overlayWindow.getBounds().height, 216);

      // Always follow the launcher's current display — it may have been moved to an
      // external monitor. Using the cursor or the overlay's stale bounds both fail
      // because getDisplayMatching() never returns falsy (it always picks the nearest).
      const launcherBounds = this.launcherWindow?.getBounds();
      const referenceDisplay = launcherBounds
        ? screen.getDisplayMatching(launcherBounds)
        : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

      const workArea = referenceDisplay.workArea;

      // If the overlay is already on the same display as the launcher, keep its
      // current x/y so the user's manual repositioning is respected.
      const currentBounds = this.overlayWindow.getBounds();
      const currentDisplay = screen.getDisplayMatching(currentBounds);
      const onSameDisplay = currentDisplay.id === referenceDisplay.id;

      // Snap to the bottom-right of the reference display on a fresh meeting
      // start (overlayNeedsReposition) or whenever the overlay isn't already on
      // the launcher's display. Otherwise keep the user's manual position from
      // earlier in this meeting. Width stays at the 600 placeholder; the
      // renderer's ResizeObserver settles it to the real content width via
      // setOverlayDimensions, which preserves this same bottom-right corner.
      const shouldSnap = this.overlayNeedsReposition || !onSameDisplay;
      const x = shouldSnap
        ? workArea.x + workArea.width - 600 - this.overlayEdgeMargin
        : currentBounds.x;
      const y = shouldSnap
        ? workArea.y + workArea.height - targetHeight - this.overlayEdgeMargin
        : currentBounds.y;
      this.overlayNeedsReposition = false;

      this.overlayWindow.setBounds({ x, y, width: 600, height: targetHeight });

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
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.hide();
    }
  }

  // Simplified setWindowMode that just calls switchers
  public setWindowMode(mode: 'launcher' | 'overlay', inactive?: boolean): void {
    if (mode === 'launcher') {
      this.switchToLauncher(inactive);
    } else {
      this.switchToOverlay(inactive);
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