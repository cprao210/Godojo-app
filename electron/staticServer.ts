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
 * Starts a local static file server rooted at `distDir` and resolves with
 * the URL of index.html once it's listening. Binds to 127.0.0.1 only —
 * never exposed on the network — and picks an ephemeral free port.
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

        server.on('error', reject);
        // Port 0 = OS-assigned free port; 127.0.0.1 = loopback only.
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            resolve(`http://localhost:${port}`);
        });
    });
}