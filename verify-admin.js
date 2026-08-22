// Zetme AI — Admin parolini tekshirish
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

export default async function handler(req, res) {
  const pw = req.headers["x-admin-password"];
  if (pw && ADMIN_PASSWORD && pw === ADMIN_PASSWORD) {
    return res.status(200).json({ ok: true });
  }
  res.status(401).json({ ok: false });
}
