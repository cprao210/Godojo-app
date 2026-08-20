import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.mts';

export default mergeConfig(viteConfig, defineConfig({
  test: {
    environment: 'node',
    include: [
      'electron/**/*.test.ts',
      'src/**/*.test.ts',
    ],
    exclude: [
      'node_modules/**',
      'dist/**',
      'dist-electron/**',
    ],
  },
}));