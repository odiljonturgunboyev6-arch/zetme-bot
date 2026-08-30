// Zetme AI — Sotuvchi buyurtmalar tarixi (analitika uchun)
// POST /api/orders  { action:"list" }
//   Kirish: sotuvchi headerlari (x-seller-login + x-seller-password)
//           yoki super-admin (x-admin-password) — u holda body.sellerId (default "zetme")
// Javob: { ok:true, orders:[{ts,total,payTotal,priceMode,totalQty,bonusApplied,items,customer}] }
// Buyurtmalar api/bot.js da mijoz tasdiqlagan paytda yoziladi (oxirgi 500 ta).

import { kv } from "@vercel/kv";
import { createHash } from "crypto";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function isAdmin(req) {
  const auth = req.headers["x-admin-password"];
  return auth && ADMIN_PASSWORD && auth === ADMIN_PASSWORD;
}
function hashPassword(password, salt) {
  return createHash("sha256").update(salt + ":" + String(password)).digest("hex");
}
async function resolveSeller(req) {
  const login = String(req.headers["x-seller-login"] || "").trim().toLowerCase();
  const password = String(req.headers["x-seller-password"] || "");
  if (!login || !password) return null;
  const sellers = (await kv.get("sellers")) || [];
  const seller = sellers.find((s) => s.login === login);
  if (!seller || seller.status !== "active") return null;
  if (seller.builtin) return ADMIN_PASSWORD && password === ADMIN_PASSWORD ? seller : null;
  if (!seller.salt || !seller.passwordHash) return null;
  return hashPassword(password, seller.salt) === seller.passwordHash ? seller : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-password, x-seller-login, x-seller-password");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = req.body || {};
    if (String(body.action || "") !== "list") {
      return res.status(400).json({ ok: false, error: "Noma'lum amal" });
    }

    let sellerId = null;
    const seller = await resolveSeller(req);
    if (seller) sellerId = seller.id;
    else if (isAdmin(req)) sellerId = String(body.sellerId || "zetme");
    if (!sellerId) return res.status(401).json({ ok: false, error: "Noto'g'ri parol" });

    const orders = (await kv.get(`orders:${sellerId}`)) || [];
    return res.status(200).json({ ok: true, orders });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Server xatosi" });
  }
}
