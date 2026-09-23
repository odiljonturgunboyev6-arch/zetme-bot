// Zetme AI — AI operator (savol-javob) — 2026-09-23
// Mijoz saytdagi chatda gul/tuvak bo'yicha savol beradi; AI KV'dagi REAL katalog
// (nom, hajm, narx, ranglar, zaxira) + do'kon qoidalari asosida javob beradi.
// Generatsiya YO'Q — faqat matnli savol-javob.
//
// POST /api/ai-chat   { messages:[{role:"user"|"assistant", content}], lang:"uz"|"ru", uid }
//   -> { ok:true, reply, cached?:true }
// GET  /api/ai-chat   (super-admin token yoki x-admin-password)  -> { ok, rules, stats:{today, yesterday} }
// PUT  /api/ai-chat   (super-admin)  { rules }  -> qoidalarni saqlash
//
// ENV:  AI_PROVIDER = "anthropic" (default) | "gemini"
//       ANTHROPIC_API_KEY  yoki  GEMINI_API_KEY
//       AI_MODEL (ixtiyoriy) — default: claude-haiku-4-5 / gemini-3.6-flash
//
// XARAJATNI KAMAYTIRISH (1000+ foydalanuvchi bo'lsa ham tayyor):
//   1) FAQ kesh — birinchi (tarixsiz) savolga javob KV'da 6 soat saqlanadi; bir xil
//      savol qayta AI'ga bormaydi.
//   2) Kichik katalog — savoldagi so'zlarga mos mahsulotlar TO'LIQ, qolganlari faqat
//      nom+narx oralig'i bilan yuboriladi (~6000 belgi chegara).
//   3) Limit — har foydalanuvchi kuniga 20 ta, har IP 60 ta savol.
//   4) Anthropic'da system blok cache_control bilan yuboriladi (prompt caching).

import { kv } from "@vercel/kv";
import { createHash } from "crypto";
import { clientIp } from "./_lib/security.js";
import { sellerFromTokenHeaders } from "./_lib/auth.js";

export const config = { maxDuration: 30 };

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PROVIDER = (process.env.AI_PROVIDER || "anthropic").toLowerCase();
const MODEL = process.env.AI_MODEL || (PROVIDER === "gemini" ? "gemini-3.6-flash" : "claude-haiku-4-5");

const RULES_KEY = "ai:rules";
const USER_DAILY_LIMIT = 20;
const IP_DAILY_LIMIT = 60;
const FAQ_TTL = 6 * 3600;
const MAX_HISTORY = 8;          // AI'ga yuboriladigan oxirgi xabarlar soni
const MAX_MSG_CHARS = 600;
const CATALOG_CHARS = 6000;
const MAX_OUT_TOKENS = 350;

const DEFAULT_RULES = `Do'kon: Zetme — gul va plastik tuvaklar (TexnoPlast, Andijon) marketplace'i, Toshkent.
Buyurtma: saytdagi "Mahsulotlar" bo'limidan tanlab, "Savatga qo'shish" orqali beriladi. Buyurtma sotuvchiga Telegram orqali darhol boradi.
Narxlar: chakana va optom (ko'tarasiga) alohida. Aniq yetkazib berish narxi va muddati — sotuvchi buyurtmadan keyin bog'lanib aytadi.
Ranglar: har tuvak 13+ rangda bo'ladi, lekin omborda hozir qaysi rang borligi katalogda ko'rsatilgan.`;

/* ---------------- yordamchilar ---------------- */
function today() { return new Date().toISOString().slice(0, 10); }
function yesterday() { return new Date(Date.now() - 86400000).toISOString().slice(0, 10); }

