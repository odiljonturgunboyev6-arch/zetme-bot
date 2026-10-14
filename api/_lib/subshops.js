// Zetme AI — "alohida do'kon" bo'limlari (2026-10-14)
// Sotuvchi o'z do'konidagi bo'limni ALOHIDA DO'KON qilib ko'rsatishi mumkin:
// section.shop = { name, region, logo, categoryIds }. Mijoz saytda uni boshqa
// do'kon (o'z nomi, rasmi, viloyati bilan) ko'radi. Ma'lumotlar, buyurtmalar,
// ostatka — asl sotuvchida qoladi (bir egasi). Virtual do'kon id: "<sellerId>~<sectionId>".

export const SUB_SEP = "~";

export function subShopOf(seller, sectionId) {
  if (!seller || !sectionId) return null;
  const sec = (Array.isArray(seller.sections) ? seller.sections : []).find((x) => x && x.id === sectionId);
  return sec && sec.shop && sec.shop.name ? { sec, shop: sec.shop, id: seller.id + SUB_SEP + sec.id } : null;
}

// Ochiq do'konlar ro'yxati: asl do'kon (alohida bo'limlarsiz) + har alohida bo'lim uchun virtual do'kon
export function expandSellers(publicList) {
  const out = [];
  for (const s of publicList) {
    const secs = Array.isArray(s.sections) ? s.sections : [];
    const subs = secs.filter((x) => x && x.shop && x.shop.name);
    out.push({ ...s, sections: secs.filter((x) => !(x && x.shop && x.shop.name)).map(({ id, name }) => ({ id, name })) });
    for (const x of subs) {
      out.push({
        id: s.id + SUB_SEP + x.id,
        parentId: s.id,
        shopName: x.shop.name,
        bonusEnabled: s.bonusEnabled,
        shopLogo: x.shop.logo || "",
        region: x.shop.region || "",
        sections: [],
        categoryIds: Array.isArray(x.shop.categoryIds) ? x.shop.categoryIds : [],
      });
    }
  }
  return out;
}
