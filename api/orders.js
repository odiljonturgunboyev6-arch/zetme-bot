// Zetme AI — Sotuvchi buyurtmalari: tarix (analitika) + STATUS boshqaruvi
// POST /api/orders  action bo'yicha:
//   { action:"list" }
//        -> { ok, orders:[{id,status,ts,total,payTotal,items,customer,...}] }
//   { action:"setStatus", id, status }
//        -> statusni o'zgartiradi: yangi | tayyorlanmoqda | yetkazildi | bekor
//           mijozning myorders:<chatId> tarixida ham yangilanadi va
//           mijozga Telegram orqali xabar yuboriladi (BOT_TOKEN bo'lsa)
// Kirish: faqat sessiya tokeni (x-seller-login + x-seller-token). Eski parol headerlari
//         2026-10-05 da olib tashlandi.
// Buyurtmalar api/bot.js da mijoz tasdiqlagan paytda yoziladi (oxirgi 500 ta).

import { kv } from "@vercel/kv";
import { sellerFromTokenHeaders } from "./_lib/auth.js";
import { isBlocked, recordFailure, clearFailures, TOO_MANY_MSG, applyCors, withLock } from "./_lib/security.js";

const AUTH_SCOPE = "auth";
const AUTH_LIMIT = 8;
const AUTH_WINDOW = 900;

async function resolveSeller(req) {
  return sellerFromTokenHeaders(req);
}

