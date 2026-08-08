import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { version } from './package.json'

// Inject version so the React frontend can read it via import.meta.env.VITE_APP_VERSION
process.env.VITE_APP_VERSION = version;

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    base: './', // Use relative paths for Electron
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
            "@/app": path.resolve(__dirname, "./src/app"),
            "@/pages": path.resolve(__dirname, "./src/pages"),
            "@/features": path.resolve(__dirname, "./src/features"),
            "@/components": path.resolve(__dirname, "./src/components"),
            "@/lib": path.resolve(__dirname, "./src/lib"),
            "@/hooks": path.resolve(__dirname, "./src/hooks"),
            "@/types": path.resolve(__dirname, "./src/types"),
            "@/utils": path.resolve(__dirname, "./src/utils"),
            "@/config": path.resolve(__dirname, "./src/config"),
            "@/assets": path.resolve(__dirname, "./src/assets"),
        },
    },
    server: {
        port: 5180,
    },
    build: {
        chunkSizeWarningLimit: 1000,
        // NOTE: manualChunks was removed here on purpose.
        //
        // The previous config split React/react-dom/framer-motion into a
        // "vendor" chunk and lucide-react + the two @radix-ui packages into
        // a separate "ui" chunk. Both lucide-react and @radix-ui touch
        // React's internals (__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED)
        // at module-evaluation time. In an Electron file:// build there is
        // no guarantee the "vendor" chunk finishes evaluating before "ui"
        // starts, so this occasionally produced:
        //   "Cannot read properties of undefined (reading
        //    '__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED')"
        // and a blank screen in the packaged app (npm run dist), even
        // though `npm run dev` worked fine (dev server serves modules
        // on-demand, so the race never showed up there).
        //
        // This is a single-bundle desktop app with no CDN/browser caching
        // to optimize for across page loads, so there's no real upside to
        // manual vendor splitting here — removing it lets Rollup produce a
        // single safe dependency-ordered chunk graph instead.
        //
        // If you want to reintroduce chunk splitting later (e.g. bundle
        // size profiling), keep every React-touching package (react,
        // react-dom, framer-motion, lucide-react, @radix-ui/*) in the SAME
        // chunk — never split a React-dependent UI library away from React
        // itself.
    }
})