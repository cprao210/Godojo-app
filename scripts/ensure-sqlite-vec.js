/**
 * Ensures all sqlite-vec platform packages are present in node_modules,
 * even when the current CPU doesn't match (e.g. building x64 release on arm64).
 * npm skips optional deps with non-matching "cpu" constraints, so we force-install them.
 *
 * Only relevant on macOS: the darwin binaries are needed exclusively to package
 * the mac installers, and that build runs on macOS (CI mac runners / mac dev
 * machines). On Windows/Linux they are dead weight — a dylib cannot load there
 * — so the script exits early. This also sidesteps every Windows pitfall the
 * old implementation hit: "/tmp" resolving to a non-existent D:\tmp (ENOENT),
 * GNU tar reading "C:\..." as a remote host:path, and MSYS mangling the
 * "D:\..." -C destination.
 *
 * Why `npm pack` + tar instead of `npm install <pkg>`: these packages are
 * declared as root optionalDependencies, so npm treats an explicit install as
 * "up to date" and never materializes them on a cpu-mismatched host — the very
 * reason this script exists. `npm pack` fetches the tarball regardless.
 */
const { execSync, execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const SQLITE_VEC_VERSION = '0.1.7-alpha.2';

const packages = [
  'sqlite-vec-darwin-arm64',
  'sqlite-vec-darwin-x64',
];

if (process.platform !== 'darwin') {
  console.log(
    `[ensure-sqlite-vec] Skipping on ${process.platform}: darwin sqlite-vec binaries are only ` +
    'needed when packaging the macOS app, which always happens on a macOS host.'
  );
  process.exit(0);
}

// OS-native temp dir — never assume "/tmp" exists.
const tmpDir = os.tmpdir();
const projectRoot = path.join(__dirname, '..');

for (const pkg of packages) {
  const pkgDir = path.join(projectRoot, 'node_modules', pkg);
  if (fs.existsSync(path.join(pkgDir, 'package.json'))) {
    console.log(`[ensure-sqlite-vec] ${pkg} already present, skipping.`);
    continue;
  }

  console.log(`[ensure-sqlite-vec] ${pkg} missing — fetching...`);
  let tarPath = null;
  try {
    // Keep only the last stdout line: some npm versions print extra notices
    // before the tarball filename.
    const output = execSync(`npm pack ${pkg}@${SQLITE_VEC_VERSION} --pack-destination "${tmpDir}"`, {
      cwd: projectRoot,
      encoding: 'utf-8',
    }).trim();
    const tarball = output.split(/\r?\n/).pop().trim();
    tarPath = path.join(tmpDir, tarball);

    fs.mkdirSync(pkgDir, { recursive: true });
    // Spawn as an argv array (no shell quoting pitfalls with spaces in temp
    // paths). --force-local is only meaningful to GNU tar (stops it reading
    // "C:\..." as a remote host:path); bsdtar on macOS ignores it harmlessly.
    const tarArgs = process.platform === 'win32'
      ? ['--force-local', '-xzf', tarPath, '--strip-components=1', '-C', pkgDir]
      : ['-xzf', tarPath, '--strip-components=1', '-C', pkgDir];
    execFileSync('tar', tarArgs, { stdio: 'inherit' });

    if (fs.existsSync(path.join(pkgDir, 'package.json'))) {
      console.log(`[ensure-sqlite-vec] ${pkg} installed successfully.`);
    } else {
      console.warn(`[ensure-sqlite-vec] Warning: ${pkg} still missing after extraction.`);
    }
  } catch (e) {
    console.warn(`[ensure-sqlite-vec] Warning: could not install ${pkg}:`, e.message);
  } finally {
    // Best-effort cleanup of the downloaded tarball.
    try { if (tarPath && fs.existsSync(tarPath)) fs.unlinkSync(tarPath); } catch { /* ignore */ }
  }
}
