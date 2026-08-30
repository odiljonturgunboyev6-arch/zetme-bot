// Zetme AI — Sotuvchilar (do'konlar) API — MARKETPLACE 1-bosqich
// ---------------------------------------------------------------
// GET  /api/sellers                      -> faol do'konlar ro'yxati (sayt uchun, ochiq)
// POST /api/sellers  action bo'yicha:
//   { action:"register", shopName, ownerName, phone, login, password }
//        -> yangi sotuvchi arizasi (status: "pending" — super-admin tasdiqlaydi)
//   { action:"login", login, password }
//        -> sotuvchi kirishini tekshirish (faqat status "active" bo'lsa kiradi)
//   { action:"updateProfile", login, password, shopName?, shopLogo?, telegramChatId?, bonusEnabled?, newPassword? }
//        -> sotuvchi o'z profilini yangilaydi
//   Super-admin (x-admin-password header bilan):
//   { action:"adminList" }               -> barcha sotuvchilar (pending ham)
//   { action:"approve", id }             -> arizani tasdiqlash (status -> active)
//   { action:"block", id }               -> bloklash / { action:"unblock", id }
//   { action:"resetPassword", id, newPassword } -> sotuvchiga yangi parol berish
//   { action:"remove", id }              -> butunlay o'chirish (mahsulotlari ham o'chadi)
//
// Parollar KV'da xesh (sha256 + tuz) ko'rinishida saqlanadi — ochiq matnda emas.
// "zetme" — asosiy (siz) do'kon: birinchi so'rovda avtomatik yaratiladi,
// unga kirish uchun ADMIN_PASSWORD ishlatiladi (alohida parol shart emas).

import { kv } from "@vercel/kv";
import { createHash, randomBytes } from "crypto";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const KEY = "sellers";
const MAIN_SELLER_ID = "zetme";

function isAdmin(req) {
  const auth = req.headers["x-admin-password"];
  return auth && ADMIN_PASSWORD && auth === ADMIN_PASSWORD;
}

function hashPassword(password, salt) {
  return createHash("sha256").update(salt + ":" + String(password)).digest("hex");
}

async function loadSellers() {
  let list = (await kv.get(KEY)) || [];
  // Asosiy do'kon (siz) doim mavjud bo'lsin — eski mahsulotlar shu do'konga tegishli
  if (!list.find((s) => s.id === MAIN_SELLER_ID)) {
    list.unshift({
      id: MAIN_SELLER_ID,
      shopName: "Tuvaklar",
      ownerName: "Zetme AI",
      phone: "",
      login: MAIN_SELLER_ID,
      builtin: true,           // paroli ADMIN_PASSWORD, KV'da xesh saqlanmaydi
      status: "active",
      bonusEnabled: true,      // bonus/sovg'a tizimi faqat shu do'kon xohlasa boshqalarda ham
      telegramChatId: "",      // bo'sh bo'lsa buyurtma OWNER_CHAT_ID'ga boradi
      createdAt: 0,
    });
    await kv.set(KEY, list);
  }
  return list;
}

function publicSeller(s) {
  return {
    id: s.id,
    shopName: s.shopName,
    bonusEnabled: !!s.bonusEnabled,
    shopLogo: s.shopLogo || "", // do'kon logotipi (sotuvchi admin panelda o'zi yuklaydi)
  };
}
function adminSeller(s) {
  const { salt, passwordHash, ...rest } = s;
  return rest;
}

