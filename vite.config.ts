/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';

/**
 * Content Security Policy for the production build.
 * `connect-src 'none'` makes the browser refuse ANY fetch/XHR/WebSocket from
 * the app, which enforces the "portfolio data never leaves the browser" rule
 * at the platform level, not just by convention.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'none'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  // Relative base so the build works at https://<user>.github.io/<any-repo-name>/
  base: './',
  plugins: [preact(), cspPlugin()],
  build: {
    target: 'es2022',
    // No source maps in the published build: the source is not public, and a .map file would
    // publish all of it, comments included.
    sourcemap: false,
    // One bundle of ~270 kB gzipped, most of it SheetJS. Everything runs offline once loaded,
    // so splitting would not make the tool faster to use.
    chunkSizeWarningLimit: 1200,
  },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
});
