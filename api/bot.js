// Zetme AI — Telegram buyurtma boti (Vercel serverless webhook) — MARKETPLACE versiya
// Kerakli ENV: BOT_TOKEN, OWNER_CHAT_ID, KV_REST_API_URL, KV_REST_API_TOKEN
// Yangi: /myid buyrug'i (sotuvchilar Chat ID olishi uchun), buyurtma sotuvchining
// telegramiga boradi + super-adminga nazorat nusxasi.

import { kv } from "@vercel/kv";

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
// .trim() — Vercel ENV maydoniga nusxa olishda ba'zan ko'rinmas bo'shliq/newline
// qo'shilib qolishi mumkin; shu solishtirish shunga chidamli bo'lsin.
const TG_WEBHOOK_SECRET = (process.env.TG_WEBHOOK_SECRET || "").trim();
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

// order = { items:[{name,price,qty}], totalQty, priceMode, total, bonus, payTotal,
//           sellerId, shopName, sellerChatId } — marketplace: buyurtma bitta do'konga tegishli
// Bekor kompensatsiyasi vaucheri: sotuvchi buyurtmani bekor qilganda beriladi
// (api/orders.js). Keyingi buyurtma tasdiqlanganda shu yerda avtomatik qo'llanadi.
async function unusedVoucher(chatId, sellerId) {
  const list = (await kv.get(`vouchers:${chatId}`)) || [];
  const idx = list.findIndex((v) => !v.used && v.sellerId === (sellerId || "zetme"));
  return { list, idx, v: idx === -1 ? null : list[idx] };
}
const VOUCHER_CAP = 1000000; // chegirma buyurtmaning 1 mln so'mgacha qismiga qo'llanadi

