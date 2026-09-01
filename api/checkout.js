// Zetme AI — Buyurtma berish — SAYTDAN TO'G'RIDAN-TO'G'RI (botsiz oqim)
// POST /api/checkout
// Body: {
//   priceMode: "chakana"|"optom",
//   items: [{ id, variantId, qty }, ...],
//   customer: { name, phone, region },          // saytdagi forma
//   auth?: { chatId, token }                    // mavjud mijoz hisobi (ixtiyoriy)
// }
// Nima bo'ladi:
//   1) Narx/minimal summa/bitta-do'kon qoidalari SERVERDA tekshiriladi (avvalgidek)
//   2) Mijoz hisobi: auth to'g'ri bo'lsa o'sha; bo'lmasa yangi "web" hisob yaratiladi
//      (id "w..." bilan) — javobda auth qaytadi, sayt localStorage'da saqlaydi
//   3) Bekor kompensatsiyasi vaucheri bo'lsa AVTOMATIK qo'llanadi (1 mln gacha qismiga)
//   4) Buyurtma darhol yoziladi: orders:<sellerId> va myorders:<custId>, status "yangi"
//   5) Sotuvchiga (telegramChatId) va super-adminga (OWNER_CHAT_ID) Telegram xabar boradi
// Javob: { ok, orderId, total, payTotal, voucherDiscount, voucherPercent, bonus, shopName, auth }

import { kv } from "@vercel/kv";
import { randomBytes } from "crypto";

const MIN_ORDER = 200000;       // chakana
const OPT_MIN_ORDER = 5000000;  // optom
const MAIN_SELLER_ID = "zetme";
const VOUCHER_CAP = 1000000;
// .trim() — Vercel ENV maydoniga nusxa olishda ba'zan ko'rinmas bo'shliq/newline
// qo'shilib qolishi mumkin (BOT_TOKEN'da aynan shu muammo aniqlangan edi).
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;

