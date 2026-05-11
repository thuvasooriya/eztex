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
        // Don't let Service Worker intercept cross-origin worker requests
        // (bundle, index, format files are fetched from external worker URL)
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/eztex-cors-proxy\.thuva\.workers\.dev\/.*/,
            handler: 'NetworkOnly',
            options: {
              cacheName: 'external-worker',
            },
          },
        ],
      },
      manifest: false, // use public/manifest.webmanifest directly
    }),
  ],
})
