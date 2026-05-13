import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    solid(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      workbox: {
        globPatterns: [
          '**/*.{js,mjs,css,html,svg,png,ico,woff2,wasm}',
          'init/**/*',
        ],
        navigateFallback: '/index.html',
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // Keep package and format fetches network-only; they are immutable and
        // already cached by OPFS/R2, not by the app shell service worker.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/eztex\.(thuva\.workers\.dev|thuvasooriya\.me)\/(bundle(?:\/.*)?|index(?:\.gz)?|formats\/.*)$/,
            handler: 'NetworkOnly',
            options: {
              cacheName: 'latex-assets',
            },
          },
        ],
      },
      manifest: false, // use public/manifest.webmanifest directly
    }),
  ],
})
