// Zetme AI — Telegram boti (Vercel serverless webhook) — MARKETPLACE versiya
// Kerakli ENV: BOT_TOKEN, OWNER_CHAT_ID, TG_WEBHOOK_SECRET, KV_REST_API_URL, KV_REST_API_TOKEN
//
// 2026-10-05: bot endi faqat YORDAMCHI: /kod (saytdagi profilni ulash), /myid (sotuvchi
// Chat ID si), /stat (faqat egasi). Buyurtmalar sayt orqali (api/checkout.js) beriladi va
// Telegramga checkout o'zi xabar yuboradi. Eski "botda buyurtmani tasdiqlash" oqimi
// (hech qachon ma'lumot yozilmaydigan "order:<id>" kaliti) butunlay olib tashlandi —
// ishlatilmaydigan kod = keraksiz hujum yuzasi.

import { kv } from "@vercel/kv";
import { randomInt } from "crypto";
import { safeEqual, rateLimit } from "./_lib/security.js";
import { trackBot, getTraffic } from "./_lib/traffic.js";

// .trim() — Vercel ENV maydoniga nusxa olishda ba'zan ko'rinmas bo'shliq/newline
// qo'shilib qolishi mumkin (BOT_TOKEN'da aynan shu muammo aniqlangan edi —
// Telegram API "Not Found" xatosini qaytargan edi).
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const TG_WEBHOOK_SECRET = (process.env.TG_WEBHOOK_SECRET || "").trim();
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

