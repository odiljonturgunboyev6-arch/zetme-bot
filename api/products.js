// Zetme AI — Mahsulotlar API — MARKETPLACE versiya (sellerId bilan)
// GET    /api/products        -> faol do'konlarning mahsulotlari (har birida sellerId + shopName)
// POST   /api/products        -> yangi mahsulot qo'shish
// PUT    /api/products        -> mahsulotni tahrirlash
// DELETE /api/products?id=xxx -> mahsulotni o'chirish
//
// KIRISH HUQUQI (POST/PUT/DELETE):
//   - Super-admin: "x-admin-password" header (ADMIN_PASSWORD) -> istalgan mahsulot
//   - Sotuvchi:    "x-seller-login" + "x-seller-password" headerlar -> FAQAT o'z mahsulotlari
// Eski (sellerId'siz) mahsulotlar avtomatik "zetme" (asosiy do'kon)ga tegishli hisoblanadi.

import { kv } from "@vercel/kv";
import { createHash } from "crypto";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const KEY = "products";
const MAIN_SELLER_ID = "zetme";

function isAdmin(req) {
  const auth = req.headers["x-admin-password"];
  return auth && ADMIN_PASSWORD && auth === ADMIN_PASSWORD;
}

function hashPassword(password, salt) {
  return createHash("sha256").update(salt + ":" + String(password)).digest("hex");
}

// Sotuvchini headerlar orqali aniqlaydi. Muvaffaqiyatda seller obyektini,
// aks holda null qaytaradi. Super-admin bo'lsa {id:"*"} qaytadi.
async function resolveActor(req) {
  if (isAdmin(req)) return { id: "*", super: true };
  const login = String(req.headers["x-seller-login"] || "").trim().toLowerCase();
  const password = String(req.headers["x-seller-password"] || "");
  if (!login || !password) return null;
  const sellers = (await kv.get("sellers")) || [];
  const seller = sellers.find((s) => s.login === login);
  if (!seller || seller.status !== "active") return null;
  if (seller.builtin) {
    return ADMIN_PASSWORD && password === ADMIN_PASSWORD ? seller : null;
  }
  if (!seller.salt || !seller.passwordHash) return null;
  return hashPassword(password, seller.salt) === seller.passwordHash ? seller : null;
}

// Mahsulot o'lchov birligi — sotuvchi tanlaydi. Variantdagi qiymat (v.litr)
// shu birlikda o'qiladi: 0,5 L / 500 g / 22 sm / 3 dona.
const UNITS = ["litr", "gramm", "olcham", "dona"];
const UNIT_WORD = { litr: "hajm (litr)", gramm: "og'irlik (gramm)", olcham: "o'lcham", dona: "miqdor (dona)" };
function normUnit(u) {
  return UNITS.includes(String(u)) ? String(u) : "litr";
}

function validateVariants(variants, unit) {
  const word = UNIT_WORD[normUnit(unit)];
  if (!Array.isArray(variants) || variants.length < 1 || variants.length > 10) {
    return `Kamida 1 ta, ko'pi bilan 10 ta ${word} varianti kerak`;
  }
  for (const v of variants) {
    if (!v.litr || String(v.litr).trim() === "") {
      return `Har bir variant uchun ${word} ko'rsatilishi shart`;
    }
    if (!v.price || Number(v.price) <= 0) {
      return "Har bir variant uchun chakana narx ko'rsatilishi shart";
    }
    if (!v.optPrice || Number(v.optPrice) <= 0) {
      return "Har bir variant uchun optom narx ko'rsatilishi shart";
    }
    const hasImage = v.image || (Array.isArray(v.images) && v.images.length > 0);
    if (!hasImage) {
      return "Har bir variant uchun rasm yuklanishi shart";
    }
  }
  return null;
}

// Mahsulot faqat o'z do'konining bo'limiga biriktirilishi mumkin.
// Noma'lum yoki bo'sh bo'lsa "" qaytadi ("Boshqalar" bo'limida ko'rinadi).
async function resolveSection(sellerId, sectionId) {
  const sid = String(sectionId || "").trim();
  if (!sid) return "";
  const sellers = (await kv.get("sellers")) || [];
  const seller = sellers.find((s) => s.id === sellerId);
  const secs = (seller && Array.isArray(seller.sections)) ? seller.sections : [];
  return secs.some((x) => x.id === sid) ? sid : "";
}

