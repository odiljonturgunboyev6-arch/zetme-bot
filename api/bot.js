// Zetme AI — Telegram buyurtma boti (Vercel serverless webhook)
// ---------------------------------------------------------------
// Kerakli ENV o'zgaruvchilar (Vercel > Project > Settings > Environment Variables):
//   BOT_TOKEN        - BotFather bergan token
//   OWNER_CHAT_ID    - buyurtmalar keladigan Chat ID (siz: 5262377062)
//   KV_REST_API_URL, KV_REST_API_TOKEN - Vercel KV ulanganda avtomatik qo'shiladi
//
// Vercel KV (Storage > Create Database > KV) loyihaga ulanishi shart —
// mijoz profili va suhbat holati shu yerda saqlanadi.

import { kv } from "@vercel/kv";

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const MIN_ORDER = 200000;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Sayt bilan bir xil mahsulot ro'yxati (kodlar bo'yicha moslashtiriladi).
// Kod solishtirishda harf/raqamdan boshqa belgilar olib tashlanadi (01-D -> 01D).
const PRODUCTS = [
  { code: "01D", name: "Branch Tuvak - 4", price: 78000 },
  { code: "02C", name: "Lif Tuvak - 3", price: 62000 },
  { code: "05C", name: "Rombik Tuvak - 3", price: 54000 },
  { code: "22C", name: "Globus Palasa - 3", price: 89000 },
  { code: "23D", name: "Piramida - 4", price: 96000 },
  { code: "06D", name: "Savat - 3", price: 71000 },
  { code: "10B", name: "Osma Lola - 2", price: 38000 },
  { code: "20B", name: "Silinder katta", price: 145000 },
];
const byCode = Object.fromEntries(PRODUCTS.map((p) => [p.code, p]));

const REGIONS = [
  "Toshkent shahri", "Toshkent viloyati", "Andijon", "Farg'ona", "Namangan",
  "Samarqand", "Buxoro", "Navoiy", "Qashqadaryo", "Surxondaryo",
  "Jizzax", "Sirdaryo", "Xorazm", "Qoraqalpog'iston",
];

function fmt(n) {
  return Math.round(n).toLocaleString("uz-UZ").replace(/,/g, " ") + " so'm";
}
// Legacy Telegram Markdown treats _ * ` [ as special — escape them in any
// user-supplied text (names, usernames, regions) so messages never fail to send.
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
  if (!data.ok) console.error(`Telegram ${method} failed:`, data.description, JSON.stringify(payload));
  return data;
}
const sendMessage = (chatId, text, extra = {}) =>
  tg("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown", ...extra });
const answerCallback = (id, text) => tg("answerCallbackQuery", { callback_query_id: id, text });

function parseOrderCode(payload) {
  if (!payload) return [];
  return payload
    .split("_")
    .map((seg) => {
      const m = seg.match(/^([A-Za-z0-9]+)x(\d+)$/);
      if (!m) return null;
      const [, code, qtyStr] = m;
      const product = byCode[code];
      if (!product) return null;
      return { ...product, qty: parseInt(qtyStr, 10) };
    })
    .filter(Boolean);
}

function orderSummaryText(items, total) {
  const lines = items.map((i) => `• ${escapeMd(i.name)} — ${i.qty} dona × ${fmt(i.price)}`).join("\n");
  return `${lines}\n\n*Jami:* ${fmt(total)}`;
}

