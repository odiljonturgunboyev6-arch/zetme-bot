// Zetme AI — Rasm yuklash API — MARKETPLACE versiya
// POST /api/upload
// Body: { filename: "photo.jpg", contentType: "image/jpeg", dataBase64: "..." }
// Javob: { ok: true, url: "https://...public blob url..." }
// Kirish: super-admin (x-admin-password) YOKI faol sotuvchi (x-seller-login + x-seller-password)

import { put } from "@vercel/blob";
import { kv } from "@vercel/kv";
import { createHash } from "crypto";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const MAX_BYTES = 4.5 * 1024 * 1024; // ~4.5 MB — Vercel body limitiga mos

function hashPassword(password, salt) {
  return createHash("sha256").update(salt + ":" + String(password)).digest("hex");
}

async function isAuthorized(req) {
  const admin = req.headers["x-admin-password"];
  if (admin && ADMIN_PASSWORD && admin === ADMIN_PASSWORD) return true;

  const login = String(req.headers["x-seller-login"] || "").trim().toLowerCase();
  const password = String(req.headers["x-seller-password"] || "");
  if (!login || !password) return false;
  const sellers = (await kv.get("sellers")) || [];
  const seller = sellers.find((s) => s.login === login);
  if (!seller || seller.status !== "active") return false;
  if (seller.builtin) return ADMIN_PASSWORD && password === ADMIN_PASSWORD;
  if (!seller.salt || !seller.passwordHash) return false;
  return hashPassword(password, seller.salt) === seller.passwordHash;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-password, x-seller-login, x-seller-password");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  if (!(await isAuthorized(req))) {
    return res.status(401).json({ ok: false, error: "Noto'g'ri parol" });
  }

  try {
    const { filename, contentType, dataBase64 } = req.body || {};
    if (!filename || !dataBase64) {
      return res.status(400).json({ ok: false, error: "Fayl ma'lumotlari yetarli emas" });
    }
    const buffer = Buffer.from(dataBase64, "base64");
    if (buffer.length > MAX_BYTES) {
      return res.status(400).json({ ok: false, error: "Rasm juda katta (4 MB dan kichik yuklang)" });
    }
    const safeName = `products/${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

    const blob = await put(safeName, buffer, {
      access: "public",
      contentType: contentType || "image/jpeg",
    });

    res.status(200).json({ ok: true, url: blob.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Yuklashda xatolik" });
  }
}
