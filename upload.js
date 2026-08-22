// Zetme AI — Rasm yuklash API
// POST /api/upload  (admin paroli talab qilinadi)
// Body: { filename: "photo.jpg", contentType: "image/jpeg", dataBase64: "..." }
// Javob: { ok: true, url: "https://...public blob url..." }

import { put } from "@vercel/blob";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-password");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const auth = req.headers["x-admin-password"];
  if (!auth || !ADMIN_PASSWORD || auth !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: "Noto'g'ri parol" });
  }

  try {
    const { filename, contentType, dataBase64 } = req.body || {};
    if (!filename || !dataBase64) {
      return res.status(400).json({ ok: false, error: "Fayl ma'lumotlari yetarli emas" });
    }
    const buffer = Buffer.from(dataBase64, "base64");
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
