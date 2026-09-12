// Zetme AI — sessiya tokenlari (2026-09-11)
// Login muvaffaqiyatli bo'lganda 30 kunlik token beriladi; brauzer PAROLNI
// EMAS, TOKENNI saqlaydi. Har so'rovda "x-seller-login" + "x-seller-token"
// (yoki body.token) yuboriladi. Token KV da: stoken:<token> -> {login, isSuper}.
import { kv } from "@vercel/kv";
import { randomBytes } from "crypto";

export const TOKEN_TTL = 30 * 24 * 3600; // 30 kun (soniya)

export async function issueToken(seller) {
  const token = randomBytes(24).toString("hex");
  await kv.set(`stoken:${token}`, { login: seller.login, isSuper: !!seller.builtin, ts: Date.now() }, { ex: TOKEN_TTL });
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
  // muddatini uzaytiramiz (faol foydalanuvchi qayta kirmasin)
  try { await kv.expire(`stoken:${tk}`, TOKEN_TTL); } catch (e) {}
  return seller;
}

export async function sellerFromTokenHeaders(req, sellersList) {
  return sellerFromToken(req.headers["x-seller-login"], req.headers["x-seller-token"], sellersList);
}
