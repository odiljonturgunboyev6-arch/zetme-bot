// Zetme AI — foydalanuvchilar statistikasi (2026-10-07)
// Bot: shaxsiy chatda yozgan har bir odam (chatId) — jami va kunlik.
// Sayt: har bir qurilma (localStorage'dagi tasodifiy id) — kuniga 1 marta, jami va kunlik.
// Kun Toshkent vaqti (UTC+5) bo'yicha. Kunlik to'plamlar 40 kundan keyin o'chadi.
// "_lib" ichida — Vercel buni alohida funksiya deb sanamaydi (12 ta chegara).
import { kv } from "@vercel/kv";

const DAY_TTL = 40 * 86400;

export function tzDay(offsetDays = 0) {
  return new Date(Date.now() + 5 * 3600000 - offsetDays * 86400000).toISOString().slice(0, 10);
}

async function track(kind, id) {
  const key = String(id || "").slice(0, 60);
  if (!key) return;
  const dk = `stat:${kind}:d:${tzDay()}`;
  try {
    await Promise.all([kv.sadd(`stat:${kind}:all`, key), kv.sadd(dk, key)]);
    await kv.expire(dk, DAY_TTL);
  } catch (e) { console.error("traffic track:", e); }
}
export const trackBot = (chatId) => track("bot", chatId);
export const trackSite = (vid) => track("site", vid);

// { bot:{total,today,yesterday,days:[{day,n}]}, site:{...} } — days: oxirgi 7 kun (bugundan orqaga)
export async function getTraffic() {
  const days = Array.from({ length: 7 }, (_, i) => tzDay(i));
  const one = async (kind) => {
    const [total, ...counts] = await Promise.all([
      kv.scard(`stat:${kind}:all`),
      ...days.map((d) => kv.scard(`stat:${kind}:d:${d}`)),
    ]);
    let week = 0;
    try {
      week = days.length ? (await kv.sunion(...days.map((d) => `stat:${kind}:d:${d}`))).length : 0;
    } catch (e) { week = 0; }
    return {
      total: Number(total) || 0,
      today: Number(counts[0]) || 0,
      yesterday: Number(counts[1]) || 0,
      week,
      days: days.map((d, i) => ({ day: d, n: Number(counts[i]) || 0 })),
    };
  };
  const [bot, site] = await Promise.all([one("bot"), one("site")]);
  return { bot, site };
}