function verifySellerCredentials(seller, password) {
  if (!seller) return false;
  if (seller.builtin) return ADMIN_PASSWORD && password === ADMIN_PASSWORD;
  if (!seller.salt || !seller.passwordHash) return false;
  return hashPassword(password, seller.salt) === seller.passwordHash;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-password");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET") {
      const list = await loadSellers();
      const active = list.filter((s) => s.status === "active").map(publicSeller);
      return res.status(200).json({ ok: true, sellers: active });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const body = req.body || {};
    const action = String(body.action || "");
    let list = await loadSellers();

    /* ---------------- ochiq: ro'yxatdan o'tish ---------------- */
    if (action === "register") {
      const shopName = String(body.shopName || "").trim();
      const ownerName = String(body.ownerName || "").trim();
      const phone = String(body.phone || "").trim();
      const login = String(body.login || "").trim().toLowerCase();
      const password = String(body.password || "");

      if (!shopName || shopName.length < 2) return res.status(400).json({ ok: false, error: "Do'kon nomini kiriting" });
      if (!ownerName) return res.status(400).json({ ok: false, error: "Ismingizni kiriting" });
      if (!phone) return res.status(400).json({ ok: false, error: "Telefon raqamingizni kiriting" });
      if (!/^[a-z0-9_]{3,20}$/.test(login)) return res.status(400).json({ ok: false, error: "Login 3-20 ta lotin harf/raqam bo'lsin (masalan: gulmarkaz)" });
      if (password.length < 6) return res.status(400).json({ ok: false, error: "Parol kamida 6 ta belgi bo'lsin" });
      if (list.find((s) => s.login === login)) return res.status(400).json({ ok: false, error: "Bu login band — boshqasini tanlang" });
      if (list.find((s) => s.shopName.toLowerCase() === shopName.toLowerCase())) {
        return res.status(400).json({ ok: false, error: "Bu do'kon nomi band — boshqasini tanlang" });
      }
      if (list.length >= 200) return res.status(400).json({ ok: false, error: "Hozircha yangi ro'yxatdan o'tish to'xtatilgan" });

      const salt = randomBytes(8).toString("hex");
      const seller = {
        id: `s${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        shopName, ownerName, phone, login,
        salt, passwordHash: hashPassword(password, salt),
        status: "pending",
        bonusEnabled: false,
        telegramChatId: "",
        createdAt: Date.now(),
      };
      list.push(seller);
      await kv.set(KEY, list);
      return res.status(200).json({ ok: true, pending: true });
    }

    /* ---------------- sotuvchi: kirish ---------------- */
    if (action === "login") {
      const login = String(body.login || "").trim().toLowerCase();
      const seller = list.find((s) => s.login === login);
      if (!seller || !verifySellerCredentials(seller, String(body.password || ""))) {
        return res.status(401).json({ ok: false, error: "Login yoki parol noto'g'ri" });
      }
      if (seller.status === "pending") return res.status(403).json({ ok: false, error: "Arizangiz hali tasdiqlanmagan — administrator ko'rib chiqmoqda" });
      if (seller.status !== "active") return res.status(403).json({ ok: false, error: "Bu do'kon bloklangan" });
      return res.status(200).json({ ok: true, seller: adminSeller(seller), isSuper: !!seller.builtin });
    }

    /* ---------------- sotuvchi: profil yangilash ---------------- */
    if (action === "updateProfile") {
      const login = String(body.login || "").trim().toLowerCase();
      const idx = list.findIndex((s) => s.login === login);
      const seller = list[idx];
      if (!seller || !verifySellerCredentials(seller, String(body.password || ""))) {
        return res.status(401).json({ ok: false, error: "Login yoki parol noto'g'ri" });
      }
      if (seller.status !== "active") return res.status(403).json({ ok: false, error: "Do'kon faol emas" });

      const updated = { ...seller };
      if (body.telegramChatId !== undefined) updated.telegramChatId = String(body.telegramChatId).trim();
      if (body.bonusEnabled !== undefined) updated.bonusEnabled = !!body.bonusEnabled;
      if (body.phone !== undefined && String(body.phone).trim()) updated.phone = String(body.phone).trim();
      if (body.shopLogo !== undefined) updated.shopLogo = String(body.shopLogo).trim().slice(0, 600);
      if (body.shopName !== undefined) {
        const newName = String(body.shopName).trim();
        if (newName.length < 2) return res.status(400).json({ ok: false, error: "Do'kon nomi kamida 2 ta belgi bo'lsin" });
        const taken = list.some((s) => s.id !== seller.id && s.shopName.toLowerCase() === newName.toLowerCase());
        if (taken) return res.status(400).json({ ok: false, error: "Bu do'kon nomi band — boshqasini tanlang" });
        updated.shopName = newName;
      }
      if (body.newPassword) {
        if (seller.builtin) return res.status(400).json({ ok: false, error: "Asosiy do'kon paroli Vercel'dagi ADMIN_PASSWORD orqali o'zgartiriladi" });
        if (String(body.newPassword).length < 6) return res.status(400).json({ ok: false, error: "Yangi parol kamida 6 ta belgi bo'lsin" });
        updated.salt = randomBytes(8).toString("hex");
        updated.passwordHash = hashPassword(String(body.newPassword), updated.salt);
      }
      list[idx] = updated;
      await kv.set(KEY, list);
      return res.status(200).json({ ok: true, seller: adminSeller(updated) });
    }

    /* ---------------- super-admin amallari ---------------- */
    if (!isAdmin(req)) return res.status(401).json({ ok: false, error: "Noto'g'ri parol" });

    if (action === "adminList") {
      return res.status(200).json({ ok: true, sellers: list.map(adminSeller) });
    }

    const id = String(body.id || "");
    const idx = list.findIndex((s) => s.id === id);
    if (idx === -1) return res.status(404).json({ ok: false, error: "Sotuvchi topilmadi" });
    if (list[idx].builtin && (action === "block" || action === "remove" || action === "resetPassword")) {
      return res.status(400).json({ ok: false, error: "Asosiy do'kon paroli Vercel'dagi ADMIN_PASSWORD orqali boshqariladi" });
    }

    if (action === "resetPassword") {
      // super-admin sotuvchiga yangi parol o'rnatadi (parolni unutgan holatlar uchun)
      const newPassword = String(body.newPassword || "");
      if (newPassword.length < 6) {
        return res.status(400).json({ ok: false, error: "Yangi parol kamida 6 ta belgi bo'lsin" });
      }
      list[idx].salt = randomBytes(8).toString("hex");
      list[idx].passwordHash = hashPassword(newPassword, list[idx].salt);
    } else if (action === "approve") {
      list[idx].status = "active";
    } else if (action === "block") {
      list[idx].status = "blocked";
    } else if (action === "unblock") {
      list[idx].status = "active";
    } else if (action === "remove") {
      const removedId = list[idx].id;
      list.splice(idx, 1);
      // sotuvchining mahsulotlarini ham olib tashlaymiz
      const products = (await kv.get("products")) || [];
      await kv.set("products", products.filter((p) => (p.sellerId || MAIN_SELLER_ID) !== removedId));
    } else {
      return res.status(400).json({ ok: false, error: "Noma'lum amal" });
    }

    await kv.set(KEY, list);
    return res.status(200).json({ ok: true, sellers: list.map(adminSeller) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Server xatosi" });
  }
}