export default async function handler(req, res) {
  applyCors(req, res, "POST, OPTIONS", "Content-Type, x-seller-login, x-seller-token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = req.body || {};
    const action = String(body.action || "");

    if (await isBlocked(AUTH_SCOPE, req, AUTH_LIMIT)) {
      return res.status(429).json({ ok: false, error: TOO_MANY_MSG });
    }

    const seller = await resolveSeller(req);
    const sellerId = seller ? seller.id : null;
    if (!sellerId) {
      await recordFailure(AUTH_SCOPE, req, AUTH_WINDOW);
      return res.status(401).json({ ok: false, error: "Sessiya eskirgan — qayta kiring" });
    }
    await clearFailures(AUTH_SCOPE, req);

    if (action === "list") {
      const orders = (await kv.get(`orders:${sellerId}`)) || [];
      return res.status(200).json({ ok: true, orders });
    }

    if (action === "setStatus") {
      const STATUSES = ["yangi", "tayyorlanmoqda", "yuborildi", "bekor"];
      const LABELS = {
        yangi: "🆕 Yangi",
        tayyorlanmoqda: "📦 Tayyorlanmoqda",
        yuborildi: "🚚 Yuborildi",
        yetkazildi: "✅ Yetkazib berildi",
        bekor: "❌ Bekor qilindi",
      };
      const id = String(body.id || "");
      const status = String(body.status || "");
      if (!id) return res.status(400).json({ ok: false, error: "Buyurtma ID si yo'q" });
      if (!STATUSES.includes(status)) return res.status(400).json({ ok: false, error: "Noto'g'ri status" });

      // BEKOR qilish qoidasi: sabab majburiy + mijozga 5-10% bonus vaucher (1 mln gacha qismiga)
      let cancelReason = "", bonusPercent = 0;
      if (status === "bekor") {
        cancelReason = String(body.comment || "").trim().slice(0, 300);
        if (cancelReason.length < 5) {
          return res.status(400).json({ ok: false, error: "Bekor qilish sababini yozing (mijozga ko'rinadi, kamida 5 ta belgi)" });
        }
        bonusPercent = Math.round(Number(body.bonusPercent) || 5);
        if (bonusPercent < 5 || bonusPercent > 10) {
          return res.status(400).json({ ok: false, error: "Bonus 5% dan 10% gacha bo'lishi kerak" });
        }
      }

      const okey = `orders:${sellerId}`;
      // Ro'yxatni o'qib-yozish bir vaqtda ikki so'rovda bir-birini o'chirib yubormasin (qulf)
      const lockRes = await withLock(okey, async () => {
        const orders = (await kv.get(okey)) || [];
        const idx = orders.findIndex((o) => o.id === id);
        if (idx === -1) return { notFound: true };
        // bekor qilingan buyurtma qayta jonlantirilmaydi (bonus vaucher takror berilmasin)
        if (orders[idx].status === "bekor" && status !== "bekor") return { locked: true };

        orders[idx].status = status;
        orders[idx].statusTs = Date.now();
        if (status === "bekor") {
          orders[idx].cancelReason = cancelReason;
          orders[idx].cancelledBy = "sotuvchi";
          orders[idx].bonusPercent = bonusPercent;
        }
        await kv.set(okey, orders);

        // bekor bo'lsa mijozga bonus vaucher yozamiz (bitta buyurtma uchun faqat bir marta)
        const cc = orders[idx].customer && orders[idx].customer.chatId;
        if (status === "bekor" && cc && !orders[idx].bonusGiven) {
          try {
            await withLock(`vouchers:${cc}`, async () => {
              const vkey = `vouchers:${cc}`;
              const vlist = (await kv.get(vkey)) || [];
              vlist.unshift({ sellerId, percent: bonusPercent, cap: 1000000, orderId: id, ts: Date.now(), used: false });
              if (vlist.length > 20) vlist.length = 20;
              await kv.set(vkey, vlist);
            });
            orders[idx].bonusGiven = true;
            await kv.set(okey, orders);
          } catch (e) { console.error("voucher berish:", e); }
        }
        return { orders, idx, custChatId: cc };
      });
      if (lockRes.notFound) return res.status(404).json({ ok: false, error: "Buyurtma topilmadi (eski buyurtmalarda status boshqarilmaydi)" });
      if (lockRes.locked) return res.status(400).json({ ok: false, error: "Bekor qilingan buyurtmani qayta ochib bo'lmaydi" });
      const { orders, idx, custChatId } = lockRes;

      // mijoz tarixida ham yangilaymiz
      const chatId = custChatId;
      if (chatId) {
        try {
          const mkey = `myorders:${chatId}`;
          await withLock(mkey, async () => {
            const mine = (await kv.get(mkey)) || [];
            const mi = mine.findIndex((o) => o.id === id);
            if (mi !== -1) {
              mine[mi].status = status;
              mine[mi].statusTs = Date.now();
              if (status === "bekor") {
                mine[mi].cancelReason = cancelReason;
                mine[mi].cancelledBy = "sotuvchi";
                mine[mi].bonusPercent = bonusPercent;
              }
              await kv.set(mkey, mine);
            }
          });
        } catch (e) { console.error("myorders status:", e); }

        // mijozga Telegram xabar — faqat Telegram orqali ulangan mijozlarga
        // ("w..." bilan boshlanadigan sayt hisoblari TG olmaydi, ular saytdagi profilda ko'radi)
        try {
          const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
          if (BOT_TOKEN && /^\d+$/.test(String(chatId))) {
            const shopName = orders[idx].shopName || (seller && seller.shopName) || "";
            const text = status === "bekor"
              ? `Buyurtmangiz bekor qilindi 😔\n\n#${id}${shopName ? ` · ${shopName} do'koni` : ""}\nSabab: ${cancelReason}\n\n🎁 Uzr sifatida keyingi buyurtmangizga ${bonusPercent}% chegirma taqdim etildi (buyurtmaning 1 mln so'mgacha qismiga). U keyingi buyurtma berganingizda avtomatik qo'llanadi.`
              : `Buyurtmangiz holati yangilandi\n\n#${id}${shopName ? ` · ${shopName} do'koni` : ""}\nYangi holat: ${LABELS[status]}`;
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text }),
            });
          }
        } catch (e) { console.error("status tg:", e); }
      }

      return res.status(200).json({ ok: true, orders });
    }

    /* ---------- to'lovni qabul qilish (sotuvchi tasdiqlaydi) ---------- */
    if (action === "confirmPayment") {
      const id = String(body.id || "");
      if (!id) return res.status(400).json({ ok: false, error: "Buyurtma ID si yo'q" });
      const okey = `orders:${sellerId}`;
      const payRes = await withLock(okey, async () => {
        const orders = (await kv.get(okey)) || [];
        const idx = orders.findIndex((o) => o.id === id);
        if (idx === -1) return { notFound: true };
        orders[idx].paymentStatus = "tolangan";
        orders[idx].paymentConfirmTs = Date.now();
        await kv.set(okey, orders);
        return { orders, idx };
      });
      if (payRes.notFound) return res.status(404).json({ ok: false, error: "Buyurtma topilmadi" });
      const { orders, idx } = payRes;

      const chatId = orders[idx].customer && orders[idx].customer.chatId;
      if (chatId) {
        try {
          const mkey = `myorders:${chatId}`;
          await withLock(mkey, async () => {
            const mine = (await kv.get(mkey)) || [];
            const mi = mine.findIndex((o) => o.id === id);
            if (mi !== -1) { mine[mi].paymentStatus = "tolangan"; mine[mi].paymentConfirmTs = Date.now(); await kv.set(mkey, mine); }
          });
        } catch (e) { console.error("pay myorders:", e); }
        try {
          const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
          if (BOT_TOKEN && /^\d+$/.test(String(chatId))) {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text: `✅ To'lovingiz qabul qilindi\n\n#${id}${orders[idx].shopName ? ` · ${orders[idx].shopName}` : ""}\nRahmat!` }),
            });
          }
        } catch (e) { console.error("pay tg:", e); }
      }
      return res.status(200).json({ ok: true, orders });
    }

    return res.status(400).json({ ok: false, error: "Noma'lum amal" });
  } catch (err) {
    if (err && err.code === "BUSY") return res.status(503).json({ ok: false, error: "Server band — qayta urinib ko'ring" });
    console.error(err);
    return res.status(500).json({ ok: false, error: "Server xatosi" });
  }
}
