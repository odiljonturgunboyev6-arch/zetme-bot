// Zetme AI — POST /api/thumbs — eski (kichik nusxasi yo'q) rasmlar uchun
// thumbnail yasash. Faqat super-admin (asosiy do'kon sessiya tokeni). Har chaqiruvda
// ko'pi bilan BATCH ta rasm (Vercel vaqt chegarasi uchun); admin panel
// `remaining` 0 bo'lguncha qayta chaqiradi.
// Javob: { ok, done, remaining, total, errors:[...] }

import { kv } from "@vercel/kv";
import { getThumbMap, saveThumbMap, ensureThumbFor } from "./_lib/thumbs.js";
import { sellerFromTokenHeaders } from "./_lib/auth.js";
import { applyCors } from "./_lib/security.js";

export const maxDuration = 60;
const BATCH = 8;

function collectUrls(products, sellers) {
  const set = new Set();
  for (const p of products || []) {
    for (const v of p.variants || []) {
      if (v.image) set.add(String(v.image));
      for (const u of Array.isArray(v.images) ? v.images : []) if (u) set.add(String(u));
    }
  }
  for (const s of sellers || []) if (s.shopLogo) set.add(String(s.shopLogo));
  // faqat http(s) manzillar (data: URL bo'lsa o'tkazib yuboramiz)
  return [...set].filter((u) => /^https?:\/\//.test(u));
}

export default async function handler(req, res) {
  applyCors(req, res, "POST, GET, OPTIONS", "Content-Type, x-seller-login, x-seller-token");
  if (req.method === "OPTIONS") return res.status(200).end();

  // super-admin: faqat builtin (zetme) sotuvchi tokeni
  const actor = await sellerFromTokenHeaders(req);
  if (!(actor && actor.builtin)) return res.status(401).json({ ok: false, error: "Ruxsat yo'q" });

  try {
    const [products, sellers, map] = await Promise.all([
      kv.get("products"), kv.get("sellers"), getThumbMap(),
    ]);
    const urls = collectUrls(products || [], sellers || []);
    const missing = urls.filter((u) => !map[u]);

    if (req.method === "GET") {
      return res.status(200).json({ ok: true, total: urls.length, remaining: missing.length });
    }

    const errors = [];
    let done = 0;
    for (const u of missing.slice(0, BATCH)) {
      try {
        await ensureThumbFor(u, map);
        done++;
      } catch (e) {
        errors.push(u.split("/").pop() + ": " + (e.message || "xato"));
        // qayta-qayta urinmaslik uchun xato bo'lgan rasmni asl URL bilan belgilaymiz
        map[u] = u;
      }
    }
    await saveThumbMap(map);
    const remaining = missing.length - Math.min(missing.length, BATCH);
    return res.status(200).json({ ok: true, done, remaining, total: urls.length, errors });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Server xatosi" });
  }
}
