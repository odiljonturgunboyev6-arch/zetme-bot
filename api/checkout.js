// Zetme AI — Savatni tasdiqlash va Telegram botga uzatish — MARKETPLACE versiya
// POST /api/checkout   Body: { priceMode: "chakana"|"optom", items: [{ id, variantId, qty }, ...] }
// Javob: { ok: true, orderId, total, payTotal, bonus, shopName }
//
// MARKETPLACE qoidasi: bitta buyurtmadagi barcha mahsulotlar BITTA sotuvchiga
// tegishli bo'lishi shart (sayt buni oldindan tekshiradi, server esa majburlaydi).
// Bonus/sovg'a faqat o'sha sotuvchi bonusni yoqqan bo'lsa qo'llanadi.
// Narx, minimal buyurtma va bonus SERVERDA hisoblanadi.

import { kv } from "@vercel/kv";

const MIN_ORDER = 200000;       // chakana
const OPT_MIN_ORDER = 5000000;  // optom
const MAIN_SELLER_ID = "zetme";

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

function genOrderId() {
  return (
    Math.random().toString(36).slice(2, 6).toUpperCase() +
    Date.now().toString(36).slice(-4).toUpperCase()
  );
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

    const products = (await kv.get("products")) || [];
    const byId = Object.fromEntries(products.map((p) => [p.id, p]));

    const resolved = [];
    let orderSellerId = null;
    for (const it of items) {
      const fam = byId[it && it.id];
      if (!fam) return res.status(400).json({ ok: false, error: "Mahsulotlardan biri endi mavjud emas, savatni yangilang" });
      const variant = (fam.variants || []).find((v) => v.id === it.variantId);
      if (!variant) return res.status(400).json({ ok: false, error: "Tanlangan hajm (litr) endi mavjud emas" });

      const sellerId = fam.sellerId || MAIN_SELLER_ID;
      if (orderSellerId === null) orderSellerId = sellerId;
      if (sellerId !== orderSellerId) {
        return res.status(400).json({
          ok: false,
          error: "Bitta buyurtmada faqat bitta do'kon mahsulotlari bo'lishi mumkin. Avval joriy buyurtmani yakunlang.",
        });
      }

      const unitPrice = priceMode === "optom" ? Number(variant.optPrice) : Number(variant.price);
      if (!unitPrice || unitPrice <= 0) {
        return res.status(400).json({ ok: false, error: "Bu mahsulot uchun narx aniqlanmagan" });
      }

      const qty = Math.max(1, Math.min(999, Math.floor(Number(it.qty) || 1)));
      const UNIT_SHORT = { litr: "L", gramm: "g", olcham: "sm", dona: "dona" };
      resolved.push({
        name: `${variant.name || fam.name} — ${variant.litr} ${UNIT_SHORT[fam.unit] || "L"}`,
        price: unitPrice,
        qty,
      });
    }

    // sotuvchi ma'lumotlari (buyurtma kimga borishi + bonus yoqilganmi)
    const sellers = (await kv.get("sellers")) || [];
    const seller = sellers.find((s) => s.id === orderSellerId);
    if (seller && seller.status !== "active") {
      return res.status(400).json({ ok: false, error: "Bu do'kon hozircha faol emas" });
    }
    const shopName = (seller && seller.shopName) || "Tuvaklar";
    const bonusEnabled = seller ? !!seller.bonusEnabled : true;
    const sellerChatId = (seller && seller.telegramChatId) || "";

    const totalQty = resolved.reduce((s, i) => s + i.qty, 0);
    const total = resolved.reduce((s, i) => s + i.price * i.qty, 0);

    const minRequired = priceMode === "optom" ? OPT_MIN_ORDER : MIN_ORDER;
    if (total < minRequired) {
      return res.status(400).json({
        ok: false,
        error: `${priceMode === "optom" ? "Optom narxda" : "Chakana"} buyurtma uchun minimal summa ${minRequired
          .toLocaleString("uz-UZ")
          .replace(/,/g, " ")} so'm`,
      });
    }

    const bonus = bonusEnabled ? bonusFor(total) : null;
    const payTotal = bonus && bonus.money ? total - bonus.money : total;

    let orderId = genOrderId();
    for (let i = 0; i < 5; i++) {
      const exists = await kv.get(`order:${orderId}`);
      if (!exists) break;
      orderId = genOrderId();
    }

    const order = {
      items: resolved,
      totalQty,
      priceMode,
      total,
      bonus,
      payTotal,
      sellerId: orderSellerId,
      shopName,
      sellerChatId,
      createdAt: Date.now(),
    };

    await kv.set(`order:${orderId}`, order, { ex: 3600 });

    return res.status(200).json({ ok: true, orderId, total, payTotal, bonus, shopName });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Server xatosi" });
  }
}
