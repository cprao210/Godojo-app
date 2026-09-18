const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const nativeModulePath = path.join(__dirname, '..', 'native-module');
const buildAllMacTargets = process.env.NATIVELY_BUILD_ALL_MAC_ARCHES === '1';
const forceNativeBuild = process.env.NATIVELY_FORCE_NATIVE_BUILD === '1';
const skipNativeBuild = process.env.NATIVELY_SKIP_NATIVE_BUILD === '1';

/** Newest mtime among the inputs that actually affect the compiled artifact. */
function newestSourceMtime() {
  let newest = 0;
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile() && full.endsWith('.rs')) {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      }
    }
  };
  visit(path.join(nativeModulePath, 'src'));
  for (const file of ['Cargo.toml', 'Cargo.lock', 'build.rs']) {
    const full = path.join(nativeModulePath, file);
    if (fs.existsSync(full)) newest = Math.max(newest, fs.statSync(full).mtimeMs);
  }
  return newest;
}

function verifyArtifacts(expectedArtifacts) {
  const missing = expectedArtifacts.filter((file) => !fs.existsSync(path.join(nativeModulePath, file)));

  if (missing.length > 0) {
    throw new Error(`Missing native artifacts after build: ${missing.join(', ')}`);
  }

  console.log('Verified native artifacts:');
  for (const file of expectedArtifacts) {
    console.log(`- ${file}`);
  }
}

function runCommand(command) {
  console.log(`> ${command}`);
  execSync(command, { stdio: 'inherit', cwd: nativeModulePath });
}

/**
 * Linux build inputs, checked BEFORE cargo runs. Without this, a missing
 * libpulse-dev surfaces as a pkg-config error a few hundred lines into a
 * webrtc-audio-processing build log, which is a miserable first-run experience.
 *
 * Two groups:
 *   - dev libraries the audio backends link against (libpulse = system audio via
 *     PulseAudio/PipeWire monitor sources, alsa = microphone via cpal)
 *   - the C++ toolchain webrtc-audio-processing needs, since that crate is
 *     cfg-gated to non-Windows and builds its bundled sources with Meson/Ninja
 */
