// Zetme AI — Telegram buyurtma boti (Vercel serverless webhook)
// Kerakli ENV: BOT_TOKEN, OWNER_CHAT_ID, KV_REST_API_URL, KV_REST_API_TOKEN

import { kv } from "@vercel/kv";

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const REGIONS = [
  "Toshkent shahri", "Toshkent viloyati", "Andijon", "Farg'ona", "Namangan",
  "Samarqand", "Buxoro", "Navoiy", "Qashqadaryo", "Surxondaryo",
  "Jizzax", "Sirdaryo", "Xorazm", "Qoraqalpog'iston",
];

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
  if (!data.ok) console.error(`Telegram ${method} failed:`, data.description, JSON.stringify(payload));
  return data;
}
const sendMessage = (chatId, text, extra = {}) =>
  tg("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown", ...extra });
const answerCallback = (id, text) => tg("answerCallbackQuery", { callback_query_id: id, text });

function orderSummaryText(order) {
  const lines = order.items.map((i) => `• ${escapeMd(i.name)} — ${i.qty} dona × ${fmt(i.price)}`).join("\n");
  let extra = "";
  if (order.priceMode === "optom") extra += `\n🏭 Optom narxda buyurtma`;
  if (order.bonus && order.bonus.gift) extra += `\n🎁 Sovg'a: tuvak (buyurtma bilan birga beriladi)`;
  if (order.bonus && order.bonus.money > 0) {
    extra += `\n💰 Bonus: −${fmt(order.bonus.money)}${order.bonus.tokin ? ` + ${order.bonus.tokin} tokin` : ""}`;
  }
  const payLine =
    order.payTotal !== order.total
      ? `\n\n*Jami:* ${fmt(order.total)}\n*To'lov summasi (bonusdan keyin):* ${fmt(order.payTotal)}`
      : `\n\n*Jami:* ${fmt(order.total)}`;
  return `${lines}${extra}${payLine}`;
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

      if (text.startsWith("/start")) {
        const orderId = (text.split(" ")[1] || "").trim();

        if (!orderId) {
          await sendMessage(
            chatId,
            "Assalomu alaykum! 👋 Zetme AI buyurtma botiga xush kelibsiz.\n\nBuyurtma berish uchun avval saytimizdagi *Tuvaklar* bo'limidan mahsulot tanlab, savatga qo'shing."
          );
          return res.status(200).send("ok");
        }

        const order = await kv.get(`order:${orderId}`);
        if (!order) {
          await sendMessage(
            chatId,
            "Bu buyurtma muddati tugagan yoki topilmadi. Iltimos, saytga qaytib, savatdan qayta \"Buyurtma berish\"ni bosing."
          );
          return res.status(200).send("ok");
        }

        await kv.set(`draft:${chatId}`, order, { ex: 3600 });

        const profile = await kv.get(`customer:${chatId}`);
        if (profile && profile.name && profile.phone && profile.region) {
          await sendMessage(
            chatId,
            `Buyurtmangiz:\n\n${orderSummaryText(order)}\n\n👤 ${escapeMd(profile.name)}\n📞 ${escapeMd(profile.phone)}\n📍 ${escapeMd(profile.region)}`,
            { reply_markup: { inline_keyboard: [[{ text: "✅ Tasdiqlash", callback_data: "confirm" }]] } }
          );
        } else {
          await kv.set(`state:${chatId}`, "awaiting_name", { ex: 3600 });
          await sendMessage(
            chatId,
            `Buyurtmangiz:\n\n${orderSummaryText(order)}\n\nDavom etish uchun ismingizni yozing:`
          );
        }
        return res.status(200).send("ok");
      }

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
          `Buyurtmangizni tekshiring:\n\n${orderSummaryText(draft)}\n\n👤 ${escapeMd(name)}\n📞 ${escapeMd(phone)}\n📍 ${escapeMd(region)}`,
          { reply_markup: { remove_keyboard: true } }
        );
        await sendMessage(chatId, "Tasdiqlaysizmi?", {
          reply_markup: { inline_keyboard: [[{ text: "✅ Tasdiqlash", callback_data: "confirm" }]] },
        });
        return res.status(200).send("ok");
      }

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
          `🛒 *Yangi buyurtma — Zetme AI*\n\n${orderSummaryText(draft)}\n\n` +
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
    res.status(200).send("ok");
  }
}