function normalizeVariants(variants) {
  return variants.map((v, i) => {
    // har variantda ko'pi bilan 3 ta rasm
    const images = (Array.isArray(v.images) && v.images.length > 0
      ? v.images.map((u) => String(u))
      : (v.image ? [String(v.image)] : [])).filter(Boolean).slice(0, 3);
    return {
      id: v.id || `v${Date.now()}${i}${Math.random().toString(36).slice(2, 5)}`,
      litr: String(v.litr).trim(),
      price: Number(v.price),
      optPrice: Number(v.optPrice),
      size: v.size ? String(v.size).trim() : "",
      image: v.image ? String(v.image) : (images[0] || ""),
      images,
      name: v.name ? String(v.name).trim() : "",
      color: v.color ? String(v.color).trim() : "",
    };
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-password, x-seller-login, x-seller-password");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET") {
      const list = (await kv.get(KEY)) || [];
      const sellers = (await kv.get("sellers")) || [];
      const byId = Object.fromEntries(sellers.map((s) => [s.id, s]));
      const out = list
        .map((p) => ({ ...p, sellerId: p.sellerId || MAIN_SELLER_ID }))
        .filter((p) => {
          const s = byId[p.sellerId];
          // sellers ro'yxati hali yaratilmagan bo'lsa (birinchi ishga tushirish) — asosiy do'kon mahsulotlari ko'rinadi
          if (!s) return p.sellerId === MAIN_SELLER_ID;
          return s.status === "active";
        })
        .map((p) => {
          const s = byId[p.sellerId];
          const secs = (s && Array.isArray(s.sections)) ? s.sections : [];
          const sec = secs.find((x) => x.id === p.sectionId);
          return {
            ...p,
            unit: p.unit || "litr",
            sectionId: sec ? sec.id : "",
            sectionName: sec ? sec.name : "",
            shopName: (s && s.shopName) || "Tuvaklar",
            bonusEnabled: s ? !!s.bonusEnabled : true,
          };
        });
      return res.status(200).json({ ok: true, products: out });
    }

    if (req.method === "POST") {
      const actor = await resolveActor(req);
      if (!actor) return res.status(401).json({ ok: false, error: "Noto'g'ri parol" });

      const body = req.body || {};
      const { name, category, color, variants } = body;
      if (!name || !category) {
        return res.status(400).json({ ok: false, error: "Nomi va kategoriya shart" });
      }
      const unit = normUnit(body.unit);
      const vErr = validateVariants(variants, unit);
      if (vErr) return res.status(400).json({ ok: false, error: vErr });

      // sotuvchi faqat o'z nomidan qo'shadi; super-admin xohlagan sellerId bilan
      const sellerId = actor.super
        ? (String(body.sellerId || MAIN_SELLER_ID))
        : actor.id;

      const list = (await kv.get(KEY)) || [];
      const product = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sellerId,
        name: String(name),
        category: category === "gul" ? "gul" : "tuvak",
        unit,
        sectionId: await resolveSection(sellerId, body.sectionId),
        color: color ? String(color) : "",
        variants: normalizeVariants(variants),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      list.unshift(product);
      await kv.set(KEY, list);
      return res.status(200).json({ ok: true, product });
    }

    if (req.method === "PUT") {
      const actor = await resolveActor(req);
      if (!actor) return res.status(401).json({ ok: false, error: "Noto'g'ri parol" });

      const body = req.body || {};
      const { id, name, category, color, variants } = body;
      if (!id) return res.status(400).json({ ok: false, error: "Mahsulot ID si yo'q" });
      if (!name || !category) {
        return res.status(400).json({ ok: false, error: "Nomi va kategoriya shart" });
      }
      const unit = normUnit(body.unit);
      const vErr = validateVariants(variants, unit);
      if (vErr) return res.status(400).json({ ok: false, error: vErr });

      const list = (await kv.get(KEY)) || [];
      const idx = list.findIndex((p) => p.id === id);
      if (idx === -1) return res.status(404).json({ ok: false, error: "Mahsulot topilmadi" });

      const ownerId = list[idx].sellerId || MAIN_SELLER_ID;
      if (!actor.super && ownerId !== actor.id) {
        return res.status(403).json({ ok: false, error: "Bu mahsulot sizning do'koningizga tegishli emas" });
      }

      const updated = {
        ...list[idx],
        sellerId: ownerId,
        name: String(name),
        category: category === "gul" ? "gul" : "tuvak",
        unit,
        sectionId: await resolveSection(ownerId, body.sectionId),
        color: color ? String(color) : "",
        variants: normalizeVariants(variants),
        updatedAt: Date.now(),
      };
      list[idx] = updated;
      await kv.set(KEY, list);
      return res.status(200).json({ ok: true, product: updated });
    }

    if (req.method === "DELETE") {
      const actor = await resolveActor(req);
      if (!actor) return res.status(401).json({ ok: false, error: "Noto'g'ri parol" });
      const id = req.query.id;
      const list = (await kv.get(KEY)) || [];
      const target = list.find((p) => p.id === id);
      if (target) {
        const ownerId = target.sellerId || MAIN_SELLER_ID;
        if (!actor.super && ownerId !== actor.id) {
          return res.status(403).json({ ok: false, error: "Bu mahsulot sizning do'koningizga tegishli emas" });
        }
      }
      await kv.set(KEY, list.filter((p) => p.id !== id));
      return res.status(200).json({ ok: true });
    }

    res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Server xatosi" });
  }
}
