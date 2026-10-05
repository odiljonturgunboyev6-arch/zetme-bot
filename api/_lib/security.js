// Zetme AI — Umumiy xavfsizlik yordamchilari (barcha api/*.js shu yerdan import qiladi)
// Fayl nomi "_lib" bilan boshlangani uchun Vercel buni alohida endpoint sifatida
// deploy qilmaydi — faqat boshqa funksiyalar ichidan import qilinadigan modul.

import { kv } from "@vercel/kv";
import { createHash, timingSafeEqual, randomBytes, scryptSync } from "crypto";

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

/* ======================================================================
   2026-10-05 — Qo'shimcha xavfsizlik yordamchilari
   ====================================================================== */

// --- Doimiy vaqtli solishtirish (parol/token — "timing attack"dan himoya) ---
export function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a ?? "")).digest();
  const hb = createHash("sha256").update(String(b ?? "")).digest();
  return timingSafeEqual(ha, hb);
}

// --- CORS: faqat o'z domenlarimiz ---
// Sayt va API bir domenda bo'lgani uchun oddiy so'rovlarga CORS kerak emas;
// bu faqat BOSHQA saytlar javobni o'qib olishining oldini oladi.
function allowedOrigins() {
  const list = new Set([
    "https://zetme-bot.vercel.app",
    "https://zetme.uz",
    "https://www.zetme.uz",
  ]);
  for (const k of ["VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL"]) {
    if (process.env[k]) list.add("https://" + process.env[k]);
  }
  for (const o of String(process.env.ALLOWED_ORIGINS || "").split(",")) {
    if (o.trim()) list.add(o.trim().replace(/\/$/, ""));
  }
  return list;
}
export function applyCors(req, res, methods, headers) {
  const origin = String(req.headers.origin || "");
  if (origin && allowedOrigins().has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", headers);
  res.setHeader("Access-Control-Max-Age", "600");
}

// --- Umumiy tezlik chegarasi (spam / suiiste'mol) ---
// rateLimit("checkout", ip, 6, 600) -> { ok:false } agar 10 daqiqada 6 martadan oshsa.
export async function rateLimit(scope, id, limit, windowSec) {
  try {
    const key = `rl:${scope}:${id}`;
    const n = await kv.incr(key);
    if (n === 1) await kv.expire(key, windowSec);
    return { ok: n <= limit, count: n };
  } catch (e) {
    console.error("rateLimit:", e);
    return { ok: true, count: 0 };   // KV ishlamasa — foydalanuvchini to'smaymiz
  }
}
export const RATE_MSG = "Juda ko'p so'rov yuborildi. Birozdan keyin qayta urinib ko'ring.";

// --- Kalit bo'yicha urinishlar hisobi (masalan: bitta login uchun) ---
export async function isBlockedKey(key, limit) {
  try { return Number((await kv.get(`rlf:${key}`)) || 0) >= limit; } catch (e) { return false; }
}
export async function recordFailureKey(key, windowSec) {
  try {
    const k = `rlf:${key}`;
    const n = await kv.incr(k);
    if (n === 1) await kv.expire(k, windowSec);
  } catch (e) { console.error("recordFailureKey:", e); }
}
export async function clearFailuresKey(key) {
  try { await kv.del(`rlf:${key}`); } catch (e) {}
}

// --- Oddiy qulf: bir vaqtda ikki so'rov bir xil ro'yxatni (buyurtmalar, ombor)
//     o'qib-yozib, bir-birining o'zgarishini o'chirib yubormasligi uchun ---
export async function withLock(name, fn, { ttl = 10, tries = 40, waitMs = 100 } = {}) {
  const key = `lock:${name}`;
  const token = randomBytes(8).toString("hex");
  let got = false;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await kv.set(key, token, { nx: true, ex: ttl });
      if (r) { got = true; break; }
    } catch (e) { console.error("lock:", e); got = true; break; }   // KV xatosi — qulfsiz davom etamiz
    await new Promise((r) => setTimeout(r, waitMs));
  }
  if (!got) { const err = new Error("BUSY"); err.code = "BUSY"; throw err; }
  try {
    return await fn();
  } finally {
    try { if ((await kv.get(key)) === token) await kv.del(key); } catch (e) {}
  }
}

// --- Parollar: scrypt (sekin xesh) + eski sha256 bilan moslik ---
// Yangi format: passwordHash = "scrypt$<hex>". Eski (sha256) parollar muvaffaqiyatli
// kirishda AVTOMATIK scrypt'ga yangilanadi (needsUpgrade).
function scryptHex(password, salt) {
  return scryptSync(String(password), String(salt), 32, { N: 16384, r: 8, p: 1 }).toString("hex");
}
export function makePasswordRecord(password) {
  const salt = randomBytes(16).toString("hex");
  return { salt, passwordHash: "scrypt$" + scryptHex(password, salt) };
}
export function checkPassword(password, rec) {
  if (!rec || !rec.salt || !rec.passwordHash) return { ok: false, needsUpgrade: false };
  const stored = String(rec.passwordHash);
  if (stored.startsWith("scrypt$")) {
    return { ok: safeEqual(stored, "scrypt$" + scryptHex(password, rec.salt)), needsUpgrade: false };
  }
  const legacy = createHash("sha256").update(rec.salt + ":" + String(password)).digest("hex");
  const ok = safeEqual(stored, legacy);
  return { ok, needsUpgrade: ok };
}

// Parol kuchi: kamida 8 belgi, harf ham raqam ham bo'lsin, juda oddiy parollar yo'q
const COMMON_PW = ["12345678", "123456789", "1234567890", "password", "parol123", "qwerty123", "11111111", "00000000", "zetme123", "admin123"];
export function passwordProblem(pw) {
  const p = String(pw || "");
  if (p.length < 8) return "Parol kamida 8 ta belgi bo'lsin";
  if (p.length > 100) return "Parol juda uzun";
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return "Parolda harf ham, raqam ham bo'lsin";
  if (COMMON_PW.includes(p.toLowerCase())) return "Bu parol juda oddiy — boshqasini tanlang";
  return "";
}
