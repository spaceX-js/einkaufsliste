// Kassenzettel lesen: aus dem Text eines Bons (PDF-Text oder vom Foto abgeschrieben)
// Laden, Datum, Summe und die einzelnen Zeilen mit Preisen herausholen.
// Funktioniert für die gängigen Bon-Formate (Rewe, Penny, Lidl, dm, Rossmann, Aldi, Edeka …),
// weil alle nach demselben Muster aufgebaut sind: Name … Preis [Steuerkennzeichen].

// Reihenfolge wichtig: Penny-Bons enthalten „REWE“ in der Kassennummer, nahkauf gehört ebenfalls zu Rewe
const SHOPS = [
  ["Penny", /\bpenny\b/i],
  ["Lidl", /\blidl\b/i],
  ["Rossmann", /\brossmann\b/i],
  ["dm", /\bdmPOS\b|\bdm\.de\b|\bvon dm\b|\bdm-drogerie\b|\bdmBio\b/i],
  ["Aldi", /\baldi\b/i],
  ["Kaufland", /\bkaufland\b/i],
  ["Netto", /netto[\s-]+marken|netto-online|\bnetto\s+(filiale|city|app)\b/i],
  ["nahkauf", /\bnahkauf\b/i],
  ["Edeka", /\bedeka\b/i],
  ["Rewe", /\brewe\b/i],
  ["Denns", /\bdenns\b/i],
  ["IKEA", /\bikea\b/i],
  ["Fressnapf", /\bfressnapf\b/i],
  ["Obi", /\bobi\s+(markt|bau|gmbh)|\bobi\.de\b/i],
  ["Bauhaus", /\bbauhaus\b/i],
  ["Hornbach", /\bhornbach\b/i],
  ["toom", /\btoom\b/i],
  ["Alnatura", /\balnatura\s+(produktions|super\s*natur|markt)/i],
  ["Müller", /\bm[üu]ller\s+(handels|drogerie)/i]
];
export const KNOWN_SHOPS = SHOPS.map(s => s[0]);

// Beträge mit Komma (1,29) oder – vom Foto abgeschrieben – mit Punkt (1.29)
const cents = s => { s = String(s); s = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s; return Math.round(parseFloat(s) * 100); };
const num = s => parseFloat(String(s).replace(",", "."));
const AMT = "\\d{1,4}(?:\\.\\d{3})*,\\d{2}|\\d{1,4}\\.\\d{2}";

