// Zetme AI — Mahsulotlar API
// GET  /api/products            -> barcha mahsulotlar ro'yxati (sayt shundan o'qiydi)
// POST /api/products            -> yangi mahsulot qo'shish (admin paroli talab qilinadi)
// DELETE /api/products?id=xxx   -> mahsulotni o'chirish (admin paroli talab qilinadi)

import { kv } from "@vercel/kv";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const KEY = "products";

function checkAuth(req) {
  const auth = req.headers["x-admin-password"];
  return auth && ADMIN_PASSWORD && auth === ADMIN_PASSWORD;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
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
      const { name, category, capacity, size, color, price, images } = body;
      if (!name || !category || !price) {
        return res.status(400).json({ ok: false, error: "Nomi, kategoriya va narx shart" });
      }

      const list = (await kv.get(KEY)) || [];
      const product = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: String(name),
        category: category === "gul" ? "gul" : "tuvak",
        capacity: capacity ? String(capacity) : "",
        size: size ? String(size) : "",
        color: color ? String(color) : "",
        price: Number(price),
        images: Array.isArray(images) ? images.slice(0, 3) : [],
        createdAt: Date.now(),
      };
      list.unshift(product);
      await kv.set(KEY, list);
      return res.status(200).json({ ok: true, product });
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
