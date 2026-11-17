// Angebote, Ladenvergleich, Preisverlauf und Preiswecker.
(function(){
"use strict";
const A = window.App, S = A.S, esc = A.esc, $ = A.$;
const P = { data:null, latest:null, err:"", tab:"offers", cmpStore:"", openShop:"", loading:false, at:0 };

/* ---------- Hilfen ---------- */
const eur = c => (c<0?"−":"")+(Math.abs(c)/100).toFixed(2).replace(".",",")+" €";
const WDS = ["So","Mo","Di","Mi","Do","Fr","Sa"];
function dayText(iso){ const m=String(iso||"").match(/^(\d{4})-(\d{2})-(\d{2})/); if(!m) return ""; const d=new Date(+m[1],+m[2]-1,+m[3]); return WDS[d.getDay()]+" "+(+m[3])+"."+(+m[2])+"."; }
function shortDate(iso){ const m=String(iso||"").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? (+m[3])+"."+(+m[2])+"."+m[1].slice(2) : ""; }
const itemById = id => S.items.find(i=>i.id===id);
function allShops(){ const out=[]; A.stores().forEach(s=>(s.labels||[]).forEach(l=>{ if(!out.some(x=>x.toLowerCase()===l.toLowerCase())) out.push(l); })); return out; }
const today = () => (P.data && P.data.today) || new Date().toISOString().slice(0,10);
const isNow = o => o.from<=today() && o.to>=today();
// alle aktuellen/kommenden Angebote eines Artikels
const offersOf = id => P.data ? P.data.offers.filter(o=>o.itemId===id) : [];
// Bio bevorzugt: gibt es Bio, zählt das günstigste Bio-Angebot, sonst das günstigste überhaupt
// Vergleich nach Grundpreis (je kg, l, Stück); fehlt er, nach Packungspreis. Verschiedene Einheiten: Grundpreis vor ohne.
function byUnit(a,b){
  if(a.refPrice && b.refPrice && a.refUnit===b.refUnit) return a.refPrice-b.refPrice || a.price-b.price;
  if(a.refPrice && !b.refPrice) return -1; if(b.refPrice && !a.refPrice) return 1;
  return a.price-b.price;
}
// das verhältnismäßig günstigste Angebot (Grundpreis); Bio ist nur ein Kennzeichen
function pick(list){ return list.length ? list.slice().sort(byUnit)[0] : null; }
function bestNow(id, shop){ return pick(offersOf(id).filter(o=>isNow(o) && (!shop || o.shop===shop))); }
// Angebot für genau das, was ihr laut Kassenzettel schon gekauft habt?
// Wörter auf dem Bon, die nur den Artikel beschreiben (Name, Suchbegriff), sagen nichts über die Sorte.
// - Gleiches Geschäft: passt, wenn der Bon nichts darüber hinaus sagt (z. B. „K.champignons“) oder Sorte/Marke im Angebot steht.
// - Anderes Geschäft: nur, wenn die Marke des Angebots auf dem Bon steht (Eigenmarken unterscheiden sich je Geschäft).
function knownVariant(o){
  const raws=(P.data && P.data.bought && P.data.bought[o.itemId])||[]; if(!raws.length || !window.Receipts) return false;
  const T=window.Receipts._test, it=itemById(o.itemId); if(!it) return false;
  const w=(P.data.watch||{})[o.itemId]||{};
  const plain=T.toks(it.name+" "+(w.query||"")), offT=T.toks([o.brand,o.title].join(" "));
  const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
  return raws.some(b=>{
    const sortW=T.toks(b.raw).filter(r=>!plain.some(n=>T.tokMatch(r,n)));
    if(same(b.shop, o.shop)) return !sortW.length || sortW.filter(r=>offT.some(t=>T.tokMatch(r,t))).length/sortW.length>=0.66;
    // anderes Geschäft: nur wenn die Marke auf dem Bon steht (z. B. „OATLY HAFERDR.“)
    const brandT=T.toks(o.brand||"");
    return brandT.length>0 && sortW.some(r=>brandT.some(t=>T.tokMatch(r,t)));
  });
}
function offerTitle(o){ const t=o.title||""; return (o.brand && !t.toLowerCase().includes(o.brand.toLowerCase()) ? o.brand+" " : "")+t; }
function validText(o){ return o.from>today() ? "ab "+dayText(o.from) : "bis "+dayText(o.to); }
function refText(o){ return o.refPrice && o.refUnit && !(o.refUnit==="Stk" && o.refPrice===o.price) ? eur(o.refPrice)+"/"+o.refUnit : ""; }

/* ---------- Laden ---------- */
async function load(force){
  if(P.loading || (!force && Date.now()-P.at<5*60*1000 && P.data)) return;
  P.loading=true;
  try{
    const [o,l]=await Promise.all([A.api("GET","/api/offers"), A.api("GET","/api/prices/latest")]);
    P.data=o; P.latest=l.prices; P.err=""; P.at=Date.now();
  }catch(e){ P.err=e.message||"Angebote konnten nicht geladen werden."; }
  P.loading=false;
  if(S.view==="prices") draw();
  else if(S.view==="list" && !$("modal").innerHTML) A.render();
}

/* ---------- Hinweis in der Liste ---------- */
function badge(id){
  if(!P.data) return "";
  const W=(P.data.watch||{})[id]; if(!W || !(W.search||W.alarm)) return "";
  const icons='<span class="ofi" title="'+(W.alarm?'Preiswecker an':'Angebote suchen an')+'">'+ICON_TAG+(W.alarm?ICON_BELL:'')+'</span>';
  const now=bestNow(id); const soon=!now && pick(offersOf(id).filter(o=>o.from>today()));
  const o=now||soon;
  if(!o) return '<span class="ofb off">'+icons+(W.checkedAt?'kein Angebot':'wird gesucht …')+'</span>';
  const shops=new Set(offersOf(id).map(x=>x.shop)).size;
  return '<span class="ofb">'+icons+(soon?'ab '+esc(dayText(o.from).split(" ")[0])+': ':'')+esc(o.shop)+' '+eur(o.price)+(o.bio?' · Bio':'')+(shops>1?' · +'+(shops-1):'')+'</span>';
}
/* ---------- Ansicht ---------- */
function open(tab){ S.view="prices"; if(tab) P.tab=tab; window.scrollTo(0,0); draw(); load(true); }
function head(){
  $("head").innerHTML='<div class="title"><button class="backbtn" data-pr="close">‹ Liste</button><h1 class="sttitle">Preise</h1><span style="width:64px"></span></div>'+
    '<div class="seg3 seg2"><button class="'+(P.tab==="offers"?'on':'')+'" data-pr="tab" data-k="offers">Angebote</button><button class="'+(P.tab==="compare"?'on':'')+'" data-pr="tab" data-k="compare">Ladenvergleich</button></div>';
}
function draw(){
  if(S.view!=="prices") return;
  head();
  const app=$("app");
  if(P.err && !P.data){ app.innerHTML='<div class="empty">'+esc(P.err)+'<br><button class="linkbtn" data-pr="reload">Nochmal versuchen</button></div>'; return; }
  if(!P.data){ app.innerHTML='<div class="empty"><div class="spin"></div>Angebote werden geladen …</div>'; return; }
  app.innerHTML = P.tab==="compare" ? compareHtml() : offersHtml();
}
function offerRow(o){
  return '<div class="ofr'+(knownVariant(o)?' known':'')+'"><div class="ofl"><b>'+esc(o.shop)+'</b> '+esc(offerTitle(o))+(o.bio?' <span class="bio">Bio</span>':'')+(knownVariant(o)?' <span class="kn">schon gekauft</span>':'')+
    '<small>'+[o.amount, validText(o)].filter(Boolean).map(esc).join(" · ")+'</small></div>'+
    '<div class="ofp">'+eur(o.price)+(refText(o)?'<em>'+esc(refText(o))+'</em>':'')+(o.oldPrice && o.oldPrice>o.price?'<s>'+eur(o.oldPrice)+'</s>':'')+'</div></div>';
}
function itemOffersCard(it, list, extra){
  const sorted=list.slice().sort((a,b)=>(a.from>today())-(b.from>today()) || knownVariant(b)-knownVariant(a) || byUnit(a,b));
  const best=pick(sorted.filter(isNow));
  return '<div class="ofcard"><button class="ofh" data-pr="item" data-id="'+esc(it.id)+'"><b>'+esc(it.name)+'</b><span>'+(extra||'')+(best?'bestes: '+esc(best.shop)+' '+(refText(best)||eur(best.price)):'')+'</span>'+A.PEN+'</button>'+
    sorted.slice(0,6).map(offerRow).join("")+(sorted.length>6?'<div class="small" style="padding:6px 14px 10px">und '+(sorted.length-6)+' weitere</div>':'')+'</div>';
}
function offersHtml(){
  const cfg=P.data.config, W=P.data.watch||{};
  let h='<div class="small" style="margin:0 4px 10px">Prospekt-Angebote für <b>'+esc(cfg.zip)+'</b>: '+(cfg.shops.length?cfg.shops.map(s=>esc(s)+(cfg.zipByShop[s]?' ('+esc(cfg.zipByShop[s])+')':'')).join(", "):'noch keine Geschäfte gewählt')+
    ' · <button class="linkbtn inl" data-pr="config">ändern</button></div>';
  if(!cfg.shops.length) return h+'<div class="list"><div class="empty">Wähle die Geschäfte in eurer Nähe aus. Danach markierst du die Artikel, für die die App Angebote suchen soll.<br><button class="btn" style="margin-top:12px" data-pr="config">Geschäfte auswählen</button></div></div>';
  const marked=S.items.filter(i=>W[i.id] && (W[i.id].search||W[i.id].alarm)).sort((a,b)=>(a.done-b.done) || a.name.localeCompare(b.name,"de"));
  h+='<button class="btn block" id="pr_refresh" data-pr="refresh"'+(P.refreshing||!marked.length?' disabled':'')+'>'+(P.refreshing?esc(P.refreshing):'Neue Angebote suchen')+'</button>';
  if(!marked.length) return h+'<div class="list"><div class="empty">Noch kein Artikel markiert.<br><span class="small">Tippe in der Liste beim Artikel auf den Stift und schalte <b>„Angebote suchen“</b> ein. Dann sucht die App nach genau diesem Artikel – so, wie er bei „Angebote suchen als“ steht.</span></div></div>';
  const withOffers=marked.filter(i=>offersOf(i.id).length);
  const pending=marked.filter(i=>!W[i.id].checkedAt).length;
  h+='<div class="sec"><b>Markierte Artikel · '+marked.length+'</b><span>'+(pending?pending+' noch nicht gesucht':'alle gesucht')+'</span></div>';
  const head=i=>{ const w=W[i.id]; return (w.alarm?'<span class="ofi">'+ICON_BELL+'</span>'+(w.alarmMax!=null?'bis '+eur(w.alarmMax)+' · ':''):'')+(i.done?'nicht auf der Liste · ':''); };
  if(withOffers.length) h+=withOffers.map(i=>itemOffersCard(i, offersOf(i.id), head(i))).join("");
  else h+='<div class="list"><div class="empty">'+(pending?'Die Suche läuft – das dauert ein paar Minuten.':'Für eure markierten Artikel gibt es gerade keine Angebote.')+'</div></div>';
  const none=marked.filter(i=>W[i.id].checkedAt && !offersOf(i.id).length);
  if(none.length) h+='<div class="small" style="margin:14px 4px 0"><b>Ohne Angebot:</b> '+none.map(i=>'<button class="linkbtn inl" data-pr="item" data-id="'+esc(i.id)+'">'+esc(i.name)+(W[i.id].query?' („'+esc(W[i.id].query)+'“)':'')+'</button>').join(", ")+'</div>';
  h+='<div class="small" style="margin:14px 4px 0">Quelle: marktguru (Prospekte). Gesucht wird nur für markierte Artikel, etwa alle 8 Stunden von selbst, mit dem Knopf oben sofort. Passt ein Treffer nicht, tippe auf den Artikel und ändere „Angebote suchen als“. Oben steht die Sorte, die ihr laut Kassenzettel schon gekauft habt („schon gekauft“), danach geht es nach Grundpreis (je kg, Liter oder Stück). Bio ist gekennzeichnet.</div>';
  return h;
}

/* ---------- Auf Knopfdruck alles neu suchen ---------- */
async function refreshAll(){
  if(P.refreshing) return;
  P.refreshing="Suche läuft …"; draw();
  let start=true, n=0, err="";
  try{
    while(n<40){
      const r=await A.api("POST","/api/offers/refresh",{start, again:start});
      start=false; n++;
      P.refreshing="Suche läuft … "+r.done+" von "+r.total+" geprüft"; const b=$("pr_refresh"); if(b) b.textContent=P.refreshing;
      if(!r.remaining) break;
    }
  }catch(e){ err=e.message; }
  P.refreshing=""; P.at=0; await load(true);
  A.toast(err || "Angebote sind auf dem neuesten Stand");
}

/* ---------- Ladenvergleich ---------- */
// Preis eines Artikels in einem Geschäft: aktuelles Angebot, sonst letzter Kassenzettel-Preis
function priceAt(it, shop){
  const o=bestNow(it.id, shop); if(o) return {price:o.price, src:"offer", o};
  const l=(P.latest||[]).find(x=>x.itemId===it.id && x.shop===shop);
  if(l){ const p = l.unit==="kg" ? l.price : Math.round(l.price/Math.max(1,l.qty)); return {price:p, src:"bon", at:l.at}; }
  return null;
}
function median(a){ const s=a.slice().sort((x,y)=>x-y), m=s.length>>1; return s.length%2?s[m]:Math.round((s[m-1]+s[m])/2); }
function compareHtml(){
  const cfg=P.data.config;
  const nearStores=A.stores().filter(s=>(s.labels||[]).some(l=>cfg.shops.includes(l)));
  if(!nearStores.length) return '<div class="list"><div class="empty">Wähle zuerst unter „Angebote“ die Geschäfte in eurer Nähe aus.<br><button class="btn" style="margin-top:12px" data-pr="config">Geschäfte auswählen</button></div></div>';
  if(!nearStores.some(s=>s.id===P.cmpStore)) P.cmpStore=(nearStores.find(s=>s.id===S.cur)||nearStores[0]).id;
  const store=nearStores.find(s=>s.id===P.cmpStore);
  const shops=(store.labels||[]).filter(l=>cfg.shops.includes(l));
  const items=S.items.filter(i=>!i.done && i.store===store.id).sort((a,b)=>a.name.localeCompare(b.name,"de"));
  let h='<div class="chips" style="margin:0 0 12px">'+nearStores.map(s=>'<button data-pr="cmpstore" data-k="'+esc(s.id)+'" class="'+(s.id===store.id?'on':'')+'">'+esc(s.name)+'</button>').join("")+'</div>';
  if(!items.length) return h+'<div class="list"><div class="empty">Bei '+esc(store.name)+' steht gerade nichts auf der Liste.</div></div>';
  // Tabelle Artikel × Geschäft
  const grid=items.map(it=>{ const row={it, at:{}}; shops.forEach(s=>row.at[s]=priceAt(it,s)); const known=shops.map(s=>row.at[s]).filter(Boolean).map(x=>x.price);
    row.est=known.length?median(known):null;
    // günstigstes Geschäft für diese Sache: nach Grundpreis, wenn alle Preise Angebote mit derselben Einheit sind, sonst nach Preis
    const ps=shops.map(s=>({s,p:row.at[s]})).filter(x=>x.p);
    const unitOk=ps.length>1 && ps.every(x=>x.p.o && x.p.o.refPrice && x.p.o.refUnit===ps[0].p.o.refUnit);
    const key=x=>unitOk?x.p.o.refPrice:x.p.price;
    const win=ps.slice().sort((a,b)=>key(a)-key(b))[0];
    row.minShop=win?win.s:null; row.min=win?win.p.price:null; return row; });
  const noPrice=grid.filter(r=>r.est==null);
  const res=shops.map(s=>{ let sum=0, known=0, offers=0, est=0;
    grid.forEach(r=>{ const p=r.at[s]; if(p){ sum+=p.price; known++; if(p.src==="offer") offers++; } else if(r.est!=null){ sum+=r.est; est++; } });
    return {shop:s, sum, known, offers, est}; }).filter(x=>x.known>0).sort((a,b)=>a.sum-b.sum);
  const priced=grid.length-noPrice.length;
  h+='<div class="small" style="margin:0 4px 10px">'+items.length+' Sachen auf der Liste, für '+priced+' gibt es Preise. Gerechnet wird mit dem aktuellen Angebot, sonst mit dem letzten Kassenzettel-Preis im jeweiligen Geschäft.</div>';
  if(!res.length) return h+'<div class="list"><div class="empty">Noch keine Preise für diese Sachen.<br><span class="small">Preise kommen aus Angeboten und aus euren Kassenzetteln.</span></div></div>';
  h+='<div class="list">'+res.map((r,ix)=>{
    const openS=P.openShop===r.shop;
    let x='<button class="cmprow'+(ix===0&&res.length>1?' best':'')+'" data-pr="shop" data-k="'+esc(r.shop)+'"><span><b>'+esc(r.shop)+'</b><small>'+r.known+' von '+priced+' Preisen bekannt'+(r.offers?' · '+r.offers+' im Angebot':'')+'</small></span><span class="cmpsum">'+(r.est?'~':'')+eur(r.sum)+'</span></button>';
    if(openS) x+='<div class="cmpdet">'+grid.filter(g=>g.est!=null).map(g=>{ const p=g.at[r.shop];
      const v=p?p.price:g.est, src=p?(p.src==="offer"?'Angebot '+validText(p.o):'Bon '+shortDate(p.at)):'geschätzt';
      const rt=p&&p.o?refText(p.o):"";
      return '<div class="cmpi'+(p&&g.minShop===r.shop&&res.length>1?' low':'')+(p?'':' est')+'"><span>'+esc(g.it.name)+'<small>'+esc(src)+(rt?' · '+esc(rt):'')+'</small></span><b>'+(p?'':'~')+eur(v)+'</b></div>'; }).join("")+'</div>';
    return x; }).join("")+'</div>';
  // günstigster Mix: jede Sache dort, wo sie am wenigsten kostet
  const mix=grid.filter(g=>g.minShop).map(g=>({g, shop:g.minShop, price:g.min}));
  if(mix.length && res.length>1){
    const by=new Map(); mix.forEach(m=>{ if(!by.has(m.shop)) by.set(m.shop,[]); by.get(m.shop).push(m); });
    const total=mix.reduce((a,m)=>a+m.price,0);
    h+='<div class="card-s" style="margin-top:14px"><div class="ch"><b>Günstigster Mix</b><span>'+eur(total)+' für '+mix.length+' Sachen</span></div>'+
      [...by].map(([shop,l])=>'<div class="mixr"><b>'+esc(shop)+'</b> '+l.map(m=>esc(m.g.it.name)).join(", ")+'</div>').join("")+'</div>';
  }
  if(noPrice.length) h+='<div class="small" style="margin:12px 4px 0"><b>Noch ohne Preis:</b> '+noPrice.map(r=>esc(r.it.name)).join(", ")+'</div>';
  h+='<div class="small" style="margin:12px 4px 0">„~“ = geschätzt: Fehlt in einem Geschäft ein Preis, zählt der mittlere Preis aus den anderen. Packungsgrößen können sich unterscheiden. Je mehr Kassenzettel, desto genauer.</div>';
  return h;
}

/* ---------- Geschäfte & PLZ ---------- */
function openConfig(){
  const cfg=P.data.config; let sel=cfg.shops.slice(); const zipBy=Object.assign({},cfg.zipByShop);
  const all=allShops(); cfg.shops.forEach(s=>{ if(!all.includes(s)) all.push(s); });
  const body=()=>'<h3>Geschäfte in der Nähe</h3>'+
    '<label class="f"><span>Postleitzahl</span><input id="pc_zip" inputmode="numeric" maxlength="5" value="'+esc(cfg.zip)+'"></label>'+
    '<div class="small" style="margin:0 0 6px">Antippen zum An- und Abwählen (Geschäfte = Labels aus „Läden & Labels“):</div>'+
    '<div class="chips" id="pc_shops">'+all.map(s=>'<button data-s="'+esc(s)+'" class="'+(sel.includes(s)?'on':'')+'">'+esc(s)+'</button>').join("")+'</div>'+
    (sel.length?'<div class="small" style="margin:14px 0 6px">Andere Postleitzahl für ein Geschäft (z. B. Filiale bei der Arbeit), sonst leer lassen:</div>'+
      '<div class="zipgrid">'+sel.map(s=>'<label>'+esc(s)+'<input data-z="'+esc(s)+'" inputmode="numeric" maxlength="5" placeholder="'+esc(cfg.zip)+'" value="'+esc(zipBy[s]||"")+'"></label>').join("")+'</div>':'')+
    '<div class="acts"><button class="btn ghost" id="pc_x">Abbrechen</button><button class="btn" id="pc_ok">Speichern</button></div>';
  const m=A.sheet(body());
  const bind=()=>{
    m.querySelectorAll("#pc_shops button").forEach(b=>b.onclick=()=>{ const s=b.dataset.s; collect(); sel=sel.includes(s)?sel.filter(x=>x!==s):sel.concat([s]); m.querySelector(".sheet").innerHTML=body(); bind(); });
    $("pc_x").onclick=A.closeModal;
    $("pc_ok").onclick=async()=>{ collect(); const zip=$("pc_zip").value.trim();
      try{ await A.api("POST","/api/offers/config",{zip, shops:sel, zipByShop:zipBy}); A.closeModal(); A.toast("Gespeichert – die Angebote werden jetzt neu gesucht"); P.at=0; load(true); }
      catch(e){ A.toast(e.message); } };
  };
  const collect=()=>{ m.querySelectorAll("[data-z]").forEach(i=>{ const v=i.value.trim(); if(/^\d{5}$/.test(v)) zipBy[i.dataset.z]=v; else delete zipBy[i.dataset.z]; }); const z=$("pc_zip"); if(z) cfg.zip=z.value.trim()||cfg.zip; };
  bind();
}

/* ---------- Im Bearbeiten-Dialog: Angebote, bezahlte Preise, Suchbegriff, Preiswecker ---------- */
async function editSection(id, el){
  if(!el) return;
  if(!P.data) await load(true);
  let hist; try{ hist=await A.api("GET","/api/prices?id="+encodeURIComponent(id)); }catch(e){ hist={prices:[],offers:[]}; }
  if(!document.body.contains(el)) return;
  const it=itemById(id); if(!it) return;
  const W=(P.data&&P.data.watch||{})[id]||{};
  const cur=offersOf(id).slice().sort((a,b)=>(a.from>today())-(b.from>today()) || knownVariant(b)-knownVariant(a) || byUnit(a,b));
  const per=new Map(); for(const p of hist.prices) if(!per.has(p.shop)) per.set(p.shop,p);
  const val=p=>p.unit==="kg" ? p.unitPrice : Math.round(p.price/Math.max(1,p.qty));
  const paid=[...per.values()].sort((a,b)=>val(a)-val(b));
  let h='';
  if(cur.length) h+='<div class="small" style="margin:0 0 5px">Angebote</div><div class="prices ofin">'+cur.slice(0,4).map(offerRow).join("")+'</div>';
  if(paid.length) h+='<div class="small" style="margin:10px 0 5px">Zuletzt bezahlt</div><div class="prices">'+paid.map((p,i)=>'<div class="prow'+(i===0&&paid.length>1?' best':'')+'"><span>'+esc(p.shop)+'<small>'+esc(shortDate(p.at))+(p.discount?' · mit Rabatt':'')+'</small></span><b>'+eur(val(p))+(p.unit==="kg"?'/kg':'')+'</b></div>').join("")+'</div>';
  if(hist.prices.length+hist.offers.length>=2) h+='<button class="linkbtn" id="pv_open">Preisverlauf ansehen</button>';
  // Angebote suchen (nur für markierte Artikel) und Preiswecker
  const on=!!(W.search||W.alarm);
  const sw=(id,chk,title,sub)=>'<label class="sw'+(chk?' on':'')+'"><input type="checkbox" id="'+id+'"'+(chk?' checked':'')+'><span class="swt"><b>'+title+'</b><small>'+sub+'</small></span><span class="swst">'+(chk?'An':'Aus')+'</span><span class="swk"></span></label>';
  // erst den Suchbegriff prüfen, dann einschalten
  h+='<div class="pset"><label class="f"><span>Angebote suchen als'+(on?'':' – erst prüfen, dann einschalten')+'</span><input id="pv_q" maxlength="60" value="'+esc(W.query||it.name)+'"></label>'+
    sw("pv_on", on, ICON_TAG+' Angebote suchen', on?'Die App sucht in den Prospekten nach dem Begriff oben':'Aus – für diesen Artikel wird nicht gesucht')+
    (on?sw("pv_al", !!W.alarm, ICON_BELL+' Preiswecker', W.alarm?'Nachricht aufs Handy, sobald es ein Angebot gibt':'Zusätzlich eine Nachricht aufs Handy bei Angebot')+
      (W.alarm?'<label class="f"><span>nur bis höchstens (€, leer = jedes Angebot)</span><input id="pv_max" inputmode="decimal" value="'+(W.alarmMax!=null?esc((W.alarmMax/100).toFixed(2).replace(".",",")):"")+'"></label>':'')+
      '<div class="small">'+(W.checkedAt?'Zuletzt gesucht: '+esc(new Date(W.checkedAt).toLocaleString("de-DE",{weekday:"short",hour:"2-digit",minute:"2-digit"})):'Wird gleich gesucht')+'</div>':'')+'</div>';
  el.innerHTML=h;
  if($("pv_open")) $("pv_open").onclick=()=>openHistory(it, hist);
  const save=async(body, after)=>{
    try{
      const r=await A.api("POST","/api/offers/watch",Object.assign({itemId:id, person:S.me||""},body));
      if(P.data){ P.data.watch=P.data.watch||{}; P.data.watch[id]=Object.assign({},W,{query:r.auto?"":r.query, search:r.search, alarm:r.alarm, alarmMax:body.alarmMax!==undefined?body.alarmMax:W.alarmMax}); }
      if(after==="search" && r.search){ A.toast("Suche läuft …"); await A.api("POST","/api/offers/check",{itemId:id}).catch(e=>A.toast(e.message)); P.at=0; await load(true); }
      else if(after==="alarm") A.toast(r.alarm?"Preiswecker an"+(S.pushOn?"":" – Benachrichtigungen in den Einstellungen einschalten"):"Preiswecker aus");
      else if(after==="off"){ A.toast("Angebote suchen aus"); P.at=0; await load(true); }
      if(document.body.contains(el)) editSection(id, el);
    }catch(e){ A.toast(e.message); }
  };
  const qv=()=>($("pv_q").value.trim()||it.name).slice(0,60);
  $("pv_on").addEventListener("change",e=>{ if(e.target.checked) save({search:true, query:qv()}, "search"); else save({search:false, alarm:false}, "off"); });
  // Begriff ändern: bei eingeschalteter Suche sofort neu suchen, sonst nur merken
  $("pv_q").addEventListener("change",()=>{ if(on) save({query:qv()}, "search"); else save({query:qv()}); });
  if($("pv_al")) $("pv_al").addEventListener("change",e=>save({alarm:e.target.checked}, "alarm"));
  if($("pv_max")) $("pv_max").addEventListener("change",e=>{ const mx=e.target.value.trim(); const max = mx ? Math.round(parseFloat(mx.replace(",","."))*100) : null;
    if(mx && !(max>0)){ A.toast("Bitte einen Preis wie 1,49 eingeben"); return; } save({alarmMax:max}); });
}
const ICON_TAG='<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12V4h8l9 9-8 8z"/><circle cx="7.5" cy="8.5" r="1.4"/></svg>';
const ICON_BELL='<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>';

/* ---------- Preisverlauf ---------- */
// feste Farbe je Geschäft (Reihenfolge der Labels), damit ein Geschäft immer gleich aussieht
function shopSlot(shop){ const i=allShops().findIndex(s=>s.toLowerCase()===String(shop).toLowerCase()); return (i<0?7:i%8)+1; }
function openHistory(it, hist){
  // Werte vergleichbar machen: je Stück bzw. je kg (lose Ware)
  const kg=hist.prices.some(p=>p.unit==="kg");
  const pts=[];
  hist.prices.forEach(p=>{ const v = p.unit==="kg" ? p.unitPrice : Math.round(p.price/Math.max(1,p.qty)); if(kg && p.unit!=="kg") return;
    pts.push({t:new Date(String(p.at).slice(0,10)+"T12:00:00").getTime(), v, shop:p.shop, src:"bon", label:shortDate(p.at)}); });
  hist.offers.forEach(o=>{ const v = kg ? (o.refUnit==="kg" ? o.refPrice : null) : o.price; if(v==null || !o.from) return;
    pts.push({t:new Date(o.from+"T12:00:00").getTime(), t2:new Date((o.to||o.from)+"T12:00:00").getTime(), v, shop:o.shop, src:"offer", label:shortDate(o.from)+"–"+shortDate(o.to), o}); });
  pts.sort((a,b)=>a.t-b.t);
  const shops=[...new Set(pts.map(p=>p.shop))].sort((a,b)=>shopSlot(a)-shopSlot(b));
  const W=340, H=190, L=44, R=10, T=12, B=26;
  let h='<h3>Preisverlauf: '+esc(it.name)+'</h3><div class="small" style="margin:-4px 0 8px">'+(kg?'Preis je kg':'Preis je Stück bzw. Packung')+' · ● Kassenzettel · ━ Angebot</div>';
  if(pts.length<1){ h+='<div class="empty">Noch keine Preise.</div>'; }
  else {
    const t0=Math.min(...pts.map(p=>p.t)), t1=Math.max(Date.now(), ...pts.map(p=>p.t2||p.t)), span=Math.max(86400000, t1-t0);
    const vmax=Math.max(...pts.map(p=>p.v)), vmin=Math.min(...pts.map(p=>p.v));
    const lo=Math.max(0, Math.floor((vmin*0.85)/10)*10), hi=Math.ceil((vmax*1.08)/10)*10 || 10;
    const X=t=>L+(t-t0)/span*(W-L-R), Y=v=>T+(1-(v-lo)/Math.max(1,hi-lo))*(H-T-B);
    let svg='<svg class="pvsvg" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Preisverlauf">';
    // Raster: 3 Linien mit Beschriftung
    for(let k=0;k<=2;k++){ const v=lo+(hi-lo)*k/2, y=Y(v); svg+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y+'" y2="'+y+'" class="pvgrid"/><text x="'+(L-6)+'" y="'+(y+4)+'" class="pvax" text-anchor="end">'+(v/100).toFixed(2).replace(".",",")+'</text>'; }
    const d0=new Date(t0), d1=new Date(t1);
    svg+='<text x="'+L+'" y="'+(H-6)+'" class="pvax">'+d0.getDate()+'.'+(d0.getMonth()+1)+'.'+String(d0.getFullYear()).slice(2)+'</text><text x="'+(W-R)+'" y="'+(H-6)+'" class="pvax" text-anchor="end">heute</text>';
    shops.forEach(s=>{
      const c='var(--s'+shopSlot(s)+')';
      const bons=pts.filter(p=>p.shop===s && p.src==="bon");
      if(bons.length>1) svg+='<polyline fill="none" stroke="'+c+'" stroke-width="2" stroke-linejoin="round" points="'+bons.map(p=>X(p.t).toFixed(1)+","+Y(p.v).toFixed(1)).join(" ")+'"/>';
      pts.filter(p=>p.shop===s && p.src==="offer").forEach(p=>{ svg+='<line x1="'+X(p.t).toFixed(1)+'" x2="'+Math.max(X(p.t)+4,X(p.t2)).toFixed(1)+'" y1="'+Y(p.v).toFixed(1)+'" y2="'+Y(p.v).toFixed(1)+'" stroke="'+c+'" stroke-width="4" stroke-linecap="round"/>'; });
      bons.forEach(p=>{ svg+='<circle cx="'+X(p.t).toFixed(1)+'" cy="'+Y(p.v).toFixed(1)+'" r="4.5" fill="'+c+'" stroke="var(--card)" stroke-width="2"/>'; });
    });
    svg+='</svg>';
    h+='<div class="pvroot">'+svg+'<div class="pvleg">'+shops.map(s=>'<span><i style="background:var(--s'+shopSlot(s)+')"></i>'+esc(s)+'</span>').join("")+'</div></div>';
    // Tabelle zum Nachlesen
    h+='<div class="prices pvtab">'+pts.slice().reverse().map(p=>'<div class="prow"><span><i class="pvdot" style="background:var(--s'+shopSlot(p.shop)+')"></i>'+esc(p.shop)+'<small>'+esc(p.label)+' · '+(p.src==="bon"?'Kassenzettel':'Angebot')+'</small></span><b>'+eur(p.v)+(kg?'/kg':'')+'</b></div>').join("")+'</div>';
  }
  h+='<div class="acts"><button class="btn" id="pv_x">Schließen</button></div>';
  A.sheet(h); $("pv_x").onclick=A.closeModal;
}

/* ---------- Ereignisse ---------- */
document.addEventListener("click",e=>{
  const b=e.target.closest("[data-pr]"); if(!b || S.view!=="prices" || $("modal").contains(b)) return;
  const k=b.dataset.pr;
  if(k==="close") A.close();
  else if(k==="tab"){ P.tab=b.dataset.k; draw(); window.scrollTo(0,0); }
  else if(k==="reload") load(true);
  else if(k==="refresh") refreshAll();
  else if(k==="config") openConfig();
  else if(k==="cmpstore"){ P.cmpStore=b.dataset.k; P.openShop=""; draw(); }
  else if(k==="shop"){ P.openShop = P.openShop===b.dataset.k ? "" : b.dataset.k; draw(); }
  else if(k==="item") A.openEdit(b.dataset.id);
});
// beim Start und danach alle 10 Minuten (Angebote ändern sich selten)
setTimeout(()=>load(), 1500);
setInterval(()=>{ if(!document.hidden) load(); }, 10*60*1000);
if(/[?&]angebote\b/.test(location.search)) setTimeout(()=>open("offers"), 300);

window.Prices = { open, render: draw, badge, editSection, load, _P:P };
})();
