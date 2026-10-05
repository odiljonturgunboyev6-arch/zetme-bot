// Zetme AI — sessiya tokenlari (2026-09-11)
// Login muvaffaqiyatli bo'lganda 30 kunlik token beriladi; brauzer PAROLNI
// EMAS, TOKENNI saqlaydi. Har so'rovda "x-seller-login" + "x-seller-token"
// (yoki body.token) yuboriladi. Token KV da: stoken:<token> -> {login, isSuper}.
import { kv } from "@vercel/kv";
import { randomBytes } from "crypto";

export const TOKEN_TTL = 30 * 24 * 3600; // 30 kun (soniya)

export async function issueToken(seller) {
  const token = randomBytes(24).toString("hex");
  // ver — parol o'zgarganda sotuvchining tokVer qiymati oshadi va eski tokenlar yaroqsiz bo'ladi
  await kv.set(`stoken:${token}`, { login: seller.login, isSuper: !!seller.builtin, ts: Date.now(), ver: Number(seller.tokVer || 0) }, { ex: TOKEN_TTL });
  return token;
}

export async function revokeToken(token) {
  if (token) await kv.del(`stoken:${String(token)}`);
}

// Tokenni tekshiradi — mos kelsa faol seller obyektini qaytaradi, aks holda null.
// sellersList berilmasa KV dan o'qiydi.
export async function sellerFromToken(login, token, sellersList) {
  const lg = String(login || "").trim().toLowerCase();
  const tk = String(token || "");
  if (!lg || !tk || tk.length < 20) return null;
  const rec = await kv.get(`stoken:${tk}`);
  if (!rec || rec.login !== lg) return null;
  const sellers = sellersList || (await kv.get("sellers")) || [];
  const seller = sellers.find((s) => s.login === lg);
  if (!seller || seller.status !== "active") return null;
  if (Number(rec.ver || 0) !== Number(seller.tokVer || 0)) return null;   // parol o'zgargan — eski token o'chadi
  // muddatini uzaytiramiz (faol foydalanuvchi qayta kirmasin)
  try { await kv.expire(`stoken:${tk}`, TOKEN_TTL); } catch (e) {}
  return seller;
}

export async function sellerFromTokenHeaders(req, sellersList) {
  return sellerFromToken(req.headers["x-seller-login"], req.headers["x-seller-token"], sellersList);
}

// Super-admin (asosiy do'kon egasi) — faqat sessiya tokeni orqali. Eski "x-admin-password"
// headeri 2026-10-05 da butunlay olib tashlandi (parol har so'rovda aylanib yurmasin).
export async function adminFromTokenHeaders(req, sellersList) {
  const s = await sellerFromTokenHeaders(req, sellersList);
  return s && s.builtin ? s : null;
}
