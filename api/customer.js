// Zetme AI — Mijoz profili API (sayt Profil sahifasi uchun)
// ----------------------------------------------------------
// Ulanish oqimi: mijoz @zetmeai_bot da /kod yozadi -> bot 6 xonali kod beradi
// (KV: link:<code> = chatId, 10 daqiqa) -> sayt shu kodni yuboradi.
//
// POST /api/customer  action bo'yicha:
//   { action:"link", code }
//        -> kod to'g'ri bo'lsa: doimiy token yaratiladi (KV ctoken:<chatId>),
//           javob: { ok, chatId, token, profile, orders }
//   { action:"me", chatId, token }
//        -> profil + buyurtmalar tarixi (myorders:<chatId>, bot.js yozadi)
//   { action:"updateProfile", chatId, token, firstName?, lastName? }
//   { action:"setPhoto", chatId, token, dataBase64, contentType? }
//        -> rasm Vercel Blob'ga yuklanadi (har mijozga bitta, eskisi almashtiriladi)
//
// customer:<chatId> yozuvi botdagi { name, phone, region } bilan umumiy —
// bu yerda unga firstName, lastName, photo maydonlari qo'shiladi (bot buzilmaydi).

import { kv } from "@vercel/kv";
import { put } from "@vercel/blob";
import { randomBytes } from "crypto";

const MAX_PHOTO_BYTES = 400 * 1024; // ~400KB (sayt oldindan siqadi)

function publicProfile(chatId, c) {
  c = c || {};
  return {
    chatId: String(chatId),
    name: c.name || "",
    firstName: c.firstName || "",
    lastName: c.lastName || "",
    phone: c.phone || "",
    region: c.region || "",
    photo: c.photo || "",
  };
}

async function verify(chatId, token) {
  if (!chatId || !token) return false;
  const saved = await kv.get(`ctoken:${chatId}`);
  return !!saved && saved === token;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = req.body || {};
    const action = String(body.action || "");

    /* ---------- Telegram kodi bilan ulash ---------- */
    if (action === "link") {
      const code = String(body.code || "").trim();
      if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: "6 xonali kodni kiriting" });
      const chatId = await kv.get(`link:${code}`);
      if (!chatId) return res.status(400).json({ ok: false, error: "Kod noto'g'ri yoki muddati tugagan. Botda /kod deb qayta yozing." });
      await kv.del(`link:${code}`);

      let token = await kv.get(`ctoken:${chatId}`);
      if (!token) {
        token = randomBytes(24).toString("hex");
        await kv.set(`ctoken:${chatId}`, token);
      }
      const profile = await kv.get(`customer:${chatId}`);
      const orders = (await kv.get(`myorders:${chatId}`)) || [];
      return res.status(200).json({ ok: true, chatId: String(chatId), token, profile: publicProfile(chatId, profile), orders });
    }

    /* ---------- token talab qiladigan amallar ---------- */
    const chatId = String(body.chatId || "").trim();
    const token = String(body.token || "");
    if (!(await verify(chatId, token))) {
      return res.status(401).json({ ok: false, error: "Ulanish eskirgan — botda /kod deb yozib, qayta ulang" });
    }

    if (action === "me") {
      const profile = await kv.get(`customer:${chatId}`);
      const orders = (await kv.get(`myorders:${chatId}`)) || [];
      return res.status(200).json({ ok: true, profile: publicProfile(chatId, profile), orders });
    }

    if (action === "updateProfile") {
      const c = (await kv.get(`customer:${chatId}`)) || {};
      if (body.firstName !== undefined) c.firstName = String(body.firstName).trim().slice(0, 40);
      if (body.lastName !== undefined) c.lastName = String(body.lastName).trim().slice(0, 40);
      // ism-familiya kiritilsa botdagi umumiy "name" ham chiroyli bo'lib yangilanadi
      if (c.firstName || c.lastName) c.name = `${c.firstName || ""} ${c.lastName || ""}`.trim();
      await kv.set(`customer:${chatId}`, c);
      return res.status(200).json({ ok: true, profile: publicProfile(chatId, c) });
    }

    if (action === "setPhoto") {
      const dataBase64 = String(body.dataBase64 || "");
      if (!dataBase64) return res.status(400).json({ ok: false, error: "Rasm ma'lumoti yo'q" });
      const buffer = Buffer.from(dataBase64, "base64");
      if (buffer.length > MAX_PHOTO_BYTES) {
        return res.status(400).json({ ok: false, error: "Rasm juda katta — kichikroq rasm tanlang" });
      }
      const blob = await put(`customers/${chatId}.jpg`, buffer, {
        access: "public",
        contentType: String(body.contentType || "image/jpeg"),
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      const c = (await kv.get(`customer:${chatId}`)) || {};
      c.photo = blob.url;
      await kv.set(`customer:${chatId}`, c);
      return res.status(200).json({ ok: true, photo: blob.url });
    }

    return res.status(400).json({ ok: false, error: "Noma'lum amal" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Server xatosi" });
  }
}
