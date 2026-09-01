// Zetme AI — Telegram bot "Menu" tugmasini saytga bog'lash (bir martalik sozlash)
// POST /api/bot-menu-button   Kirish: super-admin (x-admin-password)
// Nima qiladi: Telegram Bot API'ning setChatMenuButton metodi orqali botning
// standart menyu tugmasini "Web App" turiga o'rnatadi — shundan keyin
// @zetmeai_bot chatidagi xabar yozish maydoni yonida doimiy tugma chiqadi,
// bosilganda sayt to'g'ridan-to'g'ri Telegram ichida (Web App sifatida) ochiladi.
// Mijoz hech qanday havola yozmaydi/qidirmaydi — bir marta bot bilan gaplashgan
// bo'lsa, shu tugma orqali doim to'g'ridan-to'g'ri kiraveradi.

const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SITE_URL = "https://zetme-bot.vercel.app";

function isAdmin(req) {
  const auth = req.headers["x-admin-password"];
  return auth && ADMIN_PASSWORD && auth === ADMIN_PASSWORD;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-password");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    if (!isAdmin(req)) return res.status(401).json({ ok: false, error: "Noto'g'ri parol" });
    if (!BOT_TOKEN) return res.status(400).json({ ok: false, error: "BOT_TOKEN sozlanmagan" });

    const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        menu_button: {
          type: "web_app",
          text: "Zetme",
          web_app: { url: SITE_URL },
        },
      }),
    });
    const tgData = await tgRes.json();
    if (!tgData.ok) {
      return res.status(400).json({ ok: false, error: "Telegram: " + (tgData.description || "xatolik") });
    }
    return res.status(200).json({ ok: true, result: tgData.result });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Server xatosi" });
  }
}
