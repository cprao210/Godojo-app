const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const nativeModulePath = path.join(__dirname, '..', 'native-module');
const buildAllMacTargets = process.env.NATIVELY_BUILD_ALL_MAC_ARCHES === '1';
const platform = os.platform();
const arch = os.arch();

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

function createWindowsStub() {
  console.log('================================================');
  console.log(`[build-native] Platform: ${platform}-${arch}`);
  console.log('[build-native] Native audio capture uses macOS CoreAudio.');
  console.log('[build-native] Creating stub module for Windows...');
  console.log('================================================');

  if (!fs.existsSync(nativeModulePath)) {
    fs.mkdirSync(nativeModulePath, { recursive: true });
  }

  // Create stub index.js so require() calls don't crash the app
  const stubIndexPath = path.join(nativeModulePath, 'index.js');
  fs.writeFileSync(stubIndexPath, `
// STUB — Native audio capture requires macOS CoreAudio + ScreenCaptureKit
// This stub allows the app to run on ${platform}-${arch} without audio capture.
const EventEmitter = require('events');

class StubCapture extends EventEmitter {
  constructor() {
    super();
    this._available = false;
    this._sampleRate = 48000;
  }
  start() {
    console.warn('[NativeAudio] Audio capture is not available on ${platform}. macOS required.');
    return this;
  }
  stop() { return this; }
  getSampleRate() { return this._sampleRate; }
  isAvailable() { return false; }
  write() {}
  pause() {}
  resume() {}
}

class SystemAudioCapture extends StubCapture {
  constructor(options) { super(); }
}

class MicrophoneCapture extends StubCapture {
  constructor(options) { super(); }
}

module.exports.SystemAudioCapture = SystemAudioCapture;
module.exports.MicrophoneCapture = MicrophoneCapture;
module.exports.createSystemCapture = (options) => new SystemAudioCapture(options);
module.exports.createMicCapture = (options) => new MicrophoneCapture(options);
`);

  // Create stub type definitions so TypeScript doesn't complain
  const stubTypesPath = path.join(nativeModulePath, 'index.d.ts');
  fs.writeFileSync(stubTypesPath, `
import { EventEmitter } from 'events';

export interface CaptureOptions {
  sampleRate?: number;
  channels?: number;
  deviceId?: string;
}

export class SystemAudioCapture extends EventEmitter {
  constructor(options?: CaptureOptions);
  start(): this;
  stop(): this;
  getSampleRate(): number;
  isAvailable(): boolean;
  write(chunk: Buffer): void;
  pause(): void;
  resume(): void;
}

export class MicrophoneCapture extends EventEmitter {
  constructor(options?: CaptureOptions);
  start(): this;
  stop(): this;
  getSampleRate(): number;
  isAvailable(): boolean;
  write(chunk: Buffer): void;
  pause(): void;
  resume(): void;
}

export function createSystemCapture(options?: CaptureOptions): SystemAudioCapture;
export function createMicCapture(options?: CaptureOptions): MicrophoneCapture;
`);

  // Create a platform-named stub .node file reference for electron-builder
  const stubNodeArtifact = platform === 'win32'
    ? `index.win32-${arch}-msvc.node`
    : `index.linux-${arch}-gnu.node`;

  const stubNodePath = path.join(nativeModulePath, stubNodeArtifact);
  if (!fs.existsSync(stubNodePath)) {
    // Write an empty file so artifact verification doesn't block anything downstream
    fs.writeFileSync(stubNodePath, '');
    console.log(`[build-native] Created empty artifact placeholder: ${stubNodeArtifact}`);
  }

  console.log('[build-native] Stub module created successfully.');
  console.log('[build-native] The app will run but audio capture will be unavailable.');
  console.log('================================================');
}

// ──────────────────────────────────────────────────────
// macOS: Full Rust native build (CoreAudio available)
// ──────────────────────────────────────────────────────
if (platform === 'darwin') {
  const macTargets = buildAllMacTargets
    ? ['x86_64-apple-darwin', 'aarch64-apple-darwin']
    : [arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'];

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

  // ──────────────────────────────────────────────────────
  // Windows/Linux: Create stub (CoreAudio not available)
  // ──────────────────────────────────────────────────────
} else {
  console.log(`[build-native] Detected non-macOS platform: ${platform}-${arch}`);

  // Check if Rust Cargo.toml references macOS-only crates
  const cargoTomlPath = path.join(nativeModulePath, 'Cargo.toml');
  let hasMacOSDeps = false;

  if (fs.existsSync(cargoTomlPath)) {
    const cargoContent = fs.readFileSync(cargoTomlPath, 'utf8');
    const macOnlyCrates = ['coreaudio', 'screencapturekit', 'core-foundation', 'core-audio', 'cocoa'];
    hasMacOSDeps = macOnlyCrates.some((crate) => cargoContent.toLowerCase().includes(crate));
  }

  if (hasMacOSDeps) {
    console.log('[build-native] Cargo.toml contains macOS-only dependencies.');
    console.log('[build-native] Cannot compile Rust native module on this platform.');
    createWindowsStub();
  } else {
    // No macOS-specific deps detected — try building natively
    console.log('[build-native] No macOS-only dependencies detected. Attempting native build...');
    try {
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

      const expectedArtifacts = artifactMap[platform]?.[arch];
      if (expectedArtifacts) {
        verifyArtifacts(expectedArtifacts);
      }
    } catch (err) {
      console.error('[build-native] Native build failed:', err.message);
      console.log('[build-native] Falling back to stub module...');
      createWindowsStub();
    }
  }
}
