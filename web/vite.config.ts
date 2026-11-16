import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@solana/web3.js': path.join(root, 'node_modules/@solana/web3.js'),
    },
  },
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  build: { chunkSizeWarningLimit: 1200 },
});
