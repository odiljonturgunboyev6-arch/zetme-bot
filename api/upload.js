// Zetme AI — Rasm yuklash API — MARKETPLACE versiya
// POST /api/upload
// Body: { filename: "photo.jpg", contentType: "image/jpeg", dataBase64: "..." }
// Javob: { ok: true, url: "https://...public blob url..." }
// Kirish: super-admin (x-admin-password) YOKI faol sotuvchi (x-seller-login + x-seller-password)

import { put } from "@vercel/blob";
import { handleUpload } from "@vercel/blob/client";
import { kv } from "@vercel/kv";
import { sellerFromTokenHeaders, sellerFromToken } from "./_lib/auth.js";
import { createHash } from "crypto";
import { isBlocked, recordFailure, clearFailures, TOO_MANY_MSG, isAllowedImageType } from "./_lib/security.js";
import { getThumbMap, saveThumbMap, uploadThumb } from "./_lib/thumbs.js";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const MAX_BYTES = 4.5 * 1024 * 1024; // ~4.5 MB — Vercel body limitiga mos
// 2026-09-29: qisqa mahsulot videosi (5–10 s) ham SHU endpoint orqali — brauzerdan
// to'g'ri Vercel Blob ga ("client upload"); server faqat ruxsat tokenini beradi.
// Alohida api/upload-video.js Hobby tarifidagi 12 ta funksiya chegarasidan oshib ketardi.
const VIDEO_MAX_BYTES = 25 * 1024 * 1024;
const VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];
const AUTH_SCOPE = "auth";
const AUTH_LIMIT = 8;
const AUTH_WINDOW = 900;

function hashPassword(password, salt) {
  return createHash("sha256").update(salt + ":" + String(password)).digest("hex");
}

async function isAuthorized(req) {
  const admin = req.headers["x-admin-password"];
  if (admin && ADMIN_PASSWORD && admin === ADMIN_PASSWORD) return true;
  if (await sellerFromTokenHeaders(req)) return true;

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-password, x-seller-login, x-seller-password, x-seller-token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  // ---- VIDEO: Vercel Blob client-upload protokoli (auth clientPayload ichida) ----
  const bt = req.body && req.body.type;
  if (bt === "blob.generate-client-token" || bt === "blob.upload-completed") {
    try {
      const result = await handleUpload({
        body: req.body,
        request: req,
        onBeforeGenerateToken: async (pathname, clientPayload) => {
          if (await isBlocked(AUTH_SCOPE, req, AUTH_LIMIT)) throw new Error(TOO_MANY_MSG);
          let cp = {};
          try { cp = JSON.parse(clientPayload || "{}"); } catch (e) { cp = {}; }
          const seller = await sellerFromToken(cp.login, cp.token);
          if (!seller) {
            await recordFailure(AUTH_SCOPE, req, AUTH_WINDOW);
            throw new Error("Sessiya tugagan — qaytadan kiring");
          }
          await clearFailures(AUTH_SCOPE, req);
          if (!String(pathname || "").startsWith("videos/")) throw new Error("Noto'g'ri fayl yo'li");
          return {
            allowedContentTypes: VIDEO_TYPES,
            maximumSizeInBytes: VIDEO_MAX_BYTES,
            addRandomSuffix: true,
            cacheControlMaxAge: 31536000,
            tokenPayload: JSON.stringify({ login: seller.login }),
          };
        },
        onUploadCompleted: async () => {},
      });
      return res.status(200).json(result);
    } catch (err) {
      console.error("upload-video:", err);
      const msg = String((err && err.message) || "Yuklashda xatolik");
      return res.status(/Sessiya|urinish/i.test(msg) ? 401 : 400).json({ ok: false, error: msg });
    }
  }

  if (await isBlocked(AUTH_SCOPE, req, AUTH_LIMIT)) {
    return res.status(429).json({ ok: false, error: TOO_MANY_MSG });
  }
  if (!(await isAuthorized(req))) {
    await recordFailure(AUTH_SCOPE, req, AUTH_WINDOW);
    return res.status(401).json({ ok: false, error: "Noto'g'ri parol" });
  }
  await clearFailures(AUTH_SCOPE, req);

  try {
    const { filename, contentType, dataBase64 } = req.body || {};
    if (!filename || !dataBase64) {
      return res.status(400).json({ ok: false, error: "Fayl ma'lumotlari yetarli emas" });
    }
    if (!isAllowedImageType(contentType)) {
      return res.status(400).json({ ok: false, error: "Faqat JPEG, PNG, WEBP yoki GIF rasm yuklash mumkin" });
    }
    const buffer = Buffer.from(dataBase64, "base64");
    if (buffer.length > MAX_BYTES) {
      return res.status(400).json({ ok: false, error: "Rasm juda katta (4 MB dan kichik yuklang)" });
    }
    const safeName = `products/${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

    const blob = await put(safeName, buffer, {
      access: "public",
      contentType,
    });

    // 2026-09-16: tezlik uchun 480px WebP kichik nusxa ham yasaymiz (xato bo'lsa — asl rasm ishlayveradi)
    let thumb = "";
    try {
      thumb = await uploadThumb(buffer, filename);
      const map = await getThumbMap();
      map[blob.url] = thumb;
      await saveThumbMap(map);
    } catch (e) {
      console.error("thumb:", e);
    }

    res.status(200).json({ ok: true, url: blob.url, thumb });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Yuklashda xatolik" });
  }
}
