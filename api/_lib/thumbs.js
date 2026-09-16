// Zetme AI — Kichik rasm (thumbnail) yordamchilari (2026-09-16)
// Muammo: mahsulot rasmlari 1400px/~1-2MB bo'lib, ro'yxat (grid) da 26+ ta shunday
// rasm bir vaqtda yuklanardi — telefonda sayt juda sekin ochilardi.
// Yechim: har asl rasm uchun 480px WebP nusxa (~20-40KB) yasab Blob'ga qo'yamiz,
// "asl URL -> kichik URL" xaritasini KV'da (`thumbs` kaliti) saqlaymiz.
// GET /api/products va /api/sellers shu xaritadan `thumb` maydonini qo'shib beradi —
// admin panelda hech narsa o'zgarmaydi, eski mahsulotlar ham /api/thumbs orqali
// bir marta "tezlashtiriladi".

import { kv } from "@vercel/kv";
import { put } from "@vercel/blob";

export const THUMB_KEY = "thumbs";
export const THUMB_SIDE = 480;

export async function getThumbMap() {
  try {
    const m = await kv.get(THUMB_KEY);
    return m && typeof m === "object" ? m : {};
  } catch (e) {
    console.error("getThumbMap:", e);
    return {};
  }
}

export async function saveThumbMap(map) {
  await kv.set(THUMB_KEY, map);
}

// Bufferdan 480px WebP yasaydi (sharp — Vercel'da tayyor ishlaydi)
export async function makeThumbBuffer(buffer) {
  const sharp = (await import("sharp")).default;
  return sharp(buffer)
    .rotate()
    .resize({ width: THUMB_SIDE, height: THUMB_SIDE, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 78 })
    .toBuffer();
}

// Buffer -> Blob'ga kichik nusxani yuklab, URL qaytaradi
export async function uploadThumb(buffer, baseName) {
  const thumb = await makeThumbBuffer(buffer);
  const safe = String(baseName || "rasm").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.[^.]+$/, "");
  const blob = await put(`products/thumbs/${Date.now()}-${safe}.webp`, thumb, {
    access: "public",
    contentType: "image/webp",
    cacheControlMaxAge: 31536000,
  });
  return blob.url;
}

// Internetdagi (Blob) asl rasmdan kichik nusxa yasab, xaritaga yozadi
export async function ensureThumbFor(url, map) {
  if (!url || map[url]) return map[url] || "";
  const r = await fetch(url);
  if (!r.ok) throw new Error("Rasmni olib bo'lmadi: " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const name = url.split("/").pop() || "rasm";
  const t = await uploadThumb(buf, name);
  map[url] = t;
  return t;
}