function preflightLinux() {
  const has = (cmd) => {
    try {
      execSync(cmd, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };

  const missing = [];
  // pkg-config itself must exist before we can ask it about anything else.
  if (!has('pkg-config --version')) {
    missing.push('pkg-config');
  } else {
    if (!has('pkg-config --exists libpulse')) missing.push('libpulse-dev');
    if (!has('pkg-config --exists alsa')) missing.push('libasound2-dev');
  }
  if (!has('meson --version')) missing.push('meson');
  if (!has('ninja --version')) missing.push('ninja-build');
  if (!has('command -v clang')) missing.push('libclang-dev');

  if (missing.length === 0) return;

  // apt name -> { dnf, pacman }
  const NAMES = {
    'pkg-config': { dnf: 'pkgconf-pkg-config', pacman: 'pkgconf' },
    'libpulse-dev': { dnf: 'pulseaudio-libs-devel', pacman: 'libpulse' },
    'libasound2-dev': { dnf: 'alsa-lib-devel', pacman: 'alsa-lib' },
    meson: { dnf: 'meson', pacman: 'meson' },
    'ninja-build': { dnf: 'ninja-build', pacman: 'ninja' },
    'libclang-dev': { dnf: 'clang-devel', pacman: 'clang' },
  };
  const translate = (distro) => missing.map((pkg) => NAMES[pkg][distro]).join(' ');

  console.error('\n[build-native] Missing Linux build dependencies:');
  for (const pkg of missing) console.error(`  - ${pkg}`);
  console.error('\nDebian / Ubuntu / Mint / Pop!_OS:');
  console.error(`  sudo apt-get install -y ${missing.join(' ')}`);
  console.error('\nFedora / RHEL:');
  console.error(`  sudo dnf install -y ${translate('dnf')}`);
  console.error('\nArch / Manjaro:');
  console.error(`  sudo pacman -S --needed ${translate('pacman')}`);
  console.error('');

  throw new Error(`Missing Linux build dependencies: ${missing.join(', ')}`);
}

if (os.platform() === 'darwin') {
  const macTargets = buildAllMacTargets
    ? ['x86_64-apple-darwin', 'aarch64-apple-darwin']
    : [os.arch() === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'];

  console.log(
    buildAllMacTargets
      ? 'Building for macOS (darwin) for both x64 and arm64...'
      : `Building for macOS (darwin) for current architecture only: ${macTargets[0]}`
  );

  const artifactMap = {
    'x86_64-apple-darwin': 'index.darwin-x64.node',
    'aarch64-apple-darwin': 'index.darwin-arm64.node',
  };

  for (const target of macTargets) {
    try {
      runCommand(`rustup target add ${target}`);
    } catch (err) {
      console.warn(`Warning: Could not configure rust target ${target}. Continuing anyway.`);
    }

    console.log(`\n--- Building for ${target} ---`);
    runCommand(`npx napi build --platform --target ${target} --release`);
  }

  verifyArtifacts(macTargets.map((target) => artifactMap[target]));

} else if (os.platform() === 'win32') {
  const prebuiltMap = {
    x64: 'index.win32-x64-msvc.node',
    ia32: 'index.win32-ia32-msvc.node',
    arm64: 'index.win32-arm64-msvc.node',
  };
  const prebuilt = prebuiltMap[os.arch()];
  const prebuiltFull = prebuilt ? path.join(nativeModulePath, prebuilt) : null;
  const prebuiltExists = !!prebuiltFull && fs.existsSync(prebuiltFull);

  // The committed .node is a convenience for contributors without the MSVC
  // toolchain — but it must never win over newer Rust sources. This branch used
  // to skip compilation whenever the file merely EXISTED, which silently froze
  // the Windows binary: every Rust-side audio fix landed in git and shipped as
  // dead code, and the app kept running whatever was last committed.
  let upToDate = false;
  if (prebuiltExists && !forceNativeBuild) {
    const artifactMtime = fs.statSync(prebuiltFull).mtimeMs;
    upToDate = artifactMtime >= newestSourceMtime();
  }

  if (skipNativeBuild && prebuiltExists) {
    console.log(`[build-native] NATIVELY_SKIP_NATIVE_BUILD=1 — using ${prebuilt} as-is (may not match src/).`);
  } else if (upToDate) {
    console.log(`[build-native] ${prebuilt} is newer than native-module/src — skipping Rust compilation.`);
  } else {
    if (prebuiltExists) {
      console.log(`[build-native] ${prebuilt} is older than native-module/src — recompiling.`);
    } else {
      console.log(`Building for current platform: ${os.platform()}`);
    }

    // webrtc-audio-processing is cfg-gated to non-Windows in Cargo.toml, so this
    // napi build does not invoke Meson/Ninja/abseil on Windows at all.
    try {
      runCommand('npx napi build --platform --release');
    } catch (err) {
      // Do NOT fall back to the stale artifact: shipping a binary that does not
      // match src/ is the failure mode this check exists to prevent.
      console.error('[build-native] Rust compilation failed. Install the Rust MSVC toolchain (https://rustup.rs) and retry.');
      console.error('[build-native] To build against the committed binary anyway, re-run with NATIVELY_SKIP_NATIVE_BUILD=1.');
      throw err;
    }

    // Verify the artifact was produced
    verifyArtifacts([prebuiltMap[os.arch()]])
  }
} else {
  if (os.platform() === 'linux' && !skipNativeBuild) {
    preflightLinux();
  }

  console.log(`Building for current platform: ${os.platform()}`);
  runCommand('npx napi build --platform --release');

  const artifactMap = {
    win32: {
      x64: ['index.win32-x64-msvc.node'],
      ia32: ['index.win32-ia32-msvc.node'],
      arm64: ['index.win32-arm64-msvc.node'],
    },
    linux: {
      x64: ['index.linux-x64-gnu.node'],
      arm64: ['index.linux-arm64-gnu.node'],
      arm: ['index.linux-arm-gnueabihf.node'],
    },
  };

  const expectedArtifacts = artifactMap[os.platform()]?.[os.arch()];
  if (expectedArtifacts) {
    verifyArtifacts(expectedArtifacts);
  }
}