function regionKeyboard() {
  const rows = [];
  for (let i = 0; i < REGIONS.length; i += 2) rows.push(REGIONS.slice(i, i + 2).map((r) => ({ text: r })));
  return { keyboard: rows, resize_keyboard: true, one_time_keyboard: true };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("Zetme AI bot webhook is alive.");
  const update = req.body;

  try {
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const text = (msg.text || "").trim();
      const from = msg.from || {};

      // --- /start with an order code coming from the site ---
      if (text.startsWith("/start")) {
        const payload = text.split(" ")[1] || "";
        const items = parseOrderCode(payload);

        if (items.length === 0) {
          await sendMessage(
            chatId,
            "Assalomu alaykum! 👋 Zetme AI buyurtma botiga xush kelibsiz.\n\nBuyurtma berish uchun avval saytimizdagi *Tuvaklar* bo'limidan mahsulot tanlab, savatga qo'shing."
          );
          return res.status(200).send("ok");
        }

        const total = items.reduce((s, i) => s + i.price * i.qty, 0);
        if (total < MIN_ORDER) {
          await sendMessage(
            chatId,
            `Minimal buyurtma summasi — *${fmt(MIN_ORDER)}*.\nSizning buyurtmangiz: ${fmt(total)}.\n\nSaytga qaytib, yana mahsulot qo'shing.`
          );
          return res.status(200).send("ok");
        }

        await kv.set(`draft:${chatId}`, { items, total }, { ex: 3600 });

        const profile = await kv.get(`customer:${chatId}`);
        if (profile && profile.name && profile.phone && profile.region) {
          // returning customer — skip straight to confirmation
          await sendMessage(
            chatId,
            `Buyurtmangiz:\n\n${orderSummaryText(items, total)}\n\n👤 ${escapeMd(profile.name)}\n📞 ${escapeMd(profile.phone)}\n📍 ${escapeMd(profile.region)}`,
            { reply_markup: { inline_keyboard: [[{ text: "✅ Tasdiqlash", callback_data: "confirm" }]] } }
          );
        } else {
          await kv.set(`state:${chatId}`, "awaiting_name", { ex: 3600 });
          await sendMessage(
            chatId,
            `Buyurtmangiz:\n\n${orderSummaryText(items, total)}\n\nDavom etish uchun ismingizni yozing:`
          );
        }
        return res.status(200).send("ok");
      }

      // --- conversation state machine ---
      const state = await kv.get(`state:${chatId}`);

      if (state === "awaiting_name") {
        await kv.set(`draft_name:${chatId}`, text, { ex: 3600 });
        await kv.set(`state:${chatId}`, "awaiting_phone", { ex: 3600 });
        await sendMessage(chatId, "Telefon raqamingizni yozing (masalan +998 90 123 45 67):");
        return res.status(200).send("ok");
      }

      if (state === "awaiting_phone") {
        await kv.set(`draft_phone:${chatId}`, text, { ex: 3600 });
        await kv.set(`state:${chatId}`, "awaiting_region", { ex: 3600 });
        await sendMessage(chatId, "Qaysi viloyatdasiz?", { reply_markup: regionKeyboard() });
        return res.status(200).send("ok");
      }

      if (state === "awaiting_region") {
        const name = await kv.get(`draft_name:${chatId}`);
        const phone = await kv.get(`draft_phone:${chatId}`);
        const region = text;
        const profile = { name, phone, region };
        await kv.set(`customer:${chatId}`, profile);
        await kv.set(`state:${chatId}`, "confirming", { ex: 3600 });

        const draft = await kv.get(`draft:${chatId}`);
        await sendMessage(
          chatId,
          `Buyurtmangizni tekshiring:\n\n${orderSummaryText(draft.items, draft.total)}\n\n👤 ${escapeMd(name)}\n📞 ${escapeMd(phone)}\n📍 ${escapeMd(region)}`,
          {
            reply_markup: {
              remove_keyboard: true,
            },
          }
        );
        await sendMessage(chatId, "Tasdiqlaysizmi?", {
          reply_markup: { inline_keyboard: [[{ text: "✅ Tasdiqlash", callback_data: "confirm" }]] },
        });
        return res.status(200).send("ok");
      }

      // fallback
      await sendMessage(chatId, "Buyurtma berish uchun saytimizdan mahsulot tanlab, botga qayting.");
      return res.status(200).send("ok");
    }

    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message.chat.id;
      const from = cq.from || {};

      if (cq.data === "confirm") {
        const draft = await kv.get(`draft:${chatId}`);
        const profile = await kv.get(`customer:${chatId}`);
        if (!draft || !profile) {
          await answerCallback(cq.id, "Buyurtma topilmadi, qaytadan urinib ko'ring.");
          return res.status(200).send("ok");
        }

        await answerCallback(cq.id, "Qabul qilindi!");
        await sendMessage(
          chatId,
          "✅ Buyurtmangiz qabul qilindi!\n\n5 daqiqa ichida operatorimiz siz bilan bog'lanadi. Rahmat!"
        );

        const uname = from.username ? `@${escapeMd(from.username)}` : "(username yo'q)";
        await sendMessage(
          OWNER_CHAT_ID,
          `🛒 *Yangi buyurtma — Zetme AI*\n\n${orderSummaryText(draft.items, draft.total)}\n\n` +
            `👤 *Ism:* ${escapeMd(profile.name)}\n📞 *Telefon:* ${escapeMd(profile.phone)}\n📍 *Viloyat:* ${escapeMd(profile.region)}\n💬 *Telegram:* ${uname}`
        );

        await kv.del(`draft:${chatId}`);
        await kv.del(`state:${chatId}`);
        await kv.del(`draft_name:${chatId}`);
        await kv.del(`draft_phone:${chatId}`);
      }
      return res.status(200).send("ok");
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error(err);
    res.status(200).send("ok"); // always 200 so Telegram doesn't retry-storm
  }
}
