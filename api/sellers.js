// Zetme AI — Sotuvchilar (do'konlar) API — MARKETPLACE 1-bosqich
// ---------------------------------------------------------------
// GET  /api/sellers                      -> faol do'konlar ro'yxati (sayt uchun, ochiq)
// POST /api/sellers  action bo'yicha:
//   { action:"register", shopName, ownerName, phone, login, password }
//        -> yangi sotuvchi arizasi (status: "pending" — super-admin tasdiqlaydi)
//   { action:"login", login, password }
//        -> sotuvchi kirishini tekshirish (faqat status "active" bo'lsa kiradi)
//   { action:"updateProfile", login, password, shopName?, shopLogo?, sections?, categoryIds?, telegramChatId?, bonusEnabled?, newPassword? }
//        sections: [{id?,name}] — do'kon bo'limlari, 5 tagacha (Gullar, Toshlar, ...)
//        categoryIds: ["c1",...] — do'kon MARKETPLACE bo'limlari (Tuvaklar / Sun'iy gullar / ...)
//        -> sotuvchi o'z profilini yangilaydi
//   Super-admin (x-admin-password header bilan):
//   { action:"adminList" }               -> barcha sotuvchilar (pending ham) + categories
//   { action:"catSave", categories:[{id?,name,nameRu?,emoji?}] }
//        -> marketplace bo'limlari ro'yxatini butunlay almashtiradi (12 tagacha).
//           O'chirilgan bo'lim id'lari sotuvchilardan ham olib tashlanadi.
//   { action:"setSellerCategories", id, categoryIds } -> sotuvchiga bo'lim biriktirish
//
// MARKETPLACE BO'LIMLARI (2026-09-10): "categories" KV kaliti — super-admin yaratadi
// (masalan Tuvaklar, Sun'iy gullar, Jonli gullar). Har do'kon bir yoki bir nechta
// bo'limga tegishli bo'ladi; saytda mijoz bo'limni bossa faqat shu bo'limdagi
// do'konlar ko'rinadi. Do'konning ICHKI "sections" (Gullar/Toshlar...) bilan
// adashtirmang — u do'kon ichidagi mahsulot guruhlari.
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
import { getThumbMap } from "./_lib/thumbs.js";
import {
  isBlocked, recordFailure, clearFailures, TOO_MANY_MSG,
  safeEqual, applyCors, rateLimit, RATE_MSG, makePasswordRecord, checkPassword, passwordProblem,
  isBlockedKey, recordFailureKey, clearFailuresKey, withLock,
} from "./_lib/security.js";
import { issueToken, revokeToken, sellerFromToken, sellerFromTokenHeaders } from "./_lib/auth.js";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const KEY = "sellers";
const CAT_KEY = "categories";
const MAIN_SELLER_ID = "zetme";
const AUTH_SCOPE = "auth";
const AUTH_LIMIT = 8;
const AUTH_WINDOW = 900;

// super-admin: faqat builtin (zetme) sotuvchining sessiya tokeni.
// 2026-10-05: eski "x-admin-password" headeri olib tashlandi.
async function isAdmin(req, list) {
  const s = await sellerFromTokenHeaders(req, list);
  return !!(s && s.builtin);
}
// Telegram chat ID — faqat raqam (manfiy ham bo'lishi mumkin: guruhlar)
function cleanChatId(v) {
  const t = String(v == null ? "" : v).trim();
  return /^-?\d{5,16}$/.test(t) ? t : "";
}
// Rasm manzili — faqat https
function cleanUrl(v) {
  const t = String(v == null ? "" : v).trim().slice(0, 600);
  return /^https:\/\/[^\s"'<>]+$/i.test(t) ? t : "";
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
    region: s.region || "", // 2026-09-27: do'kon joylashuvi (viloyat) — mijozga 📍 bilan ko'rinadi
    sections: normalizeSections(s.sections), // do'kon bo'limlari (5 tagacha): [{id,name}]
    categoryIds: Array.isArray(s.categoryIds) ? s.categoryIds : [], // marketplace bo'limlari
  };
}

