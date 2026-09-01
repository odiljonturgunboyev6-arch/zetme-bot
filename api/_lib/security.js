// Zetme AI — Umumiy xavfsizlik yordamchilari (barcha api/*.js shu yerdan import qiladi)
// Fayl nomi "_lib" bilan boshlangani uchun Vercel buni alohida endpoint sifatida
// deploy qilmaydi — faqat boshqa funksiyalar ichidan import qilinadigan modul.

import { kv } from "@vercel/kv";

export function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(fwd) ? fwd[0] : String(fwd || "")).split(",")[0].trim();
  return ip || req.socket?.remoteAddress || "unknown";
}

// --- Brute-force himoyasi: parol/kod noto'g'ri kiritilganda IP bo'yicha sanaydi ---
// scope: "auth" (admin/sotuvchi paroli), "kod" (Telegram ulash kodi) va h.k.
function failKey(scope, req) {
  return `rlf:${scope}:${clientIp(req)}`;
}

export async function isBlocked(scope, req, limit) {
  try {
    const count = Number((await kv.get(failKey(scope, req))) || 0);
    return count >= limit;
  } catch (e) {
    console.error("isBlocked:", e);
    return false; // KV vaqtincha ishlamasa — bloklamaymiz, faqat log qoldiramiz
  }
}

export async function recordFailure(scope, req, windowSec) {
  try {
    const key = failKey(scope, req);
    const count = await kv.incr(key);
    if (count === 1) await kv.expire(key, windowSec);
  } catch (e) {
    console.error("recordFailure:", e);
  }
}

export async function clearFailures(scope, req) {
  try {
    await kv.del(failKey(scope, req));
  } catch (e) {
    console.error("clearFailures:", e);
  }
}

export const TOO_MANY_MSG =
  "Juda ko'p noto'g'ri urinish. 15 daqiqadan keyin qayta urinib ko'ring.";

// --- Rasm yuklashda fayl turini tekshirish ---
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
export function isAllowedImageType(contentType) {
  return ALLOWED_IMAGE_TYPES.includes(String(contentType || "").toLowerCase());
}
