// Zetme AI — Vite sozlamasi (2026-09-11)
// Vercel "vite build" ni o'zi ishga tushiradi, natija dist/ papkaga tushadi.
// Statik fayllar (admin.html, icons/, manifest.json, sw.js) repo ildizida
// qoladi — build oxirida dist/ ga NUSXALANADI, GitHub'da hech narsani ko'chirish shart emas.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const STATIC = ["admin.html", "icons", "manifest.json", "sw.js"];

function copyStatic() {
  return {
    name: "zetme-copy-static",
    // Vite <link href="/icons/..."> ni hash'lab assets/ ga ko'chirmoqchi bo'ladi —
    // biz asl manzillarni saqlaymiz (PWA/sw.js aynan /icons/ va /manifest.json ni kutadi):
    // "pre" da vaqtincha belgiga almashtiramiz, "post" da qaytaramiz.
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html.replace(/href="\/(icons\/[^"]+|manifest\.json)"/g, 'href="__ZETME_STATIC__/$1"');
      },
    },
    closeBundle() {
      for (const f of STATIC) {
        const from = resolve(f);
        if (existsSync(from)) cpSync(from, resolve("dist", f), { recursive: true });
      }
    },
  };
}

function restoreStatic() {
  return {
    name: "zetme-restore-static",
    transformIndexHtml: { order: "post", handler: (html) => html.replace(/__ZETME_STATIC__\//g, "/") },
  };
}

export default defineConfig({
  plugins: [react(), copyStatic(), restoreStatic()],
  publicDir: false,
  build: {
    outDir: "dist",
    target: "es2018",
    sourcemap: false,
  },
});