// ---------- Marketplace bo'limlari (super-admin boshqaradi) ----------
// Ko'pi bilan 12 ta. name (uz) 1-24 belgi, nameRu ixtiyoriy (24), emoji 4 belgigacha.
const MAX_CATEGORIES = 12;
function normalizeCategories(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const c of arr) {
    const name = String((c && c.name) || "").trim().slice(0, 24);
    if (!name) continue;
    if (out.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    const nameRu = String((c && c.nameRu) || "").trim().slice(0, 24);
    // emoji: faqat qisqa belgi — HTML/skript kirmasin
    const emoji = String((c && c.emoji) || "").trim().replace(/[<>&"'`]/g, "").slice(0, 4);
    const rawId = String((c && c.id) || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
    out.push({
      id: rawId || `c${Date.now().toString(36)}${out.length}${Math.random().toString(36).slice(2, 5)}`,
      name, nameRu, emoji,
    });
    if (out.length >= MAX_CATEGORIES) break;
  }
  return out;
}
async function loadCategories() {
  try {
    return normalizeCategories((await kv.get(CAT_KEY)) || []);
  } catch (e) {
    console.error("loadCategories:", e);
    return [];
  }
}
// sotuvchi yuborgan categoryIds ichidan faqat MAVJUD bo'limlar qoladi (takrorsiz)
function cleanCategoryIds(ids, categories) {
  if (!Array.isArray(ids)) return [];
  const valid = new Set(categories.map((c) => c.id));
  const out = [];
  for (const raw of ids) {
    const id = String(raw || "");
    if (valid.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

// Do'kon bo'limlari — sotuvchi o'zi nomlaydi (Gullar, Toshlar, Sovg'alar...).
// Ko'pi bilan 5 ta, nomi 1-24 belgi. Mahsulot shu bo'limlardan biriga biriktiriladi.
const MAX_SECTIONS = 5;
function normalizeSections(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const s of arr) {
    const name = String((s && s.name) || "").trim().slice(0, 24);
    if (!name) continue;
    if (out.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    out.push({ id: String((s && s.id) || `sec${Date.now()}${out.length}${Math.random().toString(36).slice(2, 5)}`), name });
    if (out.length >= MAX_SECTIONS) break;
  }
  return out;
}
function adminSeller(s) {
  const { salt, passwordHash, tokVer, ...rest } = s;
  return rest;
}
function clientIpOf(req) {
  const fwd = req.headers["x-forwarded-for"];
  return (Array.isArray(fwd) ? fwd[0] : String(fwd || "")).split(",")[0].trim() || "unknown";
}
// ro'yxatdan o'tishda matn uzunligi cheklovi (juda uzun qiymatlar bilan to'ldirmasin)
function shopNameLenCheck(shopName, ownerName, phone) {
  if (shopName.length > 40 || ownerName.length > 60 || phone.length > 25) {
    const e = new Error("Matn juda uzun"); e.code = "TOOLONG"; throw e;
  }
}

// -> { ok, needsUpgrade }  (eski sha256 xesh muvaffaqiyatli kirishda scrypt'ga yangilanadi)
function verifySellerCredentials(seller, password) {
  if (!seller) return { ok: false, needsUpgrade: false };
  if (seller.builtin) return { ok: !!ADMIN_PASSWORD && safeEqual(password, ADMIN_PASSWORD), needsUpgrade: false };
  return checkPassword(password, seller);
}

export default async function handler(req, res) {
  applyCors(req, res, "GET, POST, OPTIONS", "Content-Type, x-seller-login, x-seller-token");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET") {
      const [list, categories, thumbs] = await Promise.all([loadSellers(), loadCategories(), getThumbMap()]);
      const active = list.filter((s) => s.status === "active").map(publicSeller).map((s) => ({
        ...s,
        shopLogoThumb: (s.shopLogo && thumbs[s.shopLogo] && thumbs[s.shopLogo] !== s.shopLogo) ? thumbs[s.shopLogo] : "",
      }));
      res.setHeader("Cache-Control", "public, s-maxage=20, stale-while-revalidate=120");
      return res.status(200).json({ ok: true, sellers: active, categories });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const body = req.body || {};
    const action = String(body.action || "");

    // "register" — yangi ariza, parol tekshiruvi yo'q, brute-force bilan aloqasi yo'q.
    if (action !== "register" && (await isBlocked(AUTH_SCOPE, req, AUTH_LIMIT))) {
      return res.status(429).json({ ok: false, error: TOO_MANY_MSG });
    }

    let list = await loadSellers();

    /* ---------------- ochiq: ro'yxatdan o'tish ---------------- */
    if (action === "register") {
      // spam ro'yxatdan o'tishdan himoya (200 ta joyni band qilib qo'yishmasin)
      const rl = await rateLimit("sreg", clientIpOf(req), 3, 3600);
      if (!rl.ok) return res.status(429).json({ ok: false, error: RATE_MSG });
      if (list.filter((s) => s.status === "pending").length >= 40) {
        return res.status(400).json({ ok: false, error: "Hozir arizalar ko'p — birozdan keyin urinib ko'ring" });
      }
      const shopName = String(body.shopName || "").trim();
      const ownerName = String(body.ownerName || "").trim();
      const phone = String(body.phone || "").trim();
      const login = String(body.login || "").trim().toLowerCase();
      const password = String(body.password || "");

      if (!shopName || shopName.length < 2) return res.status(400).json({ ok: false, error: "Do'kon nomini kiriting" });
      if (!ownerName) return res.status(400).json({ ok: false, error: "Ismingizni kiriting" });
      if (!phone) return res.status(400).json({ ok: false, error: "Telefon raqamingizni kiriting" });
      if (!/^[a-z0-9_]{3,20}$/.test(login)) return res.status(400).json({ ok: false, error: "Login 3-20 ta lotin harf/raqam bo'lsin (masalan: gulmarkaz)" });
      const pwProblem = passwordProblem(password);
      if (pwProblem) return res.status(400).json({ ok: false, error: pwProblem });
      shopNameLenCheck(shopName, ownerName, phone);
      if (list.find((s) => s.login === login)) return res.status(400).json({ ok: false, error: "Bu login band — boshqasini tanlang" });
      if (list.find((s) => s.shopName.toLowerCase() === shopName.toLowerCase())) {
        return res.status(400).json({ ok: false, error: "Bu do'kon nomi band — boshqasini tanlang" });
      }
      if (list.length >= 200) return res.status(400).json({ ok: false, error: "Hozircha yangi ro'yxatdan o'tish to'xtatilgan" });

      const seller = {
        id: `s${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        shopName, ownerName, phone, login,
        ...makePasswordRecord(password),
        tokVer: 0,
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
      // bitta login'ga turli IP'lardan hujum qilinsa ham to'xtatamiz (15 daqiqada 20 xato)
      const loginKey = `login:${login.slice(0, 30)}`;
      if (await isBlockedKey(loginKey, 20)) return res.status(429).json({ ok: false, error: TOO_MANY_MSG });
      const cred = verifySellerCredentials(seller, String(body.password || "").slice(0, 200));
      if (!seller || !cred.ok) {
        await recordFailure(AUTH_SCOPE, req, AUTH_WINDOW);
        await recordFailureKey(loginKey, AUTH_WINDOW);
        return res.status(401).json({ ok: false, error: "Login yoki parol noto'g'ri" });
      }
      await clearFailures(AUTH_SCOPE, req);
      await clearFailuresKey(loginKey);
      if (cred.needsUpgrade) {   // eski sha256 -> scrypt
        try {
          const li = list.findIndex((s) => s.id === seller.id);
          if (li !== -1) { Object.assign(list[li], makePasswordRecord(String(body.password))); await kv.set(KEY, list); }
        } catch (e) { console.error("pw upgrade:", e); }
      }
      if (seller.status === "pending") return res.status(403).json({ ok: false, error: "Arizangiz hali tasdiqlanmagan — administrator ko'rib chiqmoqda" });
      if (seller.status !== "active") return res.status(403).json({ ok: false, error: "Bu do'kon bloklangan" });
      const token = await issueToken(seller);
      return res.status(200).json({ ok: true, seller: adminSeller(seller), isSuper: !!seller.builtin, token });
    }

    // sessiya tokenini tekshirish (panel ochilganda — parolsiz kirish)
    if (action === "session") {
      const seller = await sellerFromToken(body.login, body.token, list);
      if (!seller) return res.status(401).json({ ok: false, error: "Sessiya eskirgan — qayta kiring" });
      await clearFailures(AUTH_SCOPE, req);
      return res.status(200).json({ ok: true, seller: adminSeller(seller), isSuper: !!seller.builtin });
    }
    if (action === "logout") {
      await revokeToken(body.token);
      return res.status(200).json({ ok: true });
    }

    /* ---------------- sotuvchi: profil yangilash ---------------- */
    if (action === "updateProfile") {
      const login = String(body.login || "").trim().toLowerCase();
      const idx = list.findIndex((s) => s.login === login);
      const seller = list[idx];
      const byToken = body.token ? await sellerFromToken(login, body.token, list) : null;
      if (!seller || (!byToken && !verifySellerCredentials(seller, String(body.password || "").slice(0, 200)).ok)) {
        await recordFailure(AUTH_SCOPE, req, AUTH_WINDOW);
        return res.status(401).json({ ok: false, error: "Login yoki parol noto'g'ri" });
      }
      await clearFailures(AUTH_SCOPE, req);
      if (seller.status !== "active") return res.status(403).json({ ok: false, error: "Do'kon faol emas" });

      const updated = { ...seller };
      let newPwChanged = false;

      // Do'kon nomi/rasmi haftada faqat 1 marta o'zgaradi (super-admin zetme cheklovsiz).
      const newNameVal = body.shopName !== undefined ? String(body.shopName).trim() : null;
      const newLogoVal = body.shopLogo !== undefined ? cleanUrl(body.shopLogo) : null;
      const brandChanging =
        (newNameVal !== null && newNameVal !== seller.shopName) ||
        (newLogoVal !== null && newLogoVal !== (seller.shopLogo || ""));
      if (brandChanging && !seller.builtin) {
        const WEEK = 7 * 24 * 3600 * 1000;
        const last = Number(seller.brandChangedAt || 0);
        if (last && Date.now() - last < WEEK) {
          const days = Math.max(1, Math.ceil((WEEK - (Date.now() - last)) / (24 * 3600 * 1000)));
          return res.status(400).json({ ok: false, error: `Do'kon nomi va rasmini haftada bir marta o'zgartirish mumkin — yana ${days} kundan keyin urinib ko'ring (yoki administratordan ruxsat so'rang)` });
        }
        updated.brandChangedAt = Date.now();
      }

      if (body.telegramChatId !== undefined) {
        const cid = cleanChatId(body.telegramChatId);
        if (String(body.telegramChatId).trim() && !cid) {
          return res.status(400).json({ ok: false, error: "Telegram Chat ID faqat raqamlardan iborat bo'lsin (botda /myid deb yozing)" });
        }
        updated.telegramChatId = cid;
      }
      if (body.region !== undefined) updated.region = String(body.region).trim().slice(0, 40); // viloyat / shahar
      if (body.bonusEnabled !== undefined) updated.bonusEnabled = !!body.bonusEnabled;
      if (body.phone !== undefined && String(body.phone).trim()) updated.phone = String(body.phone).trim();
      if (body.shopLogo !== undefined) updated.shopLogo = cleanUrl(body.shopLogo);
      if (body.sections !== undefined) updated.sections = normalizeSections(body.sections);
      if (body.categoryIds !== undefined) updated.categoryIds = cleanCategoryIds(body.categoryIds, await loadCategories());
      if (body.shopName !== undefined) {
        const newName = String(body.shopName).trim();
        if (newName.length < 2) return res.status(400).json({ ok: false, error: "Do'kon nomi kamida 2 ta belgi bo'lsin" });
        const taken = list.some((s) => s.id !== seller.id && s.shopName.toLowerCase() === newName.toLowerCase());
        if (taken) return res.status(400).json({ ok: false, error: "Bu do'kon nomi band — boshqasini tanlang" });
        updated.shopName = newName;
      }
      if (body.newPassword) {
        if (seller.builtin) return res.status(400).json({ ok: false, error: "Asosiy do'kon paroli Vercel'dagi ADMIN_PASSWORD orqali o'zgartiriladi" });
        const pwProblem = passwordProblem(body.newPassword);
        if (pwProblem) return res.status(400).json({ ok: false, error: pwProblem });
        Object.assign(updated, makePasswordRecord(String(body.newPassword)));
        updated.tokVer = Number(seller.tokVer || 0) + 1;   // boshqa qurilmalardagi eski sessiyalar yopiladi
        newPwChanged = true;
      }
      list[idx] = updated;
      await kv.set(KEY, list);
      // parol almashganda joriy qurilma uchun yangi token beramiz (chiqib ketmasin)
      const freshToken = newPwChanged ? await issueToken(updated) : undefined;
      return res.status(200).json({ ok: true, seller: adminSeller(updated), ...(freshToken ? { token: freshToken } : {}) });
    }

    /* ---------------- super-admin amallari ---------------- */
    if (!(await isAdmin(req, list))) {
      await recordFailure(AUTH_SCOPE, req, AUTH_WINDOW);
      return res.status(401).json({ ok: false, error: "Noto'g'ri parol" });
    }
    await clearFailures(AUTH_SCOPE, req);

    if (action === "adminList") {
      return res.status(200).json({ ok: true, sellers: list.map(adminSeller), categories: await loadCategories() });
    }

    // Marketplace bo'limlari ro'yxatini saqlash (butunlay almashtiradi)
    if (action === "catSave") {
      const categories = normalizeCategories(body.categories);
      await kv.set(CAT_KEY, categories);
      // o'chirilgan bo'limlar sotuvchilardan ham tushib qolsin
      let changed = false;
      list = list.map((s) => {
        if (!Array.isArray(s.categoryIds) || !s.categoryIds.length) return s;
        const cleaned = cleanCategoryIds(s.categoryIds, categories);
        if (cleaned.length !== s.categoryIds.length) { changed = true; return { ...s, categoryIds: cleaned }; }
        return s;
      });
      if (changed) await kv.set(KEY, list);
      return res.status(200).json({ ok: true, categories, sellers: list.map(adminSeller) });
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
      const pwProblem = passwordProblem(newPassword);
      if (pwProblem) return res.status(400).json({ ok: false, error: pwProblem });
      Object.assign(list[idx], makePasswordRecord(newPassword));
      list[idx].tokVer = Number(list[idx].tokVer || 0) + 1;   // eski sessiyalar yopiladi
    } else if (action === "approve") {
      list[idx].status = "active";
    } else if (action === "block") {
      list[idx].status = "blocked";
      list[idx].tokVer = Number(list[idx].tokVer || 0) + 1;
    } else if (action === "unblock") {
      list[idx].status = "active";
    } else if (action === "allowBrandChange") {
      // super-admin sotuvchiga nom/rasmni muddatidan oldin o'zgartirishga ruxsat beradi
      delete list[idx].brandChangedAt;
    } else if (action === "setSellerCategories") {
      // super-admin do'konni marketplace bo'limlariga biriktiradi
      list[idx].categoryIds = cleanCategoryIds(body.categoryIds, await loadCategories());
    } else if (action === "remove") {
      const removedId = list[idx].id;
      list.splice(idx, 1);
      // sotuvchining mahsulotlarini ham olib tashlaymiz
      await withLock("products", async () => {
        const products = (await kv.get("products")) || [];
        await kv.set("products", products.filter((p) => (p.sellerId || MAIN_SELLER_ID) !== removedId));
      });
    } else {
      return res.status(400).json({ ok: false, error: "Noma'lum amal" });
    }

    await kv.set(KEY, list);
    return res.status(200).json({ ok: true, sellers: list.map(adminSeller) });
  } catch (err) {
    if (err && err.code === "TOOLONG") return res.status(400).json({ ok: false, error: "Do'kon nomi, ism yoki telefon juda uzun" });
    if (err && err.code === "BUSY") return res.status(503).json({ ok: false, error: "Server band — qayta urinib ko'ring" });
    console.error(err);
    return res.status(500).json({ ok: false, error: "Server xatosi" });
  }
}
