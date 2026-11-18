// Kassenzettel: hochladen (PDF oder Foto), Zeilen den Artikeln zuordnen, speichern; Preise je Artikel.
(function(){
"use strict";
const A = window.App, S = A.S, esc = A.esc, $ = A.$;
const R = { mode:"list", list:null, err:"", busy:"", draft:null, detail:null, delArm:false };

/* ---------- Hilfen ---------- */
const eur = c => (c<0?"−":"")+(Math.abs(c)/100).toFixed(2).replace(".",",")+" €";
const WDS = ["So","Mo","Di","Mi","Do","Fr","Sa"];
function dateText(at){ const m=String(at||"").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); if(!m) return "";
  const d=new Date(+m[1],+m[2]-1,+m[3]); return WDS[d.getDay()]+" "+(+m[3])+"."+(+m[2])+"."+m[1].slice(2)+" · "+m[4]+":"+m[5]; }
function shortDate(at){ const m=String(at||"").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? (+m[3])+"."+(+m[2])+"."+m[1].slice(2) : ""; }
function nowLocal(){ const d=new Date(), p=n=>String(n).padStart(2,"0"); return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+"T"+p(d.getHours())+":"+p(d.getMinutes()); }
const qtyText = l => l.unit==="kg" ? (String(l.qty).replace(".",","))+" kg × "+eur(l.unitPrice)+"/kg" : (l.qty>1 ? l.qty+" × "+eur(l.unitPrice) : "");
const itemById = id => S.items.find(i=>i.id===id);
// alle Geschäfte (Labels) aus den Läden, z. B. Lidl, Rewe, dm
// Geschäfte zur Auswahl: alle Labels, dazu Läden ohne Labels selbst (z. B. „IKEA“) und eigene Eingaben
function allShops(extra){ const out=[]; const add=l=>{ if(l && !out.some(x=>x.toLowerCase()===String(l).toLowerCase())) out.push(l); };
  A.stores().forEach(s=>{ const ls=s.labels||[]; if(ls.length) ls.forEach(add); else add(s.name); });
  if(extra && !out.some(x=>x.toLowerCase()===extra.toLowerCase())) out.unshift(extra); return out; }
function storeForShop(shop){ const k=String(shop||"").toLowerCase();
  const s=A.stores().find(st=>(st.labels||[]).some(l=>l.toLowerCase()===k)) || A.stores().find(st=>st.name.toLowerCase()===k);
  return s ? s.id : (S.cur||A.stores()[0].id); }
function shopLabel(shop){ return allShops().find(l=>l.toLowerCase()===String(shop||"").toLowerCase()) || shop; }

/* ---------- Zuordnung Bon-Text → Artikel ---------- */
// Bon-Texte sind abgekürzt („KOERN.FRISCH“, „Lakt.fr.Naturjoghurt“); verglichen wird über Wortanfänge.
const STOPW = new Set(["bio","lose","vorger","fair","dmbio","dm","rewe","ja","gut","guenstig","penny","lidl","aldi","edeka","mark","stk","st","kg","g","ml","l","x","pf","neu","the","de","la","le","und","mit","von","fuer","fur","fr","ca","je","bioland","demeter","naturland","enerbio","alnatura","isana","balea"]);
function fold(s){ return String(s||"").toLowerCase().replace(/ä/g,"a").replace(/ö/g,"o").replace(/ü/g,"u").replace(/ß/g,"ss").replace(/([^aeiou])(ae|oe|ue)/g,(m,a,b)=>a+b[0]); }
function toks(s){
  return fold(s).replace(/[^a-z0-9]+/g," ").split(" ").filter(Boolean)
    .map(t=>/^lak(t|to)?/.test(t) ? "laktosefrei" : t)
    .filter(t=>!STOPW.has(t) && !/^\d/.test(t) && (t.length>=3 || t==="tk"));
}
// r = Wort vom Bon, t = Wort aus dem Artikelnamen
function tokMatch(r,t){
  if(r===t) return true;
  let p=0; while(p<r.length && p<t.length && r[p]===t[p]) p++;
  if(p===t.length) return r.length-t.length<=2;            // „kiwis“ ↔ „kiwi“; aber „tomatenmark“ ist kein „tomaten“
  if(p===r.length) return r.length>=4;                      // abgekürzt: „haferdr“ → „haferdrink“
  if(p>=4 && p>=0.6*Math.min(r.length,t.length)) return true;
  if(t.length>=5 && r.endsWith(t)) return true;             // „speisekartoffeln“ → „kartoffeln“
  if(r.length>=5 && t.endsWith(r)) return true;             // „lotion“ → „bodylotion“
  return false;
}
function score(rawT, item){
  const it=toks(item.name); if(!it.length || !rawT.length) return 0;
  const ic=it.filter(t=>rawT.some(r=>tokMatch(r,t))).length/it.length;
  const rc=rawT.filter(r=>it.some(t=>tokMatch(r,t))).length/rawT.length;
  return ic*0.75+rc*0.25;
}
function candidates(raw, store, limit){
  const rawT=toks(raw);
  return S.items.map(i=>({i, s:score(rawT,i)+(i.store===store?0.04:0)+Math.min(0.03,(i.buyCount||0)/1000)}))
    .filter(x=>x.s>0.3).sort((a,b)=>b.s-a.s).slice(0,limit||8);
}
// Vorschlag für den Namen eines neuen Artikels aus dem Bon-Text: „BIO KOERN.FRISCH“ → „Bio Koern. Frisch“
function niceName(raw){
  return String(raw).replace(/^\d+\s*/,"").replace(/\./g,". ").replace(/\s+/g," ").trim().toLowerCase()
    .replace(/(^|[\s-])([a-zäöü])/g,(m,a,b)=>a+b.toUpperCase()).slice(0,60);
}

/* ---------- Dateien lesen ---------- */
let pdfjs=null;
async function pdfText(file){
  if(!pdfjs){ pdfjs=await import("/vendor/pdf.min.mjs"); pdfjs.GlobalWorkerOptions.workerSrc="/vendor/pdf.worker.min.mjs"; }
  const doc=await pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
  const out=[];
  for(let p=1;p<=Math.min(doc.numPages,6);p++){
    const tc=await (await doc.getPage(p)).getTextContent(); const rows=[];
    for(const it of tc.items){ if(!it.str) continue; const y=it.transform[5], x=it.transform[4];
      let r=rows.find(r=>Math.abs(r.y-y)<2); if(!r) rows.push(r={y,parts:[]}); r.parts.push({x,s:it.str,w:it.width||0}); }
    rows.sort((a,b)=>b.y-a.y);
    for(const r of rows){ r.parts.sort((a,b)=>a.x-b.x); let line="", end=null;
      for(const q of r.parts){ if(end!==null && q.x-end>2) line+="  "; line+=q.s; end=q.x+q.w; } out.push(line); }
  }
  return out.join("\n");
}
// Foto vorbereiten: passende Breite; lange Bons (Screenshots) an hellen Stellen in Abschnitte teilen
async function prepImage(file){
  const img=await new Promise((ok,no)=>{ const u=URL.createObjectURL(file), im=new Image(); im.onload=()=>{ ok(im); }; im.onerror=()=>no(new Error("Das Bild konnte nicht geöffnet werden.")); im.src=u; });
  const W0=img.naturalWidth, H0=img.naturalHeight;
  const sc = W0<800 ? 800/W0 : W0>1100 ? 1100/W0 : 1;
  const W=Math.round(W0*sc), H=Math.round(H0*sc);
  const c=document.createElement("canvas"); c.width=W; c.height=H;
  const g=c.getContext("2d",{willReadFrequently:true}); g.fillStyle="#fff"; g.fillRect(0,0,W,H); g.drawImage(img,0,0,W,H);
  URL.revokeObjectURL(img.src);
  let chunkH=Math.round(W*1.5); if(H/chunkH>8) chunkH=Math.ceil(H/8);
  const cuts=[0];
  while(H-cuts[cuts.length-1]>chunkH*1.15){
    const target=cuts[cuts.length-1]+chunkH, from=Math.round(target-chunkH*0.25), to=Math.min(H-1,Math.round(target+chunkH*0.1));
    const data=g.getImageData(0,from,W,to-from).data; let best=target, bestDark=Infinity;
    for(let y=0;y<to-from;y++){ let dark=0; for(let x=0;x<W;x+=2){ const k=(y*W+x)*4; if(data[k]*0.3+data[k+1]*0.59+data[k+2]*0.11<150) dark++; }
      if(dark<bestDark || (dark===bestDark && Math.abs(from+y-target)<Math.abs(best-target))){ bestDark=dark; best=from+y; } }
    cuts.push(best);
  }
  cuts.push(H);
  const out=[];
  for(let i=0;i<cuts.length-1;i++){ const h=cuts[i+1]-cuts[i]; if(h<20) continue; const cc=document.createElement("canvas"); cc.width=W; cc.height=h;
    cc.getContext("2d").drawImage(c,0,cuts[i],W,h,0,0,W,h); out.push(cc.toDataURL("image/jpeg",0.85)); }
  return out;
}
async function handleFile(file){
  if(!file) return;
  const isPdf = file.type==="application/pdf" || /\.pdf$/i.test(file.name||"");
  R.err=""; R.mode="busy"; R.busy = isPdf ? "PDF wird gelesen …" : "Foto wird gelesen … das dauert etwa 10–30 Sekunden."; draw();
  try{
    let res;
    if(isPdf){ const text=await pdfText(file); if(!text.trim()) throw new Error("In diesem PDF steht kein lesbarer Text. Versuch es mit einem Foto oder Screenshot.");
      res=await A.api("POST","/api/receipt/parse",{text}); }
    else { if(file.size>25e6) throw new Error("Das Bild ist zu groß."); const images=await prepImage(file); res=await A.api("POST","/api/receipt/ocr",{images}); }
    if(!res.lines || !res.lines.length) throw new Error("Auf dem "+(isPdf?"PDF":"Foto")+" wurde kein Kassenzettel erkannt.");
    makeDraft(res, isPdf?"pdf":"foto");
  }catch(e){ R.mode="list"; R.err=e.message||"Hat nicht geklappt."; draw(); }
}
function makeDraft(res, source){
  const shop=res.shop ? shopLabel(res.shop) : "";
  const store=storeForShop(shop);
  const d={ shop, store, at:res.at||nowLocal(), total:res.total!=null?res.total:res.sum, source, tick:true, ocr:source==="foto", lines:[] };
  d.lines=res.lines.map(l=>{
    const x=Object.assign({},l,{itemId:"",newName:"",ignore:false,sugg:false});
    if(l.kind!=="item") return x;
    if(l.alias==="-"){ x.ignore=true; return x; }
    if(l.alias && itemById(l.alias)){ x.itemId=l.alias; return x; }
    const c=candidates(l.raw, store, 1)[0];
    if(c && c.s>=0.7){ x.itemId=c.i.id; x.sugg=true; }
    return x;
  });
  R.draft=d; R.mode="review"; draw(); window.scrollTo(0,0);
}

/* ---------- Anzeige ---------- */
function open(){ S.view="receipts"; R.mode="list"; R.err=""; window.scrollTo(0,0); draw(); loadList(); }
async function loadList(){ try{ const d=await A.api("GET","/api/receipts"); R.list=d.receipts; }catch(e){ R.err=e.message; } if(S.view==="receipts" && R.mode==="list") draw(); }
function head(title, back){
  $("head").innerHTML='<div class="title"><button class="backbtn" data-rc="'+back+'">‹ '+(back==="close"?"Liste":"Zurück")+'</button><h1 class="sttitle">'+esc(title)+'</h1><span style="width:64px"></span></div>';
}
function draw(){
  if(S.view!=="receipts") return;
  const app=$("app");
  if(R.mode==="busy"){ head("Kassenzettel","close"); app.innerHTML='<div class="empty"><div class="spin"></div>'+esc(R.busy)+'</div>'; return; }
  if(R.mode==="review") return drawReview();
  if(R.mode==="detail") return drawDetail();
  head("Kassenzettel","close");
  let h='<label class="btn block upl">Kassenzettel hinzufügen<input type="file" id="rc_file" accept="application/pdf,image/*"></label>'+
    '<div class="small" style="margin:2px 4px 14px">PDF aus der Rewe-, Penny-, dm- oder Rossmann-App, Screenshot aus Lidl Plus oder ein Foto vom Papierbon. Fotos werden nur gelesen und nicht gespeichert.</div>';
  if(R.err) h+='<div class="alert bad">'+esc(R.err)+'</div>';
  if(!R.list) h+='<div class="empty"><div class="spin"></div></div>';
  else if(!R.list.length) h+='<div class="list"><div class="empty">Noch keine Kassenzettel gespeichert.<br><span class="small">Aus jedem Bon merkt sich die App die Preise eurer Artikel – Laden für Laden.</span></div></div>';
  else {
    const sum=R.list.reduce((a,r)=>a+r.total,0);
    h+='<div class="sec"><b>Gespeichert · '+R.list.length+'</b><span>'+eur(sum)+'</span></div><div class="list">'+
      R.list.map(r=>'<button class="rcrow" data-rc="show" data-id="'+esc(r.id)+'"><span><b>'+esc(r.shop)+'</b><small>'+esc(dateText(r.at))+' · '+r.n+' Artikel'+(r.person?' · '+esc(r.person):'')+'</small></span><span class="rcp">'+eur(r.total)+'</span></button>').join("")+'</div>';
  }
  app.innerHTML=h;
  $("rc_file").onchange=e=>{ const f=e.target.files&&e.target.files[0]; e.target.value=""; handleFile(f); };
}
function lineHtml(l, ix, editable){
  const it=l.itemId && itemById(l.itemId);
  const det=[qtyText(l), l.discount?"Rabatt "+eur(-l.discount):"", l.ean?"EAN "+l.ean:""].filter(Boolean).join(" · ");
  let asg;
  if(l.kind==="pfand") asg='<span class="asg grey">Pfand</span>';
  else if(l.kind==="bag") asg='<span class="asg grey">Tasche</span>';
  else if(l.ignore || l.kind==="skip") asg='<span class="asg grey">ignoriert</span>';
  else if(it) asg='<span class="asg ok'+(l.sugg?' sugg':'')+'">→ '+esc(it.name)+(l.sugg?' ?':'')+'</span>';
  else if(l.newName) asg='<span class="asg ok">＋ neu: '+esc(l.newName)+'</span>';
  else asg='<span class="asg none">'+(editable?'zuordnen …':'—')+'</span>';
  const inner='<span class="rl1"><span class="rraw">'+esc(l.raw)+'</span><span class="rp">'+eur(l.price)+'</span></span>'+(det?'<span class="rdet">'+esc(det)+'</span>':'')+asg;
  return editable ? '<button class="rline" data-rc="line" data-ix="'+ix+'">'+inner+'</button>' : '<div class="rline">'+inner+'</div>';
}
function drawReview(){
  const d=R.draft; head("Prüfen","cancel");
  const sum=d.lines.reduce((a,l)=>a+l.price,0);
  const openHits=new Set(d.lines.filter(l=>l.itemId && !l.ignore).map(l=>itemById(l.itemId)).filter(i=>i && !i.done).map(i=>i.id));
  const unassigned=d.lines.filter(l=>l.kind==="item" && !l.itemId && !l.newName && !l.ignore).length;
  const suggs=d.lines.filter(l=>l.sugg).length;
  let h='<div class="card-s">'+
    '<div class="small" style="margin-bottom:6px">Geschäft'+(d.shop?'':' – bitte auswählen')+'</div><div class="chips" id="rc_shops">'+allShops(d.shop).map(l=>'<button data-rc="shop" data-k="'+esc(l)+'" class="'+(l===d.shop?'on':'')+'">'+esc(l)+'</button>').join("")+
      '<button data-rc="othershop" class="dash">＋ Anderes</button></div>'+
    '<div class="small" style="margin:12px 0 6px">Neue Artikel kommen nach</div><div class="chips">'+A.stores().map(s=>'<button data-rc="store" data-k="'+esc(s.id)+'" class="'+(s.id===d.store?'on':'')+'">'+esc(s.name)+'</button>').join("")+'</div>'+
    '<div class="rgrid"><label class="f"><span>Datum</span><input type="datetime-local" id="rc_at" value="'+esc(d.at)+'"></label>'+
    '<label class="f"><span>Bezahlt €</span><input id="rc_total" inputmode="decimal" value="'+esc((d.total/100).toFixed(2).replace(".",","))+'"></label></div>'+
    (Math.abs(sum-d.total)<=1 ? '<div class="small okc">✓ Die Zeilen ergeben genau die Summe.</div>'
      : '<div class="small warnc">Die Zeilen ergeben '+eur(sum)+' – '+(sum>d.total?'die Differenz sind meist Coupons auf den ganzen Einkauf.':'vielleicht fehlt eine Zeile. Zeile antippen, um sie zu prüfen.')+'</div>')+
    '</div>';
  if(d.ocr) h+='<div class="alert">Vom Foto abgeschrieben – bitte kurz prüfen, ob Namen und Preise stimmen. Zeile antippen zum Korrigieren.</div>';
  if(openHits.size) h+='<label class="rtick"><input type="checkbox" id="rc_tick"'+(d.tick?' checked':'')+'> '+(openHits.size===1?'1 Sache':openHits.size+' Sachen')+' auf der Einkaufsliste abhaken</label>';
  h+='<div class="sec"><b>'+d.lines.length+' Zeilen</b><span>'+(unassigned?unassigned+' ohne Artikel':'alle zugeordnet')+'</span></div>';
  if(suggs) h+='<div class="small" style="margin:-2px 4px 8px">„?“ = Vorschlag. Stimmt er nicht, Zeile antippen.</div>';
  h+='<div class="list">'+d.lines.map((l,ix)=>lineHtml(l,ix,true)).join("")+'</div>';
  h+='<div class="small" style="margin:10px 4px 0">Zeilen ohne Artikel werden mit ihrem Bon-Text gespeichert. Jede Zuordnung merkt sich die App für den nächsten Bon.</div>';
  h+='<div class="acts"><button class="btn ghost" data-rc="cancel">Verwerfen</button><button class="btn" data-rc="save">Speichern</button></div>';
  $("app").innerHTML=h;
  $("rc_at").onchange=e=>{ if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(e.target.value)) d.at=e.target.value.slice(0,16); };
  $("rc_total").onchange=e=>{ const v=Math.round(parseFloat(e.target.value.replace(",","."))*100); if(Number.isFinite(v)&&v>=0){ d.total=v; drawReview(); } };
  if($("rc_tick")) $("rc_tick").onchange=e=>{ d.tick=e.target.checked; };
}
function openLine(ix){
  const d=R.draft, l=d.lines[ix];
  let q="";
  const list=()=>{
    const hits = q.trim().length>=2
      ? S.items.filter(i=>fold(i.name).includes(fold(q.trim()))).sort((a,b)=>(a.store===d.store?0:1)-(b.store===d.store?0:1)||(b.buyCount||0)-(a.buyCount||0)).slice(0,10)
      : candidates(l.raw, d.store, 6).map(x=>x.i);
    const nn=(q.trim()||niceName(l.raw));
    return (hits.length?hits.map(i=>'<button class="pick'+(i.id===l.itemId?' on':'')+'" data-id="'+esc(i.id)+'">'+esc(i.name)+'<small>'+esc(A.storeName(i.store))+(i.done?'':' · auf der Liste')+'</small></button>').join("")
      : '<div class="small" style="padding:8px 2px">Kein passender Artikel.</div>')+
      '<button class="pick new" data-new="1">＋ Neuer Artikel: „'+esc(nn)+'“</button>';
  };
  const m=A.sheet('<h3>'+esc(l.raw)+'</h3>'+
    '<div class="rgrid"><label class="f"><span>Bon-Text</span><input id="ln_raw" maxlength="80" value="'+esc(l.raw)+'"></label>'+
    '<label class="f"><span>Preis €</span><input id="ln_price" inputmode="decimal" value="'+esc((l.price/100).toFixed(2).replace(".",","))+'"></label></div>'+
    '<label class="f"><span>Welcher Artikel ist das?</span><input id="ln_q" placeholder="Artikel suchen …" autocomplete="off"></label>'+
    '<div class="picks" id="ln_list">'+list()+'</div>'+
    '<div class="acts"><button class="btn ghost" id="ln_ign">'+(l.ignore?'Nicht mehr ignorieren':'Ignorieren')+'</button>'+(l.itemId||l.newName?'<button class="btn ghost" id="ln_clr">Ohne Artikel</button>':'')+'<button class="btn" id="ln_ok">Fertig</button></div>'+
    '<div class="small" style="margin:8px 2px 0">„Ignorieren“ für Dinge, deren Preis euch nicht interessiert. Auch das merkt sich die App.</div>');
  const apply=()=>{ const raw=$("ln_raw").value.trim(); if(raw) l.raw=raw;
    const p=Math.round(parseFloat($("ln_price").value.replace(",","."))*100); if(Number.isFinite(p)) l.price=p; };
  const done=()=>{ apply(); $("modal").innerHTML=""; drawReview(); };
  const bind=()=>m.querySelectorAll("#ln_list .pick").forEach(b=>b.onclick=()=>{
    if(b.dataset.new){ l.newName=(q.trim()||niceName(l.raw)).slice(0,120); l.itemId=""; }
    else { l.itemId=b.dataset.id; l.newName=""; }
    l.ignore=false; l.sugg=false; if(l.kind==="skip") l.kind="item"; done(); });
  bind();
  $("ln_q").addEventListener("input",e=>{ q=e.target.value; $("ln_list").innerHTML=list(); bind(); });
  $("ln_ign").onclick=()=>{ l.ignore=!l.ignore; if(l.ignore){ l.itemId=""; l.newName=""; l.sugg=false; } done(); };
  if($("ln_clr")) $("ln_clr").onclick=()=>{ l.itemId=""; l.newName=""; l.sugg=false; done(); };
  $("ln_ok").onclick=()=>{ l.sugg=false; done(); };
}
async function save(btn){
  const d=R.draft;
  if(!d.shop){ A.toast("Bitte oben das Geschäft auswählen"); window.scrollTo(0,0); return; }
  btn.disabled=true; btn.textContent="Wird gespeichert …";
  try{
    const r=await A.api("POST","/api/receipt/save",{shop:d.shop, store:d.store, at:d.at, total:d.total, source:d.source, person:S.me||"", tick:d.tick,
      lines:d.lines.map(l=>({raw:l.raw, ean:l.ean||"", qty:l.qty, unit:l.unit, unitPrice:l.unitPrice, price:l.price, discount:l.discount||0, kind:l.kind==="skip"?"item":l.kind,
        itemId:l.ignore?"":l.itemId, newName:l.ignore||l.itemId?"":l.newName, ignore:!!l.ignore}))});
    R.draft=null; R.mode="list"; R.list=null;
    A.toast("Gespeichert"+(r.ticked?" · "+r.ticked+" abgehakt":"")+(r.created?" · "+r.created+" neue Artikel":""));
    A.refresh(true); draw(); loadList();
  }catch(e){ btn.disabled=false; btn.textContent="Speichern"; A.toast(e.message); }
}
async function showDetail(id){
  R.mode="detail"; R.detail=null; R.delArm=false; draw();
  try{ R.detail=await A.api("GET","/api/receipt?id="+encodeURIComponent(id)); }catch(e){ R.mode="list"; R.err=e.message; }
  draw();
}
function drawDetail(){
  const r=R.detail; head(r?r.shop:"Kassenzettel","list");
  if(!r){ $("app").innerHTML='<div class="empty"><div class="spin"></div></div>'; return; }
  const sum=r.lines.reduce((a,l)=>a+l.price,0);
  $("app").innerHTML='<div class="card-s"><div class="ch"><b>'+esc(dateText(r.at))+'</b><span>'+(r.person?esc(r.person)+' · ':'')+(r.source==="foto"?'vom Foto':'PDF')+'</span></div>'+
    '<div class="rsum"><span>Bezahlt</span><b>'+eur(r.total)+'</b></div>'+(Math.abs(sum-r.total)>1?'<div class="small">Zeilen zusammen: '+eur(sum)+'</div>':'')+'</div>'+
    '<div class="list">'+r.lines.map((l,ix)=>lineHtml(l,ix,false)).join("")+'</div>'+
    '<button class="btn danger block" style="margin-top:14px" data-rc="del">'+(R.delArm?'Wirklich löschen?':'Kassenzettel löschen')+'</button>'+
    '<div class="small" style="margin:4px 4px 0">Abgehakte Sachen bleiben abgehakt. Gelernte Zuordnungen bleiben erhalten.</div>';
}