const BONUS_TIERS = [
  { min: 50000000, money: 3000000, tokin: 100 },
  { min: 30000000, money: 1600000, tokin: 50 },
  { min: 20000000, money: 1100000, tokin: 30 },
  { min: 15000000, money: 800000, tokin: 25 },
  { min: 10000000, money: 600000, tokin: 20 },
  { min: 5000000, money: 250000, tokin: 10 },
  { min: 1000000, money: 0, tokin: 0, gift: true },
];
function bonusFor(total) {
  for (const t of BONUS_TIERS) if (total >= t.min) return t;
  return null;
}
function fmt(n) {
  return Math.round(n).toLocaleString("uz-UZ").replace(/,/g, " ") + " so'm";
}
function genOrderId() {
  return (
    Math.random().toString(36).slice(2, 6).toUpperCase() +
    Date.now().toString(36).slice(-4).toUpperCase()
  );
}
async function tgSend(chatId, text) {
  if (!BOT_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (e) { console.error("tg:", e); }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = req.body || {};
    const items = body.items;
    const priceMode = body.priceMode === "optom" ? "optom" : "chakana";

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "Savat bo'sh" });
    }
    if (items.length > 30) {
      return res.status(400).json({ ok: false, error: "Savatda juda ko'p qator bor" });
    }

    // --- mijoz ma'lumotlari (sayt formasi) ---
    const cust = body.customer || {};
    const cName = String(cust.name || "").trim().slice(0, 60);
    const cPhone = String(cust.phone || "").trim().slice(0, 25);
    const cRegion = String(cust.region || "").trim().slice(0, 40);
    if (cName.length < 2) return res.status(400).json({ ok: false, error: "Ismingizni kiriting" });
    if (cPhone.replace(/\D/g, "").length < 7) return res.status(400).json({ ok: false, error: "Telefon raqamingizni to'g'ri kiriting" });
    if (!cRegion) return res.status(400).json({ ok: false, error: "Viloyatingizni tanlang" });

    // --- mahsulotlar va narxlar (server hisoblaydi) ---
    const products = (await kv.get("products")) || [];
    const byId = Object.fromEntries(products.map((p) => [p.id, p]));
    const UNIT_SHORT = { litr: "L", gramm: "g", olcham: "sm", dona: "dona" };

    const resolved = [];
    let orderSellerId = null;
    for (const it of items) {
      const fam = byId[it && it.id];
      if (!fam) return res.status(400).json({ ok: false, error: "Mahsulotlardan biri endi mavjud emas, savatni yangilang" });
      const variant = (fam.variants || []).find((v) => v.id === it.variantId);
      if (!variant) return res.status(400).json({ ok: false, error: "Tanlangan hajm endi mavjud emas" });

      const sellerId = fam.sellerId || MAIN_SELLER_ID;
      if (orderSellerId === null) orderSellerId = sellerId;
      if (sellerId !== orderSellerId) {
        return res.status(400).json({ ok: false, error: "Bitta buyurtmada faqat bitta do'kon mahsulotlari bo'lishi mumkin. Avval joriy buyurtmani yakunlang." });
      }

      const unitPrice = priceMode === "optom" ? Number(variant.optPrice) : Number(variant.price);
      if (!unitPrice || unitPrice <= 0) {
        return res.status(400).json({ ok: false, error: "Bu mahsulot uchun narx aniqlanmagan" });
      }
      const qty = Math.max(1, Math.min(999, Math.floor(Number(it.qty) || 1)));
      resolved.push({
        name: `${variant.name || fam.name} — ${variant.litr} ${UNIT_SHORT[fam.unit] || "L"}`,
        price: unitPrice,
        qty,
      });
    }

    // --- sotuvchi ---
    const sellers = (await kv.get("sellers")) || [];
    const seller = sellers.find((s) => s.id === orderSellerId);
    if (seller && seller.status !== "active") {
      return res.status(400).json({ ok: false, error: "Bu do'kon hozircha faol emas" });
    }
    const shopName = (seller && seller.shopName) || "Tuvaklar";
    const shopPhone = (seller && seller.phone) || "";
    const bonusEnabled = seller ? !!seller.bonusEnabled : true;
    const sellerChatId = (seller && String(seller.telegramChatId || "").trim()) || "";

    const totalQty = resolved.reduce((s, i) => s + i.qty, 0);
    const total = resolved.reduce((s, i) => s + i.price * i.qty, 0);

    const minRequired = priceMode === "optom" ? OPT_MIN_ORDER : MIN_ORDER;
    if (total < minRequired) {
      return res.status(400).json({
        ok: false,
        error: `${priceMode === "optom" ? "Optom narxda" : "Chakana"} buyurtma uchun minimal summa ${minRequired.toLocaleString("uz-UZ").replace(/,/g, " ")} so'm`,
      });
    }

    const bonus = bonusEnabled ? bonusFor(total) : null;
    let payTotal = bonus && bonus.money ? total - bonus.money : total;

    // --- mijoz hisobi: mavjudini tekshiramiz yoki yangi "web" hisob ochamiz ---
    let custId = "", custToken = "";
    const auth = body.auth || {};
    if (auth.chatId && auth.token) {
      const saved = await kv.get(`ctoken:${auth.chatId}`);
      if (saved && saved === auth.token) { custId = String(auth.chatId); custToken = String(auth.token); }
    }
    if (!custId) {
      custId = "w" + Date.now().toString(36) + randomBytes(4).toString("hex");
      custToken = randomBytes(24).toString("hex");
      await kv.set(`ctoken:${custId}`, custToken);
    }
    // profilni yangilab qo'yamiz (keyingi buyurtmada forma to'ldirilgan bo'ladi)
    const cRec = (await kv.get(`customer:${custId}`)) || {};
    cRec.name = cRec.name || cName;
    if (!cRec.firstName && !cRec.lastName) cRec.name = cName;
    cRec.phone = cPhone;
    cRec.region = cRegion;
    await kv.set(`customer:${custId}`, cRec);

    // --- bekor kompensatsiyasi vaucheri (bo'lsa avtomatik) ---
    let vDisc = 0, vPct = 0;
    try {
      const vkey = `vouchers:${custId}`;
      const vlist = (await kv.get(vkey)) || [];
      const vidx = vlist.findIndex((v) => !v.used && v.sellerId === orderSellerId);
      if (vidx !== -1) {
        vPct = Number(vlist[vidx].percent) || 5;
        vDisc = Math.round((vPct / 100) * Math.min(total, VOUCHER_CAP));
        vlist[vidx].used = true;
        vlist[vidx].usedTs = Date.now();
        await kv.set(vkey, vlist);
        payTotal = Math.max(0, payTotal - vDisc);
      }
    } catch (e) { console.error("voucher:", e); }

    // --- buyurtmani yozamiz (status: yangi) ---
    const orderId = genOrderId();
    const now = Date.now();
    const base = {
      id: orderId,
      status: "yangi",
      paymentStatus: "",       // "" -> mijoz_toladi -> tolangan
      ts: now,
      total, payTotal,
      voucherDiscount: vDisc, voucherPercent: vPct,
      priceMode, totalQty,
      bonusApplied: !!bonus,
      items: resolved,
    };

    const okey = `orders:${orderSellerId}`;
    const arr = (await kv.get(okey)) || [];
    arr.unshift({ ...base, customer: { chatId: custId, name: cName, phone: cPhone, region: cRegion } });
    if (arr.length > 500) arr.length = 500;
    await kv.set(okey, arr);

    const mkey = `myorders:${custId}`;
    const mine = (await kv.get(mkey)) || [];
    mine.unshift({ ...base, sellerId: orderSellerId, shopName, shopPhone });
    if (mine.length > 100) mine.length = 100;
    await kv.set(mkey, mine);

    // --- sotuvchiga xabar (bot endi faqat xabarchi) ---
    const lines = resolved.map((i) => `• ${i.name} — ${i.qty} dona × ${fmt(i.price)}`).join("\n");
    const orderText =
      `🛒 Yangi buyurtma — Zetme AI\n\n#${orderId} · ${shopName}\n\n${lines}\n\n` +
      `Jami: ${fmt(total)}` +
      (bonus && bonus.money ? `\nBonus: −${fmt(bonus.money)}` : "") +
      (vDisc ? `\n🎁 Chegirma bonusi (${vPct}%): −${fmt(vDisc)}` : "") +
      `\nTo'lov summasi: ${fmt(payTotal)}` +
      (bonus && bonus.gift ? `\n🎁 Sovg'a: tuvak` : "") +
      `\n\n👤 ${cName}\n📞 ${cPhone}\n📍 ${cRegion}\n\nAdmin panel > Buyurtmalar bo'limida boshqaring.`;
    if (sellerChatId && sellerChatId !== String(OWNER_CHAT_ID)) {
      await tgSend(sellerChatId, orderText);
      await tgSend(OWNER_CHAT_ID, `📋 Nazorat nusxasi\n\n${orderText}`);
    } else {
      await tgSend(OWNER_CHAT_ID, orderText);
    }

    return res.status(200).json({
      ok: true, orderId, total, payTotal,
      voucherDiscount: vDisc, voucherPercent: vPct,
      bonus, shopName,
      auth: { chatId: custId, token: custToken },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Server xatosi" });
  }
}
