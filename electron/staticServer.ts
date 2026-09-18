// electron/staticServer.ts
//
// Serves the built `dist` folder over http://localhost:<port> in production.
//
// Why this exists: in dev the renderer runs under http://localhost:5180 (Vite),
// which is why "Continue with Google" works there — `localhost` is an
// authorized domain in Firebase by default, so signInWithPopup's postMessage
// handshake back to the opener window succeeds. In production we were loading
// the app via `file://`, which has no authorized-domain equivalent and no
// usable origin for that handshake, so the popup flow silently fails. Serving
// the same build over http://localhost in production keeps the origin
// consistent with dev and fixes Google sign-in without touching Firebase
// console config.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.otf': 'font/otf',
    '.wasm': 'application/wasm',
};

/**
 * Deterministic loopback port for the production renderer.
 *
 * This MUST stay stable across launches. Browser-scoped storage — localStorage
 * and, crucially, the IndexedDB where the Firebase Auth SDK persists the
 * signed-in session — is partitioned by origin, and the origin includes the
 * port. Previously we bound to port 0 (an OS-assigned ephemeral port), so
 * `http://localhost:<port>` changed on every launch; the prior session's
 * IndexedDB was orphaned each time and users were forced to sign in again on
 * every relaunch. Pinning the port keeps the origin identical so the saved
 * session is found again. (In dev the renderer runs under the fixed Vite port
 * 5180, which is why this was never reproducible there.)
 *
 * Chosen from the registered range, away from the app's other loopback
 * servers (Ollama 11434, backend 8000, calendar OAuth 11111/11113).
 */
const PREFERRED_PORT = 42813;

/**
 * Starts a local static file server rooted at `distDir` and resolves with
 * the URL of index.html once it's listening. Binds to 127.0.0.1 only —
 * never exposed on the network — on a fixed port so the renderer origin is
 * stable across launches (see PREFERRED_PORT). Falls back to an ephemeral
 * port only if the fixed one is already taken.
 */
export function startStaticServer(distDir: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            try {
                const reqPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
                let filePath = path.join(distDir, reqPath === '/' ? 'index.html' : reqPath);

                // Guard against path traversal outside distDir.
                if (!filePath.startsWith(distDir)) {
                    res.writeHead(403);
                    res.end('Forbidden');
                    return;
                }

                if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
                    // SPA fallback — client-side routes resolve to index.html.
                    filePath = path.join(distDir, 'index.html');
                }

                const ext = path.extname(filePath).toLowerCase();
                res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
                fs.createReadStream(filePath).pipe(res);
            } catch (e) {
                res.writeHead(500);
                res.end('Internal server error');
            }
        });

        let usedFallback = false;
        server.on('error', (err: NodeJS.ErrnoException) => {
            // Preferred port taken (another process, or a lingering copy of the
            // app). Fall back to an ephemeral port ONCE so the app still boots.
            // The auth session won't persist across restarts in this degraded
            // case, but launching matters more than persistence here.
            if (err.code === 'EADDRINUSE' && !usedFallback) {
                usedFallback = true;
                console.warn(`[staticServer] Port ${PREFERRED_PORT} in use — falling back to an ephemeral port; the auth session may not persist across restarts this launch.`);
                server.listen(0, '127.0.0.1');
                return;
            }
            reject(err);
        });

        // Fires for whichever listen() succeeds (preferred or fallback);
        // resolve() is idempotent, so it settles exactly once with the real
        // bound port. 127.0.0.1 = loopback only; never exposed on the network.
        server.on('listening', () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : PREFERRED_PORT;
            resolve(`http://localhost:${port}`);
        });

        server.listen(PREFERRED_PORT, '127.0.0.1');
    });
}