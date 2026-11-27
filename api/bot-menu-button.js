// Zetme AI — Telegram bot "Menu" tugmasini saytga bog'lash (bir martalik sozlash)
// POST /api/bot-menu-button   Kirish: super-admin (sessiya tokeni)
// 2026-10-07: shu tugma webhook'ni ham TG_WEBHOOK_SECRET bilan qayta o'rnatadi.
// Nima qiladi: Telegram Bot API'ning setChatMenuButton metodi orqali botning
// standart menyu tugmasini "Web App" turiga o'rnatadi — shundan keyin
// @zetmeai_bot chatidagi xabar yozish maydoni yonida doimiy tugma chiqadi,
// bosilganda sayt to'g'ridan-to'g'ri Telegram ichida (Web App sifatida) ochiladi.
// Mijoz hech qanday havola yozmaydi/qidirmaydi — bir marta bot bilan gaplashgan
// bo'lsa, shu tugma orqali doim to'g'ridan-to'g'ri kiraveradi.

const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const SITE_URL = "https://zetme-bot.vercel.app";

import { sellerFromTokenHeaders } from "./_lib/auth.js";
import { applyCors } from "./_lib/security.js";
async function isAdmin(req) {
  const s = await sellerFromTokenHeaders(req);
  return !!(s && s.builtin);
}

export default async function handler(req, res) {
  applyCors(req, res, "POST, OPTIONS", "Content-Type, x-seller-login, x-seller-token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    if (!(await isAdmin(req))) return res.status(401).json({ ok: false, error: "Ruxsat yo'q" });
    if (!BOT_TOKEN) return res.status(400).json({ ok: false, error: "BOT_TOKEN sozlanmagan" });

    const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        menu_button: {
          type: "web_app",
          text: "🛒 Buyurtma berish",
          web_app: { url: SITE_URL },
        },
      }),
    });
    const tgData = await tgRes.json();
    if (!tgData.ok) {
      return res.status(400).json({ ok: false, error: "Telegram: " + (tgData.description || "xatolik") });
    }

    // 2026-10-16: bot tavsifi (/start dan OLDIN ko'rinadigan "Bu bot nima qila oladi?" oynasi)
    // mijozga aniq qadamlarni ko'rsatadi — o'zbekcha (standart) va ruscha.
    const DESC_UZ = "🪴 ZETME — gul tuvaklar va uy-ro'zg'or buyumlari\n🏭 To'g'ridan-to'g'ri zavoddan · 100+ model\n💰 Zavod narxida · dona va optom\n🚚 O'zbekiston bo'ylab tez yetkazib berish\n\n🛒 Qanday buyurtma beriladi:\n1️⃣ «BOSHLASH» tugmasini bosing\n2️⃣ «🛒 Buyurtma berish»ni bosing\n3️⃣ Tuvakni tanlab, savatga qo'shing\n4️⃣ Ism va raqamingizni yozing — tamom!\n\n📞 +998 90 149 06 08\n📞 +998 77 041 26 11\n📩 @zetplast_admin";
    const DESC_RU = "🪴 ZETME — цветочные горшки и товары для дома\n🏭 Напрямую с завода · 100+ моделей\n💰 Заводские цены · розница и опт\n🚚 Быстрая доставка по Узбекистану\n\n🛒 Как заказать:\n1️⃣ Нажмите «СТАРТ»\n2️⃣ Нажмите «🛒 Buyurtma berish»\n3️⃣ Выберите горшок и добавьте в корзину\n4️⃣ Укажите имя и телефон — готово!\n\n📞 +998 90 149 06 08\n📞 +998 77 041 26 11\n📩 @zetplast_admin";
    const SHORT_UZ = "🪴 Gul tuvaklar zavod narxida · Tez yetkazib berish · 📞 +998 90 149 06 08";
    const SHORT_RU = "🪴 Цветочные горшки по заводским ценам · Быстрая доставка · 📞 +998 90 149 06 08";
    const tgCall = (m, body) => fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${m}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then((r) => r.json()).catch(() => ({ ok: false }));
    await Promise.all([
      tgCall("setMyDescription", { description: DESC_UZ }),
      tgCall("setMyDescription", { description: DESC_RU, language_code: "ru" }),
      tgCall("setMyShortDescription", { short_description: SHORT_UZ }),
      tgCall("setMyShortDescription", { short_description: SHORT_RU, language_code: "ru" }),
    ]);

    // 2026-10-07: webhook'ni maxfiy kalit (TG_WEBHOOK_SECRET) bilan qayta ro'yxatdan o'tkazamiz.
    // api/bot.js 2026-10-05 dan beri kalitsiz so'rovlarni rad etadi — webhook eski (kalitsiz)
    // ro'yxatda qolgani uchun bot /start ga javob bermay qolgan edi.
    const SECRET = (process.env.TG_WEBHOOK_SECRET || "").trim();
    if (!SECRET) return res.status(400).json({ ok: false, error: "TG_WEBHOOK_SECRET sozlanmagan (Vercel ENV)" });
    const whRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `${SITE_URL}/api/bot`, secret_token: SECRET, allowed_updates: ["message"] }),
    });
    const whData = await whRes.json();
    if (!whData.ok) {
      return res.status(400).json({ ok: false, error: "Webhook: " + (whData.description || "xatolik") });
    }
    return res.status(200).json({ ok: true, result: tgData.result, webhook: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Server xatosi" });
  }
}
