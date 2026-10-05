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
//   { action:"updateProfile", chatId, token, firstName?, lastName?, phone?, email?,
//                              region?, address?, birthday?, note? }  <- sayt "Mening ma'lumotlarim"
//   { action:"setPhoto", chatId, token, dataBase64, contentType? }
//        -> rasm Vercel Blob'ga yuklanadi (har mijozga bitta, eskisi almashtiriladi)
//
// customer:<chatId> yozuvi botdagi { name, phone, region } bilan umumiy —
// bu yerda unga firstName, lastName, photo maydonlari qo'shiladi (bot buzilmaydi).

import { kv } from "@vercel/kv";
import { put } from "@vercel/blob";
import { randomBytes } from "crypto";
import {
  isBlocked, recordFailure, clearFailures, TOO_MANY_MSG, isAllowedImageType,
  applyCors, rateLimit, RATE_MSG, safeEqual, withLock, clientIp,
} from "./_lib/security.js";

const MAX_PHOTO_BYTES = 400 * 1024; // ~400KB (sayt oldindan siqadi)
const KOD_SCOPE = "kod";
const KOD_LIMIT = 10;   // 6 xonali kodni "taxmin qilish"dan himoya
const KOD_WINDOW = 600;

function publicProfile(chatId, c) {
  c = c || {};
  return {
    chatId: String(chatId),
    name: c.name || "",
    firstName: c.firstName || "",
    lastName: c.lastName || "",
    phone: c.phone || "",
    email: c.email || "",
    region: c.region || "",
    address: c.address || "",
    birthday: c.birthday || "",
    note: c.note || "",
    photo: c.photo || "",
    createdAt: c.createdAt || 0,
  };
}

function sum(o) {
  return Math.round(o.payTotal || o.total || 0).toLocaleString("uz-UZ").replace(/,/g, " ") + " so'm";
}

// Sotuvchiga Telegram xabar (telegramChatId bo'lmasa super-adminga)
async function notifySeller(sellerId, text) {
  try {
    const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
    if (!BOT_TOKEN) return;
    const sellers = (await kv.get("sellers")) || [];
    const seller = sellers.find((s) => s.id === sellerId);
    const target = (seller && String(seller.telegramChatId || "").trim()) || process.env.OWNER_CHAT_ID;
    if (!target) return;
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: target, text }),
    });
  } catch (e) { console.error("notifySeller:", e); }
}

async function verify(chatId, token) {
  if (!chatId || !token) return false;
  const saved = await kv.get(`ctoken:${chatId}`);
  return !!saved && safeEqual(saved, token);
}

// Rasm haqiqatan rasmmi (birinchi baytlar)
function sniffImageType(buf) {
  if (!buf || buf.length < 12) return "";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buf.slice(0, 3).toString("ascii") === "GIF") return "image/gif";
  return "";
}
// sotuvchi (orders:<id>) va mijoz (myorders:<chatId>) ro'yxatlarini bir vaqtda xavfsiz o'zgartirish
function lockBoth(okey, mkey, fn) {
  return okey ? withLock(okey, () => withLock(mkey, fn)) : withLock(mkey, fn);
}