function fmt(n) {
  return Math.round(n).toLocaleString("uz-UZ").replace(/,/g, " ") + " so'm";
}
function escapeMd(s) {
  return String(s ?? "").replace(/([_*`[\]])/g, "\\$1");
}

async function tg(method, payload) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) console.error(`Telegram ${method} failed:`, data.description);
  return data;
}
const sendMessage = (chatId, text, extra = {}) =>
  tg("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown", ...extra });

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("Zetme AI bot webhook is alive.");

  // Bu so'rov haqiqatan Telegram'dan kelayotganini tekshiramiz. Maxfiy kalit (TG_WEBHOOK_SECRET)
  // o'rnatilmagan bo'lsa webhook UMUMAN ishlamaydi (ilgari bu holda hamma uchun ochiq qolardi).
  const incomingSecret = String(req.headers["x-telegram-bot-api-secret-token"] || "").trim();
  if (!TG_WEBHOOK_SECRET) {
    console.error("TG_WEBHOOK_SECRET sozlanmagan — webhook rad etildi");
    return res.status(503).send("not configured");
  }
  if (!safeEqual(incomingSecret, TG_WEBHOOK_SECRET)) {
    console.error("webhook secret mismatch");
    return res.status(401).send("unauthorized");
  }

  const update = req.body && typeof req.body === "object" ? req.body : {};

  try {
    const msg = update.message;
    if (!msg || !msg.chat) return res.status(200).send("ok");

    const chatId = msg.chat.id;
    const isPrivate = msg.chat.type === "private";
    const text = String(msg.text || "").trim().slice(0, 200);
    // Buyruqlarni katta/kichik harfga bog'liq bo'lmasin deb solishtiramiz
    // (masalan, telefon avtomatik katta harf bilan "/Kod" deb yozib qo'yishi mumkin).
    // "/kod@zetmeai_bot" ko'rinishidagi guruh buyruqlarini ham tanib olamiz.
    const cmd = text.toLowerCase().split(/[\s@]/)[0];

    // 2026-10-07: obunachilar hisobi — shaxsiy chatda yozgan har bir odam (jami + kunlik)
    if (isPrivate) await trackBot(chatId);

    // --- /kod: saytdagi profilni Telegram hisobiga ulash uchun 6 xonali kod ---
    // Sayt api/customer.js action:"link" bilan shu kodni chatId ga aylantiradi.
    // Faqat shaxsiy chatda (guruhda kod berilsa, guruhdagi hamma profilni egallab olardi).
    if (cmd === "/kod" || cmd === "/code") {
      if (!isPrivate) {
        await sendMessage(chatId, "Bu buyruqni botga shaxsiy xabarda yozing.");
        return res.status(200).send("ok");
      }
      const rl = await rateLimit("botkod", String(chatId), 5, 600);
      if (!rl.ok) {
        await sendMessage(chatId, "Juda ko'p so'rov. 10 daqiqadan keyin qayta urinib ko'ring.");
        return res.status(200).send("ok");
      }
      // kriptografik tasodifiy kod; band bo'lsa yangisini olamiz (boshqa odamning kodini ustiga yozmaslik uchun)
      let code = "";
      for (let i = 0; i < 6; i++) {
        const c = String(randomInt(100000, 1000000));
        const ok = await kv.set(`link:${c}`, String(chatId), { ex: 600, nx: true });
        if (ok) { code = c; break; }
      }
      if (!code) {
        await sendMessage(chatId, "Hozir band, birozdan keyin qayta urinib ko'ring.");
        return res.status(200).send("ok");
      }
      await sendMessage(
        chatId,
        `Saytdagi profilingizni ulash kodi:\n\n\`${code}\`\n\nUni saytdagi Profil bo'limiga kiriting. Kod 10 daqiqa amal qiladi.`
      );
      return res.status(200).send("ok");
    }

    // --- /myid: sotuvchilar o'z Chat ID sini olishi uchun (admin panel profiliga yoziladi) ---
    if (cmd === "/myid") {
      await sendMessage(
        chatId,
        `Sizning Chat ID raqamingiz:\n\`${chatId}\`\n\nAgar siz sotuvchi bo'lsangiz, shu raqamni admin paneldagi profilingizga yozing — buyurtmalar shu yerga keladi.`
      );
      return res.status(200).send("ok");
    }

      // --- /stat: FAQAT egasi (OWNER_CHAT_ID) uchun umumiy statistika ---
      if (cmd === "/stat" && isPrivate && OWNER_CHAT_ID && String(chatId) === String(OWNER_CHAT_ID)) {
        const sellers = (await kv.get("sellers")) || [];
        const WEEK = 7 * 24 * 3600 * 1000, now = Date.now();
        let lines = [], tOrders = 0, tSum = 0, w7 = 0, s7 = 0;
        for (const s of sellers) {
          const arr = (await kv.get(`orders:${s.id}`)) || [];
          if (!arr.length) continue;
          const act = arr.filter((o) => o.status !== "bekor");
          const sm = act.reduce((a, o) => a + (o.payTotal || 0), 0);
          const w = act.filter((o) => now - o.ts < WEEK);
          tOrders += act.length; tSum += sm;
          w7 += w.length; s7 += w.reduce((a, o) => a + (o.payTotal || 0), 0);
          const paid = act.filter((o) => o.paymentStatus === "tolangan").length;
          lines.push(`• ${escapeMd(s.shopName)}: ${act.length} ta · ${fmt(sm)}${paid ? ` · to'langan: ${paid}` : ""}${arr.length - act.length ? ` · bekor: ${arr.length - act.length}` : ""}`);
        }
        let tr = "";
        try {
          const t = await getTraffic();
          tr = `\n\n👥 *Foydalanuvchilar*\n🤖 Bot: jami ${t.bot.total} · bugun ${t.bot.today} · kecha ${t.bot.yesterday} · 7 kun ${t.bot.week}` +
            `\n🌐 Sayt: jami ${t.site.total} · bugun ${t.site.today} · kecha ${t.site.yesterday} · 7 kun ${t.site.week}`;
        } catch (e) { console.error("traffic:", e); }
        await sendMessage(
          chatId,
          `📊 *Zetme AI statistikasi*\n\nJami: ${tOrders} ta buyurtma · ${fmt(tSum)}\nOxirgi 7 kun: ${w7} ta · ${fmt(s7)}\n\n${lines.join("\n") || "Hali buyurtma yo'q"}${tr}`
        );
        return res.status(200).send("ok");
      }

      // --- /start va boshqa hamma narsa ---
      // 2026-10-11: ikki alohida bo'lim tugmasi — 🌸 Tuvaklar va 🏠 Uy-ro'zg'or buyumlari
      // (saytni "?bo=uy" bilan ochadi — sayt shu bo'limni/do'konni darhol ko'rsatadi).
      // /uy buyrug'i faqat uy-ro'zg'or tugmasini beradi.
      const SITE = "https://zetme-bot.vercel.app";
      const btnPots = { text: "🌸 Gul tuvaklar", web_app: { url: SITE + "/" } };
      const btnUy = { text: "🏠 Uy-ro'zg'or buyumlari", web_app: { url: SITE + "/?bo=uy" } };
      const kb = isPrivate
        ? { reply_markup: { inline_keyboard: cmd === "/uy" ? [[btnUy]] : [[btnPots], [btnUy]] } }
        : {};
      await sendMessage(
        chatId,
        cmd === "/start"
          ? "Assalomu alaykum! 👋 Zetme AI botiga xush kelibsiz.\n\nBo'limni tanlang:\n🌸 *Gul tuvaklar*\n🏠 *Uy-ro'zg'or buyumlari*\n\nSaytdagi profilni ulash uchun /kod deb yozing."
          : cmd === "/uy"
          ? "🏠 *Uy-ro'zg'or buyumlari* do'koni — pastdagi tugmani bosing."
          : "Bo'limni tanlang 👇 Profilni ulash uchun /kod deb yozing.",
        kb
      );
    return res.status(200).send("ok");
  } catch (err) {
    console.error(err);
    res.status(200).send("ok");
  }
}