function orderSummaryText(order) {
  const lines = order.items.map((i) => `• ${escapeMd(i.name)} — ${i.qty} dona × ${fmt(i.price)}`).join("\n");
  let extra = "";
  if (order.shopName) extra += `\n🏪 Do'kon: ${escapeMd(order.shopName)}`;
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

  // Bu so'rov haqiqatan Telegram'dan kelayotganini tekshiramiz — aks holda
  // istalgan odam soxta update yuborib /stat kabi buyruqlarni ishlata olardi.
  // TG_WEBHOOK_SECRET Vercel ENV'da o'rnatilgandan so'ng, webhook shu qiymat bilan
  // qayta o'rnatilishi shart (setWebhook?...&secret_token=<TG_WEBHOOK_SECRET>).
  const incomingSecret = String(req.headers["x-telegram-bot-api-secret-token"] || "").trim();
  if (TG_WEBHOOK_SECRET && incomingSecret !== TG_WEBHOOK_SECRET) {
    console.error("webhook secret mismatch", { gotLen: incomingSecret.length, wantLen: TG_WEBHOOK_SECRET.length });
    return res.status(401).send("unauthorized");
  }

  const update = req.body;

  try {
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const text = (msg.text || "").trim();

      // --- /kod: saytdagi profilni Telegram hisobiga ulash uchun 6 xonali kod ---
      // Sayt api/customer.js action:"link" bilan shu kodni chatId ga aylantiradi.
      if (text === "/kod" || text === "/code") {
        const code = String(Math.floor(100000 + Math.random() * 900000));
        await kv.set(`link:${code}`, String(chatId), { ex: 600 });
        await sendMessage(
          chatId,
          `Saytdagi profilingizni ulash kodi:\n\n\`${code}\`\n\nUni saytdagi Profil bo'limiga kiriting. Kod 10 daqiqa amal qiladi.`
        );
        return res.status(200).send("ok");
      }

      // --- /myid: sotuvchilar o'z Chat ID sini olishi uchun (admin panel profiliga yoziladi) ---
      if (text === "/myid") {
        await sendMessage(
          chatId,
          `Sizning Chat ID raqamingiz:\n\`${chatId}\`\n\nAgar siz sotuvchi bo'lsangiz, shu raqamni admin paneldagi profilingizga yozing — buyurtmalar shu yerga keladi.`
        );
        return res.status(200).send("ok");
      }

      // --- /stat: FAQAT egasi (OWNER_CHAT_ID) uchun umumiy statistika ---
      if (text === "/stat" && String(chatId) === String(OWNER_CHAT_ID)) {
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
        await sendMessage(
          chatId,
          `📊 *Zetme AI statistikasi*\n\nJami: ${tOrders} ta buyurtma · ${fmt(tSum)}\nOxirgi 7 kun: ${w7} ta · ${fmt(s7)}\n\n${lines.join("\n") || "Hali buyurtma yo'q"}`
        );
        return res.status(200).send("ok");
      }

      // --- /start with an order id coming from the site (see api/checkout.js) ---
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

        // orderId ni ham saqlaymiz — tasdiqlangach buyurtma tarixida id bo'ladi (status boshqaruvi uchun)
        await kv.set(`draft:${chatId}`, { ...order, orderId }, { ex: 3600 });

        const profile = await kv.get(`customer:${chatId}`);
        // bekor kompensatsiyasi bo'lsa oldindan aytamiz
        let vNote = "";
        try {
          const { v } = await unusedVoucher(chatId, order.sellerId);
          if (v) vNote = `\n\n🎁 Sizda ${v.percent}% chegirma bonusingiz bor — tasdiqlasangiz avtomatik qo'llanadi (buyurtmaning 1 mln so'mgacha qismiga).`;
        } catch (e) {}
        if (profile && profile.name && profile.phone && profile.region) {
          await sendMessage(
            chatId,
            `Buyurtmangiz:\n\n${orderSummaryText(order)}${vNote}\n\n👤 ${escapeMd(profile.name)}\n📞 ${escapeMd(profile.phone)}\n📍 ${escapeMd(profile.region)}`,
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

        // Bekor kompensatsiyasi vaucherini qo'llash (bo'lsa) — 1 mln gacha qismiga
        let vDisc = 0, vPct = 0;
        try {
          const { list: vlist, idx: vidx } = await unusedVoucher(chatId, draft.sellerId);
          if (vidx !== -1) {
            vPct = Number(vlist[vidx].percent) || 5;
            vDisc = Math.round((vPct / 100) * Math.min(Number(draft.total) || 0, VOUCHER_CAP));
            vlist[vidx].used = true;
            vlist[vidx].usedTs = Date.now();
            vlist[vidx].usedOrderId = draft.orderId || "";
            await kv.set(`vouchers:${chatId}`, vlist);
          }
        } catch (e) { console.error("voucher:", e); }
        const finalPay = Math.max(0, (Number(draft.payTotal) || Number(draft.total) || 0) - vDisc);
        const vLine = vDisc > 0 ? `\n🎁 *Chegirma bonusi (${vPct}%):* −${fmt(vDisc)}\n*Yakuniy to'lov:* ${fmt(finalPay)}` : "";

        await sendMessage(
          chatId,
          `✅ Buyurtmangiz qabul qilindi!${vDisc > 0 ? `\n\n🎁 ${vPct}% chegirma bonusingiz qo'llandi: −${fmt(vDisc)}\nYakuniy to'lov: ${fmt(finalPay)}` : ""}\n\n5 daqiqa ichida operatorimiz siz bilan bog'lanadi. Rahmat!`
        );

        const uname = from.username ? `@${escapeMd(from.username)}` : "(username yo'q)";
        const orderText =
          `🛒 *Yangi buyurtma — Zetme AI*\n\n${orderSummaryText(draft)}${vLine}\n\n` +
          `👤 *Ism:* ${escapeMd(profile.name)}\n📞 *Telefon:* ${escapeMd(profile.phone)}\n📍 *Viloyat:* ${escapeMd(profile.region)}\n💬 *Telegram:* ${uname}`;

        // MARKETPLACE: buyurtma o'sha do'kon egasining Telegramiga boradi,
        // super-adminga (OWNER_CHAT_ID) esa doim nazorat nusxasi yuboriladi.
        const sellerChat = String(draft.sellerChatId || "").trim();
        if (sellerChat && sellerChat !== String(OWNER_CHAT_ID)) {
          await sendMessage(sellerChat, orderText);
          await sendMessage(OWNER_CHAT_ID, `📋 *Nazorat nusxasi*\n\n${orderText}`);
        } else {
          await sendMessage(OWNER_CHAT_ID, orderText);
        }

        // ANALITIKA: buyurtmani sotuvchining doimiy tarixiga yozamiz (oxirgi 500 ta)
        try {
          const okey = `orders:${draft.sellerId || "zetme"}`;
          const arr = (await kv.get(okey)) || [];
          arr.unshift({
            id: draft.orderId || `x${Date.now().toString(36)}`,
            status: "yangi",          // yangi -> tayyorlanmoqda -> yetkazildi / bekor
            ts: Date.now(),
            total: draft.total || 0,
            payTotal: finalPay,
            voucherDiscount: vDisc, voucherPercent: vPct,
            priceMode: draft.priceMode || "chakana",
            totalQty: draft.totalQty || 0,
            bonusApplied: !!draft.bonus,
            items: (draft.items || []).map((i) => ({ name: i.name, price: i.price, qty: i.qty })),
            customer: {
              chatId: String(chatId),
              name: profile.name || "",
              phone: profile.phone || "",
              region: profile.region || "",
              username: from.username || "",
            },
          });
          if (arr.length > 500) arr.length = 500;
          await kv.set(okey, arr);

          // mijozning o'z tarixi (saytdagi profil sahifasi uchun)
          const mkey = `myorders:${chatId}`;
          const mine = (await kv.get(mkey)) || [];
          mine.unshift({
            id: arr[0].id,
            status: "yangi",
            ts: Date.now(),
            sellerId: draft.sellerId || "zetme",
            total: draft.total || 0,
            payTotal: finalPay,
            voucherDiscount: vDisc, voucherPercent: vPct,
            shopName: draft.shopName || "",
            totalQty: draft.totalQty || 0,
            items: (draft.items || []).map((i) => ({ name: i.name, price: i.price, qty: i.qty })),
          });
          if (mine.length > 100) mine.length = 100;
          await kv.set(mkey, mine);
        } catch (e) { console.error("order log:", e); }

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
