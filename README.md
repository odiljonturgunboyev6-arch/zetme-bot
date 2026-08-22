# Zetme AI — Telegram buyurtma boti (Vercel)

Bu papka botning "miyasi" — sayt Telegram'ga o'tganda, aynan shu kod javob beradi.

## 1. GitHub'ga yuklash

1. github.com'da yangi repository yarating (masalan `zetme-bot`), Public yoki Private — farqi yo'q.
2. Shu papkadagi barcha fayllarni (`api/bot.js`, `package.json`, `README.md`) o'sha repoga yuklang
   (GitHub saytida "Add file → Upload files" orqali ham bo'ladi — kod yozish shart emas).

## 2. Vercel'da loyiha yaratish

1. vercel.com'ga GitHub akkountingiz bilan kiring.
2. "Add New → Project" → yaratgan `zetme-bot` repositoryni tanlang → "Deploy".
3. Bir necha soniyada loyiha tayyor bo'ladi, sizga manzil beriladi (masalan `zetme-bot.vercel.app`).

## 3. Vercel KV (ma'lumot bazasi) ulash

Mijoz ismi/telefoni/viloyatini "eslab qolish" uchun kichik bazaga ehtiyoj bor.

1. Vercel loyihangizda **Storage** bo'limiga o'ting.
2. **Create Database → KV** tanlang, nomini kiriting (masalan `zetme-kv`), yarating.
3. "Connect to Project" tugmasini bosib, `zetme-bot` loyihasiga ulang.
4. Bu avtomatik ravishda kerakli maxfiy o'zgaruvchilarni (KV_REST_API_URL va h.k.) loyihaga qo'shadi — qo'lda hech narsa yozish shart emas.

## 4. Kerakli sozlamalarni (Environment Variables) qo'shish

Loyihada **Settings → Environment Variables** bo'limiga o'ting, ikkitasini qo'shing:

| Nomi | Qiymati |
|---|---|
| `BOT_TOKEN` | `8032690204:AAFXbCRNBR8CHz-QdXKn05oRXBG_1rFeIiY` |
| `OWNER_CHAT_ID` | `5262377062` |

Qo'shgandan so'ng loyihani qayta joylashtiring (**Deployments → ⋯ → Redeploy**).

## 5. Telegram'ga botning manzilini aytish (webhook)

Vercel loyihangiz manzilini oling (masalan `https://zetme-bot.vercel.app`), so'ng brauzerda quyidagi manzilni oching (TOKEN va DOMAIN'ni o'zingiznikiga almashtiring):

```
https://api.telegram.org/bot8032690204:AAFXbCRNBR8CHz-QdXKn05oRXBG_1rFeIiY/setWebhook?url=https://zetme-bot.vercel.app/api/bot
```

Javobda `"ok":true` chiqsa — tayyor. Endi bot jonlandi.

## 6. Sinash

1. Saytda (`zetme-homepage.jsx`) savatga mahsulot qo'shing, "Buyurtma berish"ni bosing.
2. Telegram botga o'tasiz, `/start` avtomatik yuboriladi.
3. Bot mahsulotlar ro'yxatini ko'rsatadi, ism/telefon/viloyat so'raydi.
4. "Tasdiqlash" bosilgach — sizning shaxsiy Telegram'ingizga (5262377062) buyurtma xabari keladi.
5. Ikkinchi marta sinab ko'ring — bu safar ism/viloyat so'ralmaydi, bot sizni tanib, to'g'ridan-to'g'ri tasdiqlashni so'raydi.

## Muhim eslatmalar

- `api/bot.js` ichidagi `PRODUCTS` ro'yxati saytdagi mahsulotlar bilan **bir xil kodlarda** bo'lishi kerak — yangi mahsulot qo'shsangiz, shu yerga ham qo'shing (keyingi bosqichda buni umumiy bazaga ko'chiramiz, hozircha qo'lda sinxron).
- Token xavfsiz — u endi faqat Vercel serverida, hech qanday sahifa manbasida ko'rinmaydi.
- Minimal buyurtma (200 000 so'm) serverda ham qayta tekshiriladi — sayt tekshiruvi chetlab o'tilsa ham himoyalangan.