// Zeile vereinheitlichen: Sonderzeichen aus PDFs (Rossmann nutzt U+FE0F statt Leerzeichen), mehrfache Leerzeichen
export function cleanLine(s) {
  return String(s || "")
    // Formatierung, die eine Bilderkennung manchmal mitliefert: Tabellen-Striche, Fettdruck, Aufzählungszeichen
    .replace(/^\s*\|?\s*[-:| ]{3,}\|?\s*$/, "").replace(/\|/g, " ").replace(/\*\*|__|`/g, "").replace(/^\s*(?:[-•*]\s+|\d+\.\s+(?=\D))/, "").replace(/[️   \t]/g, " ").replace(/[​-‍﻿]/g, "").replace(/\s+/g, " ").trim();
}
// Schlüssel für gelernte Zuordnungen: Kleinbuchstaben, ohne Satzzeichen-Unterschiede
export function rawKey(s) { return cleanLine(s).toLowerCase().replace(/\s*([.,/+&-])\s*/g, "$1").slice(0, 80); }

const PRICE_END = new RegExp("^(.*?)\\s*(-)?\\s*€?\\s?(" + AMT + ")\\s*(?:€|EUR)?\\s*(\\*?\\s*§?\\s*[A-Z]?\\s*\\d?\\s*\\*?)$");
const QTY_LINE = /^(\d+(?:[.,]\d+)?)\s*(stk|st|kg)\.?\s*[x×]\s*(\d+[.,]\d{2})\s*(?:eur|€)?\s*(\/\s*kg)?$/i;
const STOP = /^(summe|zu zahlen|zwischensumme|gesamtsumme|gesamtbetrag|total|zahlbetrag|betrag)\b/i;
const SKIP_NAMES = /^(eur|mwst|steuer|netto|brutto|ust|bar|gegeben|rückgeld|kartenzahlung|visa|girocard|ec-karte|mastercard)\b/i;

function detectShop(text) { for (const [name, re] of SHOPS) if (re.test(text)) return name; return ""; }

// Datum als Ortszeit ohne Zeitzone, z. B. „2026-11-04T16:06“
const p2 = n => String(n).padStart(2, "0");
const localIso = (y, mo, d, h, mi) => y + "-" + p2(mo) + "-" + p2(d) + "T" + p2(h) + ":" + p2(mi);
function detectDate(lines) {
  for (const l of lines) {
    const m = l.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\b(?:[\s,/]+(\d{1,2}):(\d{2}))?/);
    if (m) {
      let [, d, mo, y, h, mi] = m; y = y.length === 2 ? "20" + y : y;
      if (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31 && +y > 2000) return localIso(+y, +mo, +d, h ? +h : 12, mi ? +mi : 0);
    }
  }
  for (const l of lines) {
    const m = l.match(/\b(20\d{2})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (m) return localIso(+m[1], +m[2], +m[3], +m[4], +m[5]);
  }
  return null;
}

function kindOf(name) {
  if (/pfand/i.test(name) && !/leergut/i.test(name)) return "pfand";
  if (/leergut/i.test(name)) return "pfand";
  if (/(trage)?tasche|tüte|tragetasch|beutel\s*papier|papiertüte/i.test(name) && name.length < 30) return "bag";
  return "item";
}

// Haupt-Funktion: Text → { shop, at, total, sum, lines }
export function parseReceipt(text) {
  const all = String(text || "").split(/\r?\n/).map(cleanLine).filter(Boolean);
  const shop = detectShop(all.join("\n"));
  const date = detectDate(all);
  const lines = [];
  let total = null, sub = null, stopped = false;
  for (let i = 0; i < all.length; i++) {
    const l = all[i];
    if (stopped) {
      // nach der Zwischensumme (Rossmann) kommt die tatsächlich bezahlte Summe
      const m = l.match(new RegExp("^(summe|zu zahlen|gesamtbetrag|zahlbetrag)\\b[^\\d-]*(-?(?:" + AMT + "))", "i"));
      if (m && total == null) total = cents(m[2]);
      continue;
    }
    if (STOP.test(l)) {
      const m = l.match(new RegExp("(-?(?:" + AMT + "))"));
      if (m) { if (/^zwischensumme/i.test(l)) sub = cents(m[1]); else total = cents(m[1]); }
      if (lines.length) stopped = true;
      continue;
    }
    // Mengenzeile unter einem Artikel: „2 Stk x 1,45“, „0,184 kg x 2,99 EUR/kg“
    const q = l.match(QTY_LINE);
    if (q && lines.length) {
      const last = lines[lines.length - 1];
      const unit = /kg/i.test(q[2]) || q[4] ? "kg" : "stk";
      last.qty = num(q[1]); last.unit = unit; last.unitPrice = cents(q[3]);
      continue;
    }
    const m = l.match(PRICE_END);
    if (!m) continue;
    let name = m[1].trim(); const neg = !!m[2]; const price = cents(m[3]);
    if (!name || SKIP_NAMES.test(name) || /^[\d\s.,:%=*-]+$/.test(name)) continue;
    if (/^[A-Z]\s*=\s*\d/.test(name) || /^\d\s*=\s*\d/.test(name)) continue;          // Steuerzeilen „A= 19,0%“
    // Rabatt-/Coupon-Zeile mit Minus: gehört zum Artikel davor
    if (neg) {
      const last = lines[lines.length - 1];
      if (last && price <= last.price) { last.discount += price; last.price -= price; }
      continue;
    }
    // EAN vorne (Rossmann): „4068134245397 BABYDR. PFLAUME-BA“
    let ean = "";
    const e = name.match(/^(\d{8,14})\s+(.+)$/); if (e) { ean = e[1]; name = e[2]; }
    let qty = 1, unit = "stk", unitPrice = price;
    // Menge vorne (dm): „2x 1,65 H-Bio Alpenmilch“
    const pre = name.match(/^(\d+)\s*[x×]\s*(\d+[.,]\d{2})\s+(.+)$/i);
    if (pre) { qty = +pre[1]; unitPrice = cents(pre[2]); name = pre[3]; }
    // Menge hinten (Lidl): „Kiwi Gold 0,49 x 2“
    const post = name.match(/^(.+?)\s+(\d+[.,]\d{2})\s*[x×]\s*(\d+)$/i);
    if (post) { name = post[1]; unitPrice = cents(post[2]); qty = +post[3]; }
    const post2 = name.match(/^(.+?)\s+(\d+)\s*[x×]\s*(\d+[.,]\d{2})$/i);
    if (!post && post2) { name = post2[1]; qty = +post2[2]; unitPrice = cents(post2[3]); }
    name = name.replace(/\s+\d+\s*(stk|st)\.?$/i, "").trim();
    if (!name) continue;
    lines.push({ raw: name.slice(0, 80), ean, qty, unit, unitPrice, gross: price, discount: 0, price, kind: kindOf(name) });
  }
  const sum = lines.reduce((a, l) => a + l.price, 0);
  return { shop, at: date, total: total != null ? total : sub, sub, sum, lines };
}
