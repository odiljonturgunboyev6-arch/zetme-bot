// Zetme AI — Qisqa mahsulot videosi (5–10 s) yuklash — 2026-09-28
// POST /api/upload-video
//
// Vercel funksiyalari 4.5 MB dan katta so'rovni qabul qilmaydi, shuning uchun
// video BRAUZERDAN TO'G'RIDAN-TO'G'RI Vercel Blob ga yuklanadi ("client upload").
// Bu endpoint faqat ruxsat tokenini beradi (auth tekshirilgach) — videoning o'zi
// bu yerdan o'tmaydi. Kirish: faol sotuvchi (clientPayload ichida login + sessiya
// tokeni — brauzer PAROLNI emas, tokenni saqlaydi).
//
// Cheklovlar: mp4 / webm / quicktime, 25 MB gacha. Fayl "videos/" papkaga tushadi.

import { handleUpload } from "@vercel/blob/client";
import { sellerFromToken } from "./_lib/auth.js";
import { isBlocked, recordFailure, clearFailures, TOO_MANY_MSG } from "./_lib/security.js";

const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED = ["video/mp4", "video/webm", "video/quicktime"];
const AUTH_SCOPE = "auth";
const AUTH_LIMIT = 8;
const AUTH_WINDOW = 900;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const body = req.body || {};

  try {
    const result = await handleUpload({
      body,
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
          allowedContentTypes: ALLOWED,
          maximumSizeInBytes: MAX_BYTES,
          addRandomSuffix: true,
          cacheControlMaxAge: 31536000,
          tokenPayload: JSON.stringify({ login: seller.login }),
        };
      },
      // Yuklash tugagach Vercel shu yerga xabar beradi — bizga qo'shimcha ish kerak emas
      onUploadCompleted: async () => {},
    });
    return res.status(200).json(result);
  } catch (err) {
    console.error("upload-video:", err);
    const msg = String(err && err.message || "Yuklashda xatolik");
    const status = /Sessiya|TOO_MANY|urinish/i.test(msg) ? 401 : 400;
    return res.status(status).json({ ok: false, error: msg });
  }
}