function normQ(s) {
  return String(s || "").toLowerCase()
    .replace(/[ʻʼ`´’']/g, "'")
    .replace(/[^\p{L}\p{N}\s'.,]/gu, " ")
    .replace(/\s+/g, " ").trim();
}
function hash(s) { return createHash("sha256").update(s).digest("hex").slice(0, 24); }

async function incrDaily(key, ttl = 90000) {
  try {
    const n = await kv.incr(key);
    if (n === 1) await kv.expire(key, ttl);
    return n;
  } catch (e) { console.error("incrDaily:", e); return 0; }
}
async function stat(field, by = 1) {
  try { await kv.hincrby(`ai:stats:${today()}`, field, by); } catch (e) {}
}

// Super-admin: admin panel token (x-seller-login + x-seller-token, builtin do'kon)
// yoki ehtiyot uchun x-admin-password.
async function isAdmin(req) {
  const a = req.headers["x-admin-password"];
  if (a && ADMIN_PASSWORD && a === ADMIN_PASSWORD) return true;
  try { const s = await sellerFromTokenHeaders(req); return !!(s && s.builtin); } catch (e) { return false; }
}

/* ---------------- katalog (kichik, savolga mos) ---------------- */
function fmtPrice(n) { return Math.round(Number(n) || 0).toLocaleString("en-US").replace(/,/g, " "); }
const UNIT_SHORT = { litr: "L", gramm: "g", olcham: "sm", dona: "dona" };

function variantLine(v, unit) {
  const colors = Array.isArray(v.colors) ? v.colors : [];
  const stock = v.stock && typeof v.stock === "object" ? v.stock : {};
  let colorTxt = "";
  if (colors.length) {
    const parts = colors.map((c) => {
      const s = stock[c];
      if (s === undefined) return c;
      return s > 0 ? `${c} (${s} dona)` : `${c} (tugagan)`;
    });
    colorTxt = ` ranglar: ${parts.join(", ")}`;
  } else if (stock[""] !== undefined) {
    colorTxt = stock[""] > 0 ? ` (${stock[""]} dona)` : " (tugagan)";
  }
  const nm = v.name ? ` "${v.name}"` : "";
  return `  - ${v.litr} ${UNIT_SHORT[unit] || "L"}${nm}: chakana ${fmtPrice(v.price)} so'm, optom ${fmtPrice(v.optPrice)} so'm;${colorTxt}`;
}

function productFull(p) {
  const cat = p.category === "gul" ? "gul" : "tuvak";
  const sec = p.sectionName ? `, bo'lim: ${p.sectionName}` : "";
  const lines = (p.variants || []).map((v) => variantLine(v, p.unit || "litr"));
  return `• ${p.name} (${cat}${sec}, do'kon: ${p.shopName || "Zetme"})\n${lines.join("\n")}`;
}
function productShort(p) {
  const prices = (p.variants || []).map((v) => Number(v.price) || 0).filter(Boolean);
  const litrs = (p.variants || []).map((v) => v.litr).filter(Boolean).join("/");
  const pr = prices.length ? `${fmtPrice(Math.min(...prices))}–${fmtPrice(Math.max(...prices))} so'm` : "";
  return `• ${p.name}: ${litrs} ${UNIT_SHORT[p.unit] || "L"}, ${pr}`;
}

function scoreProduct(p, words) {
  const hay = normQ([p.name, p.sectionName, p.shopName,
    ...(p.variants || []).flatMap((v) => [v.litr, v.name, ...(v.colors || [])])].join(" "));
  let s = 0;
  for (const w of words) {
    if (w.length < 3) continue;
    if (hay.includes(w)) s += w.length >= 5 ? 3 : 2;
    else if (w.length >= 5 && hay.includes(w.slice(0, 4))) s += 1; // "qovurg'a"/"qovurga"
  }
  return s;
}

async function buildCatalog(question) {
  let products = [];
  let sellers = [];
  try {
    products = (await kv.get("products")) || [];
    sellers = (await kv.get("sellers")) || [];
  } catch (e) { console.error("catalog:", e); }
  const byId = Object.fromEntries(sellers.map((s) => [s.id, s]));
  const activeSellerIds = new Set(sellers.filter((s) => s.status === "active" || s.builtin).map((s) => s.id));
  activeSellerIds.add("zetme"); // asosiy do'kon doim faol
  const list = products
    .filter((p) => !p.paused)
    .map((p) => ({ ...p, sellerId: p.sellerId || "zetme" }))
    .filter((p) => activeSellerIds.has(p.sellerId))
    .map((p) => {
      const seller = byId[p.sellerId];
      const secs = seller && Array.isArray(seller.sections) ? seller.sections : [];
      const sec = secs.find((x) => x.id === p.sectionId);
      return { ...p, shopName: seller ? seller.shopName : "Zetme", sectionName: sec ? sec.name : "" };
    });

  if (!list.length) return { text: "(Katalog hozircha bo'sh)", count: 0 };

  const words = normQ(question).split(" ").filter(Boolean);
  const scored = list.map((p) => ({ p, s: scoreProduct(p, words) })).sort((a, b) => b.s - a.s);

  let out = "";
  const fullIds = new Set();
  // 1) mos kelganlar — to'liq
  for (const { p, s } of scored) {
    if (s <= 0) break;
    const t = productFull(p) + "\n";
    if (out.length + t.length > CATALOG_CHARS * 0.75) break;
    out += t; fullIds.add(p.id);
  }
  // 2) qolganlari — qisqa (nom + hajmlar + narx oralig'i), sig'guncha
  let rest = "";
  for (const { p } of scored) {
    if (fullIds.has(p.id)) continue;
    const t = productShort(p) + "\n";
    if (out.length + rest.length + t.length > CATALOG_CHARS) { rest += "• … (yana mahsulotlar bor — saytdagi Mahsulotlar bo'limida)\n"; break; }
    rest += t;
  }
  if (fullIds.size && rest) out += "\nBoshqa mahsulotlar (qisqa):\n";
  return { text: out + rest, count: list.length };
}

/* ---------------- system prompt ---------------- */
function systemPrompt(rules, catalog, lang) {
  const langLine = lang === "ru"
    ? "Mijoz rus tilida yozmoqda — javobni RUS tilida ber."
    : "Mijoz o'zbek tilida (lotin) yozmoqda — javobni O'ZBEK tilida, lotin yozuvida ber. Agar mijoz kirillda yozsa, kirillda javob ber.";
  return `Sen "Zetme AI" — gul va tuvaklar do'konining onlayn operatorisan. Mijozlarga tuvak tanlash, gul parvarishi va buyurtma tartibi bo'yicha yordam berasan.

QOIDALAR:
1. ${langLine}
2. Qisqa yoz: 2–4 gap, kerak bo'lsa 3–5 bandli ro'yxat. Salomlashishni takrorlama.
3. Mahsulot, narx, hajm, rang va zaxira haqida FAQAT quyidagi KATALOGdagi ma'lumotni ayt. Katalogda yo'q narsani O'YLAB TOPMA — "hozircha katalogda yo'q" de va yaqin muqobilni taklif qil.
4. Narxni aytganda so'mda, chakana va optom farqini ko'rsat (mijoz optom deb aytmasa — chakanani ayt, optom ham borligini eslat).
5. Gul parvarishi (sug'orish, yorug'lik, tuvak hajmi, tagida teshik, drenaj) bo'yicha umumiy bilimingdan foydalan — bu joiz.
6. Gulga tuvak tanlashda: ildiz hajmi va o'sish darajasidan kelib chiqib mos LITR ni ayt, keyin katalogdan shu litrdagi 1–3 mahsulotni nomi va narxi bilan tavsiya qil.
7. Buyurtma qabul qilma, narx o'zgartirma, chegirma va'da qilma — "Mahsulotlar bo'limidan Savatga qo'shing" deb yo'naltir. Sotuvchi bilan gaplashish kerak bo'lsa — buyurtma bergach sotuvchi Telegram orqali bog'lanishini ayt.
8. Do'kon, tuvak va gulga aloqasiz mavzularga muloyim rad javob ber va mavzuga qaytar.
9. Markdown belgilari (**, #) ishlatma — oddiy matn, kerak bo'lsa "•" bilan ro'yxat.

DO'KON QOIDALARI:
${rules}

KATALOG (hozirgi real ma'lumot):
${catalog}`;
}

/* ---------------- provayderlar ---------------- */
async function askAnthropic(system, messages) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY yo'q");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctrl.signal,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL, max_tokens: MAX_OUT_TOKENS, temperature: 0.3,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${data?.error?.message || "xato"}`);
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    const u = data.usage || {};
    return { text, inTok: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), outTok: u.output_tokens || 0 };
  } finally { clearTimeout(t); }
}

