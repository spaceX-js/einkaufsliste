// Warengruppen: Reihenfolge = ungefährer Weg durch den Laden.
// Ein Eintrag bekommt automatisch eine Gruppe über Stichwörter; im Bearbeiten-Dialog lässt sie sich ändern.
(function (root) {
  "use strict";
  const GROUPS = [
    { id: "obst",      name: "Obst & Gemüse" },
    { id: "brot",      name: "Brot & Backwaren" },
    { id: "kuehl",     name: "Kühlregal" },
    { id: "tk",        name: "Tiefkühl" },
    { id: "vorrat",    name: "Nudeln, Reis & Vorrat" },
    { id: "gewuerz",   name: "Gewürze & Saucen" },
    { id: "snacks",    name: "Snacks & Süßes" },
    { id: "getraenke", name: "Getränke" },
    { id: "baby",      name: "Baby & Kind" },
    { id: "pflege",    name: "Körperpflege & Gesundheit" },
    { id: "haushalt",  name: "Haushalt & Putzen" },
    { id: "tier",      name: "Tierbedarf" },
    { id: "garten",    name: "Garten & Pflanzen" },
    { id: "wohnen",    name: "Wohnen & Werkzeug" },
    { id: "sonst",     name: "Sonstiges" }
  ];
  // Prüfreihenfolge (erste passende Regel gewinnt). Wörter mit bis zu 3 Buchstaben zählen nur als ganzes Wort,
  // "*tee" heißt: ein Wort endet auf „tee“ (Kamillentee, Olivenöl → "*öl").
  const RULES = [
    ["tier",     ["katze", "futter", "trofu", "feufu", "suri", "dreamies", "kack", "streu", "leckerli"]],
    ["baby",     ["pampers", "windel", "waterwipes", "feuchttücher", "feuchttuecher", "wickel", "still", "night pants", "kinder", "hirse", "baby", "schnuller"]],
    ["tk",       ["tk", "tiefkühl", "eis", "edamame", "pommes"]],
    ["pflege",   ["zahn", "shampoo", "duschgel", "deo", "deos", "seife", "lotion", "serum", "rasier", "haar", "watte", "binden", "slipeinlage", "tempo", "taschentuch", "pflaster", "magnesium", "massage", "hitzeschutz", "creme", "vitamin", "tablette", "kosmetik"]],
    ["haushalt", ["spül", "tabs", "reinig", "schwamm", "schwämm", "schwömm", "waschmittel", "weichspül", "wäsche", "bügel", "müll", "küchenrolle", "toilettenpapier", "klopapier", "backpapier", "alufolie", "frischhalte", "staubt", "essigessenz", "allzweck", "batterie", "glühbirne"]],
    ["garten",   ["dünger", "erde", "rasen", "pflanz", "topf", "töpf", "untersetzer", "lavendel", "hecke", "bambus", "gartenhacke", "rechen", "laubbesen", "blumenzwiebel", "saatgut"]],
    ["wohnen",   ["box", "boxen", "aufbewahrung", "kabel", "matte", "trofast", "halter", "stopper", "möbel", "schraube", "dübel", "werkzeug", "lampe", "regal"]],
    ["gewuerz",  ["gewürz", "paprika pulver", "paprikapulver", "edels", "sumach", "salz", "pfeffer", "maggi", "chili", "sauce", "soße", "senf", "ketchup", "brühe", "pesto", "curry", "zimt", "oregano", "mayo"]],
    ["getraenke",["cola", "wasser", "saft", "tee", "*tee", "kaffee", "drink", "bier", "wein", "sprudel", "spudel", "limo", "schorle"]],
    ["snacks",   ["chips", "schoko", "waffel", "cracker", "snack", "keks", "gummi", "schlecki", "dattel", "riegel", "mousse", "kokoschips", "süßigkeit", "bonbon", "nüsschen"]],
    ["vorrat",   ["nudel", "pasta", "reis", "mehl", "flocken", "linsen", "erbsen", "bohnen", "couscous", "buchweizen", "lasagne", "tomatenmark", "passiert", "stückig", "chia", "sesam", "kern", "samen", "cashew", "nüsse", "nuss", "mus", "cornflakes", "müsli", "honig", "öl", "*öl", "essig", "balsamico", "backpulver", "zucker", "knödel", "sardellen", "dose", "suppe", "konserve", "hefe", "marmelade", "kakao", "polenta", "bulgur", "quinoa"]],
    ["kuehl",    ["joghurt", "skyr", "quark", "käse", "gouda", "feta", "parmesan", "mozzarella", "butter", "sahne", "milch", "eier", "ei", "tofu", "wurst", "würst", "speck", "hack", "tortellini", "spätzle", "schinken", "aufschnitt", "margarine", "hummus"]],
    ["brot",     ["brot", "toast", "brötchen", "brezel", "baguette", "croissant", "kuchen", "wrap"]],
    ["obst",     ["obst", "gemüse", "banane", "apfel", "äpfel", "kiwi", "zitrone", "limette", "beere", "avocado", "tomate", "paprika", "kartoffel", "möhre", "karotte", "zucchini", "lauch", "zwiebel", "knoblauch", "pilz", "sellerie", "salat", "spinat", "petersilie", "basilikum", "kräuter", "gurke", "brokkoli", "ingwer", "orange", "mandarine", "traube", "birne", "melone", "mango", "aubergine", "kohl", "radieschen", "rucola"]]
  ];
  const WORD = /[a-z0-9äöüß]+/g;
  function guessGroup(name) {
    const n = String(name || "").toLowerCase();
    const words = n.match(WORD) || [];
    for (const [id, keys] of RULES) {
      for (const k of keys) {
        const hit = k[0] === "*" ? words.some(w => w.endsWith(k.slice(1))) : k.length <= 3 ? words.includes(k) : n.includes(k);
        if (hit) return id;
      }
    }
    return "sonst";
  }
  const ORDER = {}; GROUPS.forEach((g, i) => ORDER[g.id] = i);
  function groupOf(item) { return (item && item.cat && ORDER[item.cat] != null) ? item.cat : guessGroup(item && item.name); }
  const api = { GROUPS, ORDER, guessGroup, groupOf, groupName: id => (GROUPS.find(g => g.id === id) || GROUPS[GROUPS.length - 1]).name };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Groups = api;
})(typeof self !== "undefined" ? self : this);