export default async function handler(req, res) {
  applyCors(req, res, "POST, OPTIONS", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    // umumiy tezlik chegarasi: bitta IP'dan daqiqasiga 120 ta so'rov
    const rlAll = await rateLimit("cust", clientIp(req), 120, 60);
    if (!rlAll.ok) return res.status(429).json({ ok: false, error: RATE_MSG });
    const body = req.body || {};
    const action = String(body.action || "");

    /* ---------- Telegram kodi bilan ulash ---------- */
    if (action === "link") {
      if (await isBlocked(KOD_SCOPE, req, KOD_LIMIT)) {
        return res.status(429).json({ ok: false, error: TOO_MANY_MSG });
      }
      const code = String(body.code || "").trim();
      if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: "6 xonali kodni kiriting" });
      const chatId = await kv.get(`link:${code}`);
      if (!chatId) {
        await recordFailure(KOD_SCOPE, req, KOD_WINDOW);
        return res.status(400).json({ ok: false, error: "Kod noto'g'ri yoki muddati tugagan. Botda /kod deb qayta yozing." });
      }
      await clearFailures(KOD_SCOPE, req);
      await kv.del(`link:${code}`);

      let token = await kv.get(`ctoken:${chatId}`);
      if (!token) {
        token = randomBytes(24).toString("hex");
        await kv.set(`ctoken:${chatId}`, token);
      }

      // Saytdagi eski "web" hisob (w...) bo'lsa — tarixini Telegram hisobiga ko'chiramiz
      try {
        const oldId = String(body.oldChatId || "");
        const oldToken = String(body.oldToken || "");
        if (oldId && oldId !== String(chatId) && oldToken) {
          const oldSaved = await kv.get(`ctoken:${oldId}`);
          if (oldSaved && oldSaved === oldToken) {
            const oldOrders = (await kv.get(`myorders:${oldId}`)) || [];
            if (oldOrders.length) {
              const mine = (await kv.get(`myorders:${chatId}`)) || [];
              const merged = [...mine, ...oldOrders.filter((o) => !mine.some((m) => m.id && m.id === o.id))]
                .sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 100);
              await kv.set(`myorders:${chatId}`, merged);
              // sotuvchi tomonidagi yozuvlarda chatId ni yangilaymiz (bildirishnomalar TG ga borishi uchun)
              for (const o of oldOrders) {
                if (!o.sellerId || !o.id) continue;
                try {
                  const okey = `orders:${o.sellerId}`;
                  const arr = (await kv.get(okey)) || [];
                  const oi = arr.findIndex((x) => x.id === o.id);
                  if (oi !== -1 && arr[oi].customer) { arr[oi].customer.chatId = String(chatId); await kv.set(okey, arr); }
                } catch (e) {}
              }
            }
            const oldV = (await kv.get(`vouchers:${oldId}`)) || [];
            if (oldV.length) {
              const vlist = (await kv.get(`vouchers:${chatId}`)) || [];
              await kv.set(`vouchers:${chatId}`, [...oldV, ...vlist].slice(0, 20));
            }
            const oldC = (await kv.get(`customer:${oldId}`)) || {};
            const cRec = (await kv.get(`customer:${chatId}`)) || {};
            await kv.set(`customer:${chatId}`, { ...oldC, ...cRec });
            await kv.del(`myorders:${oldId}`);
            await kv.del(`vouchers:${oldId}`);
            await kv.del(`ctoken:${oldId}`);
          }
        }
      } catch (e) { console.error("merge:", e); }
      const profile = await kv.get(`customer:${chatId}`);
      const orders = (await kv.get(`myorders:${chatId}`)) || [];
      const vouchers = ((await kv.get(`vouchers:${chatId}`)) || []).filter((v) => !v.used);
      return res.status(200).json({ ok: true, chatId: String(chatId), token, profile: publicProfile(chatId, profile), orders, vouchers });
    }

    /* ---------- telefon yoki gmail bilan ro'yxatdan o'tish (Telegram shart emas) ----------
       Mijoz Profil bo'limida ismi + telefon yoki email kiritadi -> doimiy "web" hisob
       ochiladi (checkout.js buyurtma vaqtida ochadigan hisobning aynan o'zi), token
       localStorage'da saqlanadi va keyingi safar avtomatik tanib olinadi. Haqiqiy
       SMS/email tasdiqlash yo'q (bunday xizmat hali ulanmagan) — shuning uchun bu
       "eslab qolish" ro'yxatdan o'tish, turli qurilmalar orasida umumiy login emas. */
    if (action === "register") {
      if (await isBlocked(KOD_SCOPE, req, KOD_LIMIT)) {
        return res.status(429).json({ ok: false, error: TOO_MANY_MSG });
      }
      // sun'iy hisoblar yaratib bazani to'ldirishdan himoya: IP'dan soatiga 10 ta
      const rlReg = await rateLimit("creg", clientIp(req), 10, 3600);
      if (!rlReg.ok) return res.status(429).json({ ok: false, error: RATE_MSG });
      const name = String(body.name || "").trim().slice(0, 60);
      const phone = String(body.phone || "").trim().slice(0, 25);
      const email = String(body.email || "").trim().slice(0, 80);
      if (name.length < 2) return res.status(400).json({ ok: false, error: "Ismingizni kiriting" });
      const hasPhone = phone.replace(/\D/g, "").length >= 7;
      const hasEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (!hasPhone && !hasEmail) {
        return res.status(400).json({ ok: false, error: "Telefon raqami yoki email kiriting" });
      }
      const newId = "w" + Date.now().toString(36) + randomBytes(4).toString("hex");
      const newToken = randomBytes(24).toString("hex");
      await kv.set(`ctoken:${newId}`, newToken);
      const c = { name, firstName: name, phone, email, createdAt: Date.now() };
      await kv.set(`customer:${newId}`, c);
      return res.status(200).json({ ok: true, chatId: newId, token: newToken, profile: publicProfile(newId, c), orders: [], vouchers: [] });
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
      const vouchers = ((await kv.get(`vouchers:${chatId}`)) || []).filter((v) => !v.used);
      return res.status(200).json({ ok: true, profile: publicProfile(chatId, profile), orders, vouchers });
    }

    /* ---------- mijoz buyurtmani bekor qiladi ----------
       Faqat sotuvchi "Tayyorlanmoqda"ni bosishidan OLDIN (status "yangi" bo'lganda). */
    if (action === "cancelOrder") {
      const id = String(body.id || "");
      if (!id) return res.status(400).json({ ok: false, error: "Buyurtma ID si yo'q" });

      const mkey = `myorders:${chatId}`;
      const mine0 = (await kv.get(mkey)) || [];
      const mi0 = mine0.findIndex((o) => o.id === id);
      if (mi0 === -1) return res.status(404).json({ ok: false, error: "Buyurtma topilmadi" });
      const sellerId = mine0[mi0].sellerId;
      if (!sellerId) return res.status(400).json({ ok: false, error: "Bu buyurtmani saytdan bekor qilib bo'lmaydi" });
      const okey = `orders:${sellerId}`;

      // Sotuvchi "Tayyorlanmoqda"ni bosishi bilan mijoz bekor qilishi bir vaqtda bo'lsa ham
      // natija bitta bo'ladi (qulf ichida haqiqiy holat qayta tekshiriladi).
      const out = await lockBoth(okey, mkey, async () => {
        const mine = (await kv.get(mkey)) || [];
        const mi = mine.findIndex((o) => o.id === id);
        if (mi === -1) return { err: [404, "Buyurtma topilmadi"] };
        const orders = (await kv.get(okey)) || [];
        const oi = orders.findIndex((o) => o.id === id);
        const realStatus = oi !== -1 ? (orders[oi].status || "yangi") : (mine[mi].status || "yangi");
        if (realStatus !== "yangi") {
          return { err: [400, "Sotuvchi buyurtmani tayyorlashni boshlagan — endi bekor qilib bo'lmaydi. Do'kon bilan bog'laning."] };
        }
        const now = Date.now();
        if (oi !== -1) {
          orders[oi].status = "bekor";
          orders[oi].statusTs = now;
          orders[oi].cancelReason = "Mijoz o'zi bekor qildi";
          orders[oi].cancelledBy = "mijoz";
          await kv.set(okey, orders);
        }
        mine[mi].status = "bekor";
        mine[mi].statusTs = now;
        mine[mi].cancelReason = "O'zingiz bekor qildingiz";
        mine[mi].cancelledBy = "mijoz";
        await kv.set(mkey, mine);
        return { mine, mi };
      });
      if (out.err) return res.status(out.err[0]).json({ ok: false, error: out.err[1] });
      const mine = out.mine, mi = out.mi;

      // sotuvchiga xabar beramiz
      await notifySeller(sellerId, `❌ Mijoz buyurtmani bekor qildi\n\n#${id}${mine[mi].shopName ? ` · ${mine[mi].shopName}` : ""}\nSumma: ${sum(mine[mi])}`);

      return res.status(200).json({ ok: true, orders: mine });
    }

    if (action === "updateProfile") {
      const c = (await kv.get(`customer:${chatId}`)) || {};
      // sayt "Mening ma'lumotlarim" bo'limi shu amal orqali saqlaydi.
      // Har maydon alohida ixtiyoriy: yuborilmagani o'zgarmaydi.
      const set = (key, max) => {
        if (body[key] === undefined) return;
        c[key] = String(body[key] == null ? "" : body[key]).trim().slice(0, max);
      };
      set("firstName", 40);
      set("lastName", 40);
      set("phone", 25);
      set("email", 80);
      set("region", 40);
      set("address", 160);
      set("birthday", 12);
      set("note", 200);
      if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) {
        return res.status(400).json({ ok: false, error: "Email noto'g'ri yozilgan" });
      }
      if (c.phone && c.phone.replace(/\D/g, "").length < 7) {
        return res.status(400).json({ ok: false, error: "Telefon raqami to'liq emas" });
      }
      // ism-familiya kiritilsa botdagi umumiy "name" ham chiroyli bo'lib yangilanadi
      if (c.firstName || c.lastName) c.name = `${c.firstName || ""} ${c.lastName || ""}`.trim();
      if (!c.createdAt) c.createdAt = Date.now();
      await kv.set(`customer:${chatId}`, c);
      return res.status(200).json({ ok: true, profile: publicProfile(chatId, c) });
    }

    if (action === "setPhoto") {
      const dataBase64 = String(body.dataBase64 || "");
      if (!dataBase64) return res.status(400).json({ ok: false, error: "Rasm ma'lumoti yo'q" });
      const contentType = String(body.contentType || "image/jpeg");
      if (!isAllowedImageType(contentType)) {
        return res.status(400).json({ ok: false, error: "Faqat JPEG, PNG, WEBP yoki GIF rasm yuklash mumkin" });
      }
      const rlPh = await rateLimit("cphoto", chatId, 8, 600);
      if (!rlPh.ok) return res.status(429).json({ ok: false, error: RATE_MSG });
      const buffer = Buffer.from(dataBase64, "base64");
      if (buffer.length > MAX_PHOTO_BYTES) {
        return res.status(400).json({ ok: false, error: "Rasm juda katta — kichikroq rasm tanlang" });
      }
      const realType = sniffImageType(buffer);
      if (!realType) return res.status(400).json({ ok: false, error: "Bu fayl rasm emas yoki buzilgan" });
      const blob = await put(`customers/${String(chatId).replace(/[^a-zA-Z0-9_-]/g, "_")}.jpg`, buffer, {
        access: "public",
        contentType: realType,
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      const c = (await kv.get(`customer:${chatId}`)) || {};
      c.photo = blob.url;
      await kv.set(`customer:${chatId}`, c);
      return res.status(200).json({ ok: true, photo: blob.url });
    }

    /* ---------- mijoz: "Buyurtmani qabul qildim" ---------- */
    if (action === "receiveOrder") {
      const id = String(body.id || "");
      if (!id) return res.status(400).json({ ok: false, error: "Buyurtma ID si yo'q" });
      const mkey = `myorders:${chatId}`;
      const mine0 = (await kv.get(mkey)) || [];
      const mi0 = mine0.findIndex((o) => o.id === id);
      if (mi0 === -1) return res.status(404).json({ ok: false, error: "Buyurtma topilmadi" });
      const sellerId = mine0[mi0].sellerId;
      const okey = sellerId ? `orders:${sellerId}` : null;

      const out = await lockBoth(okey, mkey, async () => {
        const mine = (await kv.get(mkey)) || [];
        const mi = mine.findIndex((o) => o.id === id);
        if (mi === -1) return { err: [404, "Buyurtma topilmadi"] };
        const st = mine[mi].status || "yangi";
        if (st === "bekor" || st === "qabul") return { err: [400, "Bu buyurtma allaqachon yakunlangan"] };
        if (st !== "yuborildi") return { err: [400, "Buyurtma hali yuborilmagan — yuborilgandan keyin tasdiqlang"] };
        const now = Date.now();
        mine[mi].status = "qabul";
        mine[mi].statusTs = now;
        await kv.set(mkey, mine);
        if (okey) {
          try {
            const arr = (await kv.get(okey)) || [];
            const oi = arr.findIndex((x) => x.id === id);
            if (oi !== -1) { arr[oi].status = "qabul"; arr[oi].statusTs = now; await kv.set(okey, arr); }
          } catch (e) { console.error("receive seller:", e); }
        }
        return { mine, mi };
      });
      if (out.err) return res.status(out.err[0]).json({ ok: false, error: out.err[1] });
      if (sellerId) {
        await notifySeller(sellerId, `✅ Mijoz buyurtmani QABUL QILDI\n\n#${id}${out.mine[out.mi].shopName ? ` · ${out.mine[out.mi].shopName}` : ""}\nSumma: ${sum(out.mine[out.mi])}`);
      }
      return res.status(200).json({ ok: true, orders: out.mine });
    }

    // 2026-10-05: "To'lov qildim" (paidOrder) amali butunlay olib tashlandi.

    return res.status(400).json({ ok: false, error: "Noma'lum amal" });
  } catch (err) {
    if (err && err.code === "BUSY") return res.status(503).json({ ok: false, error: "Server band — qayta urinib ko'ring" });
    console.error(err);
    return res.status(500).json({ ok: false, error: "Server xatosi" });
  }
}