async function askGemini(system, messages) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY yo'q");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST", signal: ctrl.signal,
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        // Gemini 3.x da "thinking" sukut bo'yicha yoqilgan va chiqish byudjetini yeydi —
        // qisqa savol-javob uchun minimal darajaga tushiramiz, byudjetni kengroq qoldiramiz.
        generationConfig: { maxOutputTokens: 1024, temperature: 0.3, thinkingConfig: { thinkingLevel: "minimal" } },
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${data?.error?.message || "xato"}`);
    const text = (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
    const u = data.usageMetadata || {};
    return { text, inTok: u.promptTokenCount || 0, outTok: u.candidatesTokenCount || 0 };
  } finally { clearTimeout(t); }
}

/* ---------------- handler ---------------- */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-password, x-seller-login, x-seller-token");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // --- admin: qoidalar + statistika ---
    if (req.method === "GET" || req.method === "PUT") {
      if (!(await isAdmin(req))) return res.status(401).json({ ok: false, error: "Ruxsat yo'q" });
      if (req.method === "PUT") {
        const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
        const rules = String(body.rules || "").slice(0, 4000);
        await kv.set(RULES_KEY, rules);
        return res.status(200).json({ ok: true, rules });
      }
      const rules = (await kv.get(RULES_KEY)) ?? "";
      const [t1, t2] = await Promise.all([kv.hgetall(`ai:stats:${today()}`), kv.hgetall(`ai:stats:${yesterday()}`)]);
      return res.status(200).json({ ok: true, rules, defaultRules: DEFAULT_RULES, provider: PROVIDER, model: MODEL, stats: { today: t1 || {}, yesterday: t2 || {} } });
    }

    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const lang = body.lang === "ru" ? "ru" : "uz";
    const uid = String(body.uid || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "anon";

    // xabarlarni tozalash
    let msgs = Array.isArray(body.messages) ? body.messages : [];
    msgs = msgs
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: m.content.trim().slice(0, MAX_MSG_CHARS) }))
      .filter((m) => m.content)
      .slice(-MAX_HISTORY);
    // birinchi xabar user bo'lishi va navbat buzilmasligi kerak
    while (msgs.length && msgs[0].role !== "user") msgs.shift();
    const clean = [];
    for (const m of msgs) { if (clean.length && clean[clean.length - 1].role === m.role) clean[clean.length - 1] = m; else clean.push(m); }
    msgs = clean;
    if (!msgs.length || msgs[msgs.length - 1].role !== "user") {
      return res.status(400).json({ ok: false, error: "Savol yo'q" });
    }
    const question = msgs[msgs.length - 1].content;

    // --- limitlar ---
    const d = today();
    const nUser = await incrDaily(`ai:lim:u:${d}:${uid}`);
    const nIp = await incrDaily(`ai:lim:ip:${d}:${clientIp(req)}`);
    if (nUser > USER_DAILY_LIMIT || nIp > IP_DAILY_LIMIT) {
      await stat("limited");
      return res.status(429).json({
        ok: false, limited: true,
        error: lang === "ru"
          ? "Дневной лимит вопросов исчерпан. Оформите заказ — продавец ответит в Telegram."
          : "Bugungi savollar limiti tugadi. Buyurtma bering — sotuvchi Telegram orqali javob beradi.",
      });
    }

    // --- FAQ kesh (faqat tarixsiz, qisqa savolga) ---
    const nq = normQ(question);
    const cacheable = msgs.length === 1 && nq.length >= 3 && nq.length <= 120;
    const faqKey = cacheable ? `ai:faq:${lang}:${hash(nq)}` : null;
    if (faqKey) {
      try {
        const hit = await kv.get(faqKey);
        if (hit && typeof hit === "string") {
          await stat("req"); await stat("cached");
          return res.status(200).json({ ok: true, reply: hit, cached: true });
        }
      } catch (e) {}
    }

    // --- AI ---
    const [rules, catalog] = await Promise.all([kv.get(RULES_KEY), buildCatalog(question)]);
    const system = systemPrompt((rules && String(rules).trim()) || DEFAULT_RULES, catalog.text, lang);
    const ask = PROVIDER === "gemini" ? askGemini : askAnthropic;
    const out = await ask(system, msgs);
    const reply = (out.text || "").trim() || (lang === "ru" ? "Извините, не понял. Уточните, пожалуйста." : "Kechirasiz, tushunmadim. Aniqroq yozing.");

    await stat("req"); await stat("ai"); await stat("in_tokens", out.inTok); await stat("out_tokens", out.outTok);
    if (faqKey) { try { await kv.set(faqKey, reply, { ex: FAQ_TTL }); } catch (e) {} }

    return res.status(200).json({ ok: true, reply });
  } catch (e) {
    console.error("ai-chat:", e);
    await stat("error");
    // detail: provayder xatosining qisqa matni (kalit/sir bo'lmaydi) — admin tekshiruvi uchun
    const detail = String(e && e.message ? e.message : e).replace(/AIza[0-9A-Za-z_-]+/g, "***").slice(0, 200);
    const busy = /429|quota|RESOURCE_EXHAUSTED|rate/i.test(detail);
    return res.status(busy ? 503 : 500).json({
      ok: false, detail,
      error: busy
        ? "AI operator hozir band (limit). 1 daqiqadan keyin qayta urinib ko'ring."
        : "AI operator hozir javob bera olmadi. Birozdan keyin urinib ko'ring.",
    });
  }
}
