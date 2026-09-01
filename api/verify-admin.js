// Zetme AI — Admin parolini tekshirish
import { isBlocked, recordFailure, clearFailures, TOO_MANY_MSG } from "./_lib/security.js";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SCOPE = "auth";
const LIMIT = 8;        // 15 daqiqada 8 marta noto'g'ri urinishdan keyin bloklanadi
const WINDOW = 900;

export default async function handler(req, res) {
  if (await isBlocked(SCOPE, req, LIMIT)) {
    return res.status(429).json({ ok: false, error: TOO_MANY_MSG });
  }

  const pw = req.headers["x-admin-password"];
  if (pw && ADMIN_PASSWORD && pw === ADMIN_PASSWORD) {
    await clearFailures(SCOPE, req);
    return res.status(200).json({ ok: true });
  }
  await recordFailure(SCOPE, req, WINDOW);
  res.status(401).json({ ok: false, error: "Noto'g'ri parol" });
}
