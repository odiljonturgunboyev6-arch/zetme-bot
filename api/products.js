// Zetme AI — Mahsulotlar API
// GET/POST/PUT/DELETE /api/products — sayt va admin panel shu yerdan ishlaydi

import { kv } from "@vercel/kv";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const KEY = "products";

function checkAuth(req) {
  const auth = req.headers["x-admin-password"];
  return auth && ADMIN_PASSWORD && auth === ADMIN_PASSWORD;
}

function validateVariants(variants) {
  if (!Array.isArray(variants) || variants.length < 1 || variants.length > 10) {
    return "Kamida 1 ta, ko'pi bilan 10 ta hajm (litr) varianti kerak";
  }
  for (const v of variants) {
    if (!v.litr || String(v.litr).trim() === "") {
      return "Har bir variant uchun litr (hajm) ko'rsatilishi shart";
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

function normalizeVariants(variants) {
  return variants.map((v, i) => {
    // rasm ikki formatda kelishi mumkin: `image` (bitta URL, yangi admin) yoki
    // `images` (massiv, eski ma'lumotlar) — ikkalasini ham saqlab qo'yamiz
    const images = Array.isArray(v.images) && v.images.length > 0
      ? v.images.map((u) => String(u))
      : (v.image ? [String(v.image)] : []);
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-password");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET") {
      const list = (await kv.get(KEY)) || [];
      return res.status(200).json({ ok: true, products: list });
    }

    if (req.method === "POST") {
      if (!checkAuth(req)) return res.status(401).json({ ok: false, error: "Noto'g'ri parol" });

      const body = req.body || {};
      const { name, category, color, variants } = body;
      if (!name || !category) {
        return res.status(400).json({ ok: false, error: "Nomi va kategoriya shart" });
      }
      const vErr = validateVariants(variants);
      if (vErr) return res.status(400).json({ ok: false, error: vErr });

      const list = (await kv.get(KEY)) || [];
      const product = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: String(name),
        category: category === "gul" ? "gul" : "tuvak",
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
      if (!checkAuth(req)) return res.status(401).json({ ok: false, error: "Noto'g'ri parol" });

      const body = req.body || {};
      const { id, name, category, color, variants } = body;
      if (!id) return res.status(400).json({ ok: false, error: "Mahsulot ID si yo'q" });
      if (!name || !category) {
        return res.status(400).json({ ok: false, error: "Nomi va kategoriya shart" });
      }
      const vErr = validateVariants(variants);
      if (vErr) return res.status(400).json({ ok: false, error: vErr });

      const list = (await kv.get(KEY)) || [];
      const idx = list.findIndex((p) => p.id === id);
      if (idx === -1) return res.status(404).json({ ok: false, error: "Mahsulot topilmadi" });

      const updated = {
        ...list[idx],
        name: String(name),
        category: category === "gul" ? "gul" : "tuvak",
        color: color ? String(color) : "",
        variants: normalizeVariants(variants),
        updatedAt: Date.now(),
      };
      list[idx] = updated;
      await kv.set(KEY, list);
      return res.status(200).json({ ok: true, product: updated });
    }

    if (req.method === "DELETE") {
      if (!checkAuth(req)) return res.status(401).json({ ok: false, error: "Noto'g'ri parol" });
      const id = req.query.id;
      const list = (await kv.get(KEY)) || [];
      const next = list.filter((p) => p.id !== id);
      await kv.set(KEY, next);
      return res.status(200).json({ ok: true });
    }

    res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Server xatosi" });
  }
}
