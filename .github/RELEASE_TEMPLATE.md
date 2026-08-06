## Summary

Short one-line description of the release.

## What's New

- Feature one description
- Feature two description
- Feature three description

## Improvements

- Performance improvement
- UX refinement
- Internal optimization

## Fixes

- Resolved crash on startup
- Corrected UI alignment issue

## Technical

- Dependency updates
- Refactored updater logic

## 🍎 macOS Installation (Unsigned Build)

This build is not notarized or signed with an Apple Developer certificate, so macOS Gatekeeper will report **"GoDojo AI.app is damaged and can't be opened"** the first time you try to launch it. The app is **not** actually damaged — this is Gatekeeper's default response to any unsigned, unnotarized app, and clearing the quarantine flag below resolves it.

Download the `.dmg` or `.zip` matching your Mac's chip — **Apple Silicon (M1/M2/M3/M4)** → `arm64`, **Intel** → `x64`. If you're not sure which you have: Apple menu → **About This Mac** → check the chip listed.

**Option A — `.dmg` (recommended):**
1. Before opening the downloaded file, strip its quarantine flag in Terminal:
   ```bash
   xattr -cr ~/Downloads/GoDojo\ AI-2.0.2-arm64.dmg
   # Intel Macs:
   xattr -cr ~/Downloads/GoDojo\ AI-2.0.2-x64.dmg
   ```
2. Double-click the `.dmg` to mount it, then drag **GoDojo AI** into your **Applications** folder.
3. macOS re-applies the quarantine flag to the copied app on install, so clear it once more:
   ```bash
   xattr -cr "/Applications/GoDojo AI.app"
   ```
4. Launch GoDojo AI from Applications or Spotlight — it should open normally.

**Option B — `.zip`:**
1. Unzip the download and move **GoDojo AI.app** into your **Applications** folder.
2. Open Terminal and run:
   ```bash
   xattr -cr "/Applications/GoDojo AI.app"
   ```
3. Launch the app.

**If Terminal isn't an option:** open **System Settings → Privacy & Security**, scroll to the bottom, and click **Open Anyway** next to the GoDojo AI warning — this appears only after you've attempted to open the app at least once.

## 🪟 Windows Installation (Unsigned Build)

This build is not signed with a code-signing certificate, so Microsoft Defender SmartScreen will show a blue **"Windows protected your PC"** screen the first time you run the installer or the portable executable. This is expected for an unsigned build — GoDojo AI is not flagged as malware, SmartScreen simply hasn't seen enough downloads of this binary yet to whitelist it automatically.

**To proceed:**
1. On the SmartScreen prompt, click **More info** (small link, top-left of the dialog).
2. A **Run anyway** button will appear at the bottom — click it.

Two downloads are available:

- **`GoDojo AI Setup <version>.exe`** — the standard installer. Adds Start Menu shortcuts and an uninstaller; you can choose the install location during setup. Recommended for most users.
- **`GoDojo AI <version>.exe` (Portable)** — a single executable that runs without installing anything. No shortcuts or uninstaller are created. Useful on machines where you can't or don't want to run an installer (e.g. restricted work laptops).

**If your antivirus quarantines or deletes the download:** this is also expected for unsigned executables. Restore the file from your antivirus's quarantine list, or add a one-time exclusion for the downloaded file before running it. If you're on a managed/work device, you may need IT to whitelist it.

## 🐧 Linux Installation

Download the `.AppImage` or `.deb` file for your distribution.

- **For .AppImage:**
  1. Make the file executable:
     ```bash
     chmod +x "GoDojo AI-2.0.2.AppImage"
     ```
  2. Run it:
     ```bash
     ./"GoDojo AI-2.0.2.AppImage"
     ```
  3. If it fails to launch with a FUSE-related error (common on newer distros like Ubuntu 22.04+), install `libfuse2` first:
     ```bash
     sudo apt install libfuse2
     ```

- **For .deb (Debian/Ubuntu):**
  1. Install via `apt` (recommended, resolves dependencies automatically):
     ```bash
     sudo apt install ./godojo-ai_2.0.2_amd64.deb
     ```
  2. Or via `dpkg`:
     ```bash
     sudo dpkg -i godojo-ai_2.0.2_amd64.deb
     sudo apt-get install -f   # fixes any missing dependencies
     ```
  3. Launch from your applications menu, or run `godojo-ai` from a terminal.

\\ refer to change.md for detailed changes
