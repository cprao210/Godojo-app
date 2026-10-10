const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// electron-builder afterPack hook. Runs once per packaged platform/arch, after
// app.asar is written and before the installer (NSIS/DMG/AppImage) is built.
//   macOS   → interim ad-hoc signing (scripts/ad-hoc-sign.js)
//   Windows → app-local Visual C++ runtime for onnxruntime-node (below)

// onnxruntime-node's prebuilt Windows binaries are linked against the MSVC C++
// runtime (MSVCP140 / VCRUNTIME140 / VCRUNTIME140_1). A clean Windows install
// often has no Visual C++ Redistributable, so the binding failed to load ("The
// specified module could not be found") and the intent classifier fell back to
// regex only. Copying the runtime DLLs next to the binding fixes that without an
// installer step or admin prompt, and also works for the portable build:
// Windows resolves a module's dependencies from that module's own folder first.
// App-local deployment of these files is permitted by Microsoft's VC++
// redistributable terms.
const VC_RUNTIME_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];

/** Newest x64 CRT folder of the installed Visual Studio / Build Tools, or null. */
function findVcRuntimeDir(arch) {
    const override = process.env.GODOJO_VC_REDIST_DIR;
    if (override) return override;

    const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    if (!fs.existsSync(vswhere)) return null;

    const installs = execFileSync(vswhere, ['-all', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8' })
        .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

    const candidates = [];
    for (const install of installs) {
        const redistRoot = path.join(install, 'VC', 'Redist', 'MSVC');
        if (!fs.existsSync(redistRoot)) continue;
        for (const version of fs.readdirSync(redistRoot)) {
            const archDir = path.join(redistRoot, version, arch);
            if (!fs.existsSync(archDir)) continue;
            for (const crt of fs.readdirSync(archDir)) {
                if (/^Microsoft\.VC\d+\.CRT$/i.test(crt)) candidates.push({ version, dir: path.join(archDir, crt) });
            }
        }
    }
    // Highest toolset version wins (the v14 runtime is backward compatible).
    candidates.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
    return candidates.length ? candidates[0].dir : null;
}

function bundleVcRuntime(context) {
    const arch = context.arch === 1 ? 'x64' : context.arch === 3 ? 'arm64' : null; // builder-util Arch enum
    if (!arch) {
        console.log(`[after-pack] No VC++ runtime bundling for arch=${context.arch}`);
        return;
    }

    const targetDir = path.join(context.appOutDir, 'resources', 'app.asar.unpacked',
        'node_modules', 'onnxruntime-node', 'bin', 'napi-v3', 'win32', arch);
    if (!fs.existsSync(targetDir)) {
        throw new Error(`[after-pack] onnxruntime-node binaries not found at ${targetDir}`);
    }

    const sourceDir = findVcRuntimeDir(arch);
    if (!sourceDir) {
        throw new Error('[after-pack] Visual C++ redistributable files not found. Install Visual Studio / ' +
            'Build Tools with the "Desktop development with C++" workload, or set GODOJO_VC_REDIST_DIR to a ' +
            `folder containing ${VC_RUNTIME_DLLS.join(', ')}.`);
    }

    for (const dll of VC_RUNTIME_DLLS) {
        const src = path.join(sourceDir, dll);
        if (!fs.existsSync(src)) throw new Error(`[after-pack] ${dll} missing in ${sourceDir}`);
        fs.copyFileSync(src, path.join(targetDir, dll));
    }
    console.log(`[after-pack] Bundled VC++ runtime (${VC_RUNTIME_DLLS.join(', ')}) from ${sourceDir} → ${targetDir}`);
}

exports.default = async function afterPack(context) {
    if (context.electronPlatformName === 'darwin') {
        await require('./ad-hoc-sign').default(context);
    } else if (context.electronPlatformName === 'win32') {
        bundleVcRuntime(context);
    }
};
