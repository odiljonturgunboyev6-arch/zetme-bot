// Zetme AI — Mijozlar sotuv reytingi (liderlar taxtasi)
// POST /api/leaderboard
// Body: { period: "daily"|"weekly"|"monthly"|"quarterly"|"halfyear"|"yearly", priceMode: "chakana"|"optom" }
// Nima qiladi:
//   Barcha sotuvchilarning orders:<sellerId> ro'yxatlarini yig'ib, mijoz (customer.chatId)
//   bo'yicha guruhlaydi. Bekor qilingan buyurtmalar hisobga olinmaydi. Tanlangan davr
//   (kunlik/haftalik/...) va narx turi (chakana/optom) bo'yicha filtrlanadi.
// Javob: { ok, ranking:[{chatId,name,photo,total,orders,rank}], period, priceMode }

import { kv } from "@vercel/kv";

const PERIOD_DAYS = { daily: 1, weekly: 7, monthly: 30, quarterly: 90, halfyear: 182, yearly: 365 };
const TOP_CAP = 50;      // reytingda qaytariladigan mijozlar soni
const ENRICH_CAP = 30;   // ism/rasm uchun customer: yozuvini o'qiydigan yuqori qism

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = req.body || {};
    const period = PERIOD_DAYS[body.period] ? body.period : "monthly";
    const priceMode = body.priceMode === "optom" ? "optom" : "chakana";
    const since = Date.now() - PERIOD_DAYS[period] * 86400000;

    const sellers = (await kv.get("sellers")) || [];
    const orderLists = await Promise.all(
      sellers.map((s) => kv.get(`orders:${s.id}`).catch(() => []))
    );

    const agg = new Map(); // chatId -> { chatId, total, orders, name }
    orderLists.forEach((orders) => {
      (orders || []).forEach((o) => {
        if (!o || o.status === "bekor") return;
        if (!o.ts || o.ts < since) return;
        if ((o.priceMode || "chakana") !== priceMode) return;
        const c = o.customer || {};
        const chatId = c.chatId ? String(c.chatId) : "";
        if (!chatId) return;
        if (!agg.has(chatId)) agg.set(chatId, { chatId, total: 0, orders: 0, name: c.name || "" });
        const rec = agg.get(chatId);
        rec.total += Number(o.total) || 0;
        rec.orders += 1;
        if (!rec.name && c.name) rec.name = c.name;
      });
    });

    let ranking = Array.from(agg.values())
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, TOP_CAP);

    // ism/rasm uchun mijoz profilini o'qiymiz (faqat yuqori qism, ortiqcha KV o'qishdan qochish uchun)
    const enrichN = Math.min(ENRICH_CAP, ranking.length);
    const profiles = await Promise.all(
      ranking.slice(0, enrichN).map((r) => kv.get(`customer:${r.chatId}`).catch(() => null))
    );
    for (let i = 0; i < enrichN; i++) {
      const p = profiles[i] || {};
      const fullName = (p.firstName || p.lastName) ? `${p.firstName || ""} ${p.lastName || ""}`.trim() : "";
      ranking[i].name = fullName || p.name || ranking[i].name || "Mijoz";
      ranking[i].photo = p.photo || "";
    }
    ranking = ranking.map((r, i) => ({ ...r, rank: i + 1, name: r.name || "Mijoz" }));

    return res.status(200).json({ ok: true, ranking, period, priceMode });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Server xatosi" });
  }
}
