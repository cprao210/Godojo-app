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
        rollupOptions: {
            output: {
                manualChunks: {
                    vendor: ['react', 'react-dom', 'framer-motion'],
                    ui: ['lucide-react', '@radix-ui/react-dialog', '@radix-ui/react-toast']
                }
            }
        }
    }
})
