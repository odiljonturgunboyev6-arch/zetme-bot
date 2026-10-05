// Zetme AI — Mijozlar sotuv reytingi (liderlar taxtasi)
// POST /api/leaderboard
// Body: { period: "daily"|"weekly"|"monthly"|"quarterly"|"halfyear"|"yearly", priceMode: "chakana"|"optom" }
// Nima qiladi:
//   Barcha sotuvchilarning orders:<sellerId> ro'yxatlarini yig'ib, mijoz (customer.chatId)
//   bo'yicha guruhlaydi. Bekor qilingan buyurtmalar hisobga olinmaydi. Tanlangan davr
//   (kunlik/haftalik/...) va narx turi (chakana/optom) bo'yicha filtrlanadi.
// Javob: { ok, ranking:[{chatId,name,photo,total,orders,rank}], period, priceMode }

import { kv } from "@vercel/kv";
import { applyCors, rateLimit, RATE_MSG, clientIp } from "./_lib/security.js";

const PERIOD_DAYS = { daily: 1, weekly: 7, monthly: 30, quarterly: 90, halfyear: 182, yearly: 365 };
const TOP_CAP = 50;      // reytingda qaytariladigan mijozlar soni
const ENRICH_CAP = 30;   // ism/rasm uchun customer: yozuvini o'qiydigan yuqori qism

export default async function handler(req, res) {
  applyCors(req, res, "POST, OPTIONS", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    // bu endpoint HAMMA sotuvchilarning buyurtmalarini o'qiydi (og'ir) — IP bo'yicha chegara + 60 s kesh
    const rl = await rateLimit("lb", clientIp(req), 30, 60);
    if (!rl.ok) return res.status(429).json({ ok: false, error: RATE_MSG });

    const body = req.body || {};
    const period = PERIOD_DAYS[body.period] ? body.period : "monthly";
    const priceMode = body.priceMode === "optom" ? "optom" : "chakana";
    const cacheKey = `lb:cache:${period}:${priceMode}`;
    try {
      const hit = await kv.get(cacheKey);
      if (hit && Array.isArray(hit.ranking)) return res.status(200).json({ ok: true, ranking: hit.ranking, period, priceMode });
    } catch (e) {}
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
    // PRIVATLIK: ochiq javobda mijozning Telegram/hisob ID si QAYTARILMAYDI (faqat ism, rasm, summa)
    ranking = ranking.map((r, i) => ({ name: r.name || "Mijoz", photo: r.photo || "", total: r.total, orders: r.orders, rank: i + 1 }));
    try { await kv.set(cacheKey, { ranking }, { ex: 60 }); } catch (e) {}

    return res.status(200).json({ ok: true, ranking, period, priceMode });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Server xatosi" });
  }
}
