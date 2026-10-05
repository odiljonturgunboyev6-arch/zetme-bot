// Zetme AI — Rasm yuklash API — MARKETPLACE versiya
// POST /api/upload
// Body: { filename: "photo.jpg", contentType: "image/jpeg", dataBase64: "..." }
// Javob: { ok: true, url: "https://...public blob url..." }
// Kirish: faqat faol sotuvchi/super-admin sessiya tokeni (x-seller-login + x-seller-token)

import { put } from "@vercel/blob";
import { handleUpload } from "@vercel/blob/client";
import { sellerFromTokenHeaders, sellerFromToken } from "./_lib/auth.js";
import { isBlocked, recordFailure, clearFailures, TOO_MANY_MSG, isAllowedImageType, applyCors, rateLimit, RATE_MSG } from "./_lib/security.js";
import { getThumbMap, saveThumbMap, uploadThumb } from "./_lib/thumbs.js";

const MAX_BYTES = 4.5 * 1024 * 1024; // ~4.5 MB — Vercel body limitiga mos
// 2026-09-29: qisqa mahsulot videosi (5–10 s) ham SHU endpoint orqali — brauzerdan
// to'g'ri Vercel Blob ga ("client upload"); server faqat ruxsat tokenini beradi.
// Alohida api/upload-video.js Hobby tarifidagi 12 ta funksiya chegarasidan oshib ketardi.
const VIDEO_MAX_BYTES = 25 * 1024 * 1024;
const VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];
const AUTH_SCOPE = "auth";
const AUTH_LIMIT = 8;
const AUTH_WINDOW = 900;

// Fayl haqiqatan rasmmi? Faqat e'lon qilingan turga ishonmaymiz — birinchi baytlarni tekshiramiz.
function sniffImageType(buf) {
  if (!buf || buf.length < 12) return "";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buf.slice(0, 3).toString("ascii") === "GIF") return "image/gif";
  return "";
}

export default async function handler(req, res) {
  applyCors(req, res, "POST, OPTIONS", "Content-Type, x-seller-login, x-seller-token");
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
          // bitta sotuvchi soatiga ko'pi bilan 15 ta video (xotirani to'ldirib yubormasin)
          const vr = await rateLimit("vid", seller.login, 15, 3600);
          if (!vr.ok) throw new Error(RATE_MSG);
          if (!/^videos\/[a-zA-Z0-9._-]{1,80}$/.test(String(pathname || ""))) throw new Error("Noto'g'ri fayl yo'li");
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
  const uploader = await sellerFromTokenHeaders(req);
  if (!uploader) {
    await recordFailure(AUTH_SCOPE, req, AUTH_WINDOW);
    return res.status(401).json({ ok: false, error: "Sessiya eskirgan — qayta kiring" });
  }
  await clearFailures(AUTH_SCOPE, req);
  // bitta sotuvchi 10 daqiqada ko'pi bilan 60 ta rasm yuklaydi
  const ur = await rateLimit("img", uploader.login, 60, 600);
  if (!ur.ok) return res.status(429).json({ ok: false, error: RATE_MSG });

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
    // haqiqiy fayl turi (e'lon qilingani emas) — rasm bo'lmasa rad etamiz
    const realType = sniffImageType(buffer);
    if (!realType) return res.status(400).json({ ok: false, error: "Bu fayl rasm emas yoki buzilgan" });
    const safeName = `products/${Date.now()}-${String(filename).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80)}`;

    const blob = await put(safeName, buffer, {
      access: "public",
      contentType: realType,
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