/* ---------- Preise im Bearbeiten-Dialog ---------- */
async function prices(id, el){
  if(!el) return;
  let d; try{ d=await A.api("GET","/api/prices?id="+encodeURIComponent(id)); }catch(e){ return; }
  if(!d.prices || !d.prices.length || !document.body.contains(el)) return;
  const per=new Map(); for(const p of d.prices) if(!per.has(p.shop)) per.set(p.shop,p);   // neuester Preis je Geschäft
  const val=p=>p.unit==="kg" ? p.unitPrice : Math.round(p.price/Math.max(1,p.qty));
  const list=[...per.values()].sort((a,b)=>val(a)-val(b));
  el.innerHTML='<div class="small" style="margin:0 0 5px">Zuletzt bezahlt</div><div class="prices">'+list.map((p,i)=>'<div class="prow'+(i===0&&list.length>1?' best':'')+'"><span>'+esc(p.shop)+'<small>'+esc(shortDate(p.at))+(p.discount?' · mit Rabatt':'')+'</small></span><b>'+eur(val(p))+(p.unit==="kg"?'/kg':'')+'</b></div>').join("")+'</div>';
}

/* ---------- Ereignisse ---------- */
document.addEventListener("click",e=>{
  const b=e.target.closest("[data-rc]"); if(!b || S.view!=="receipts" || $("modal").contains(b)) return;
  const k=b.dataset.rc, d=R.draft;
  if(k==="close") A.close();
  else if(k==="list"){ R.mode="list"; draw(); loadList(); }
  else if(k==="cancel"){ if(R.mode==="review" && !b.dataset.sure && !confirm("Diesen Kassenzettel verwerfen?")) return; R.draft=null; R.mode="list"; draw(); }
  else if(k==="shop"){ d.shop=b.dataset.k; const k2=d.shop.toLowerCase(); if(A.stores().some(s=>s.name.toLowerCase()===k2||(s.labels||[]).some(l=>l.toLowerCase()===k2))) d.store=storeForShop(d.shop); drawReview(); }
  else if(k==="store"){ d.store=b.dataset.k; drawReview(); }
  else if(k==="othershop"){ const n=(prompt("Name des Geschäfts, z. B. Hornbach")||"").replace(/[<>|,]/g,"").trim().slice(0,30);
    if(n){ d.shop=allShops().find(l=>l.toLowerCase()===n.toLowerCase())||n; if(A.stores().some(s=>s.name.toLowerCase()===n.toLowerCase()||(s.labels||[]).some(l=>l.toLowerCase()===n.toLowerCase()))) d.store=storeForShop(n); drawReview(); } }
  else if(k==="line") openLine(+b.dataset.ix);
  else if(k==="save") save(b);
  else if(k==="show") showDetail(b.dataset.id);
  else if(k==="del"){
    if(!R.delArm){ R.delArm=true; drawDetail(); return; }
    A.api("POST","/api/receipt/delete",{id:R.detail.id}).then(()=>{ A.toast("Kassenzettel gelöscht"); R.mode="list"; R.list=null; draw(); loadList(); }).catch(err=>A.toast(err.message));
  }
});

window.Receipts = { open, render: draw, prices, _test:{ toks, tokMatch, score, candidates, niceName, fold } };
})();
