(function(){
"use strict";

const STORE_KEY = "einkaufsliste.v1";
const VIEW_KEY = "einkaufsliste.ansicht";   // Sortierung & Ansicht: eigener kleiner Eintrag, gilt für alle Läden
const POLL_MS = 4000;
const DEFAULT_STORES = [
  {id:"supermarkt",name:"Supermarkt",labels:["Aldi","Edeka","Lidl","Rewe"]},{id:"drogerie",name:"Drogerie",labels:["dm","Rossmann"]},
  {id:"tier",name:"Fressnapf"},{id:"baumarkt",name:"Baumarkt"},{id:"ikea",name:"IKEA"}
];
const S = { loaded:false, online:true, rev:null, items:[], stores:null, people:["Jonas","Clara"], cur:null, q:"", showAllHist:false, pending:0, dirty:false,
  me:"", sortOpen:"group", sortHist:"freq", histBy:{}, pushOn:false, filter:{},
  view:"list", st:{ range:"week", offset:0, store:"", rows:null, first:null, loading:false, err:"", topAll:false, tip:"" } };
// Sortierung „Schon mal gekauft“ merkt sich jeder Laden selbst; sortHist ist nur der Startwert für Läden ohne eigene Wahl
const histMode = store => S.histBy[store] || S.sortHist;
const G = window.Groups;

const esc = s => String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const norm = s => String(s||"").toLowerCase().replace(/\s+/g," ").trim();
const uid = () => "i"+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
const now = () => new Date().toISOString();
const stores = () => (S.stores && S.stores.length) ? S.stores : DEFAULT_STORES;
const storeName = id => (stores().find(s=>s.id===id)||{name:id}).name;
const $ = id => document.getElementById(id);

function toast(msg, undo){
  const t=$("toast");
  t.innerHTML='<div class="toast"><span>'+esc(msg)+'</span>'+(undo?'<button id="undo">Rückgängig</button>':'')+'</div>';
  if(undo) $("undo").onclick=()=>{ t.innerHTML=""; undo(); };
  clearTimeout(toast._t); toast._t=setTimeout(()=>t.innerHTML="", undo?5000:2600);
}

/* ---------- Zwischenspeicher auf dem Gerät (für schnellen Start und ohne Netz) ---------- */
function loadLocal(){
  try{ const o=JSON.parse(localStorage.getItem(STORE_KEY)||"null"); if(o){ S.items=o.items||[]; S.stores=o.stores||null; S.cur=o.cur||null; if(S.items.length) S.loaded=true;
    S.me=o.me||""; S.sortOpen=o.sortOpen||"group"; S.sortHist=o.sortHist||"freq"; if(Array.isArray(o.people)&&o.people.length) S.people=o.people; } }catch(e){}
  try{ const v=JSON.parse(localStorage.getItem(VIEW_KEY)||"null"); if(v){
    if(v.sortOpen==="group"||v.sortOpen==="new") S.sortOpen=v.sortOpen;
    if(v.sortHist==="freq"||v.sortHist==="group") S.sortHist=v.sortHist;
    if(v.histBy && typeof v.histBy==="object") for(const k in v.histBy) if(v.histBy[k]==="freq"||v.histBy[k]==="group") S.histBy[k]=v.histBy[k];
    S.showAllHist=!!v.showAllHist; if(v.me) S.me=v.me; } }catch(e){}
}
function saveView(){ try{ localStorage.setItem(VIEW_KEY, JSON.stringify({sortOpen:S.sortOpen, sortHist:S.sortHist, histBy:S.histBy, showAllHist:S.showAllHist, me:S.me})); }catch(e){} }
function saveLocal(){ saveView(); try{ localStorage.setItem(STORE_KEY, JSON.stringify({items:S.items, stores:S.stores, cur:S.cur, me:S.me, sortOpen:S.sortOpen, sortHist:S.sortHist, people:S.people})); }catch(e){} }

/* ---------- Server ---------- */
async function api(method, path, body){
  let res;
  try{ res=await fetch(path,{method,headers:body?{"Content-Type":"application/json"}:{},body:body?JSON.stringify(body):undefined,credentials:"same-origin",cache:"no-store"}); }
  catch(e){ setOnline(false); throw new Error("Keine Internetverbindung."); }
  if(res.status===401){ location.replace("/"); throw new Error("Bitte neu anmelden."); }
  let data=null; try{ data=await res.json(); }catch(e){}
  if(!res.ok) throw new Error((data&&data.error)||"Fehler vom Server ("+res.status+").");
  setOnline(true); return data;
}
function setOnline(on){ if(S.online===on) return; S.online=on; renderHead(true); }

async function refresh(force){
  if(S.pending) { S.dirty=true; return; }       // erst eigene Änderungen fertig speichern
  try{
    const d=await api("GET","/api/state"+(S.rev!=null && !force?"?rev="+S.rev:""));
    if(S.pending){ S.dirty=true; return; }
    if(d.same){ S.rev=d.rev; return; }
    S.rev=d.rev; S.items=d.items||[]; S.stores=(d.stores&&d.stores.length)?d.stores:null; S.loaded=true;
    if(Array.isArray(d.people)&&d.people.length) S.people=d.people;
    if(d.stage==="test" && !document.getElementById("testbadge")){ const b=document.createElement("div"); b.id="testbadge"; b.textContent="TEST-VERSION · eigene Testdaten"; document.body.prepend(b); }
    fixCur(); saveLocal();
    if(!$("modal").innerHTML) render(); else renderHead(true);
  }catch(e){ if(!S.loaded){ S.loaded=true; render(); } }
}
// Eine Änderung zum Server schicken. Bis sie durch ist, werden keine Server-Stände übernommen,
// damit nichts zurückspringt.
async function send(path, body){
  S.pending++;
  try{ await api("POST", path, body); }
  catch(e){ toast(e.message||"Speichern fehlgeschlagen – bitte nochmal versuchen."); S.dirty=true; }
  finally{ S.pending--; if(!S.pending){ S.dirty=false; refresh(true); } }
}
function itemBody(it){ return {id:it.id,name:it.name,store:it.store,note:it.note||"",done:!!it.done,addedAt:it.addedAt||null,doneAt:it.doneAt||null,
  cat:it.cat||"",buyCount:it.buyCount||0,by:S.me||"",shops:shopsOf(it)}; }
// Labels eines Eintrags (ältere Zwischenspeicher kennen nur ein einzelnes „shop“)
const shopsOf = i => Array.isArray(i.shops) ? i.shops : (i.shop ? [i.shop] : []);
const tags = i => shopsOf(i).map(l=>'<span class="shop">'+esc(l)+'</span>').join("");
const labelsOf = id => ((stores().find(s=>s.id===id)||{}).labels)||[];
// „Brezel @Edeka @Aldi“ → Name „Brezel“ mit Labels Edeka und Aldi (nur Labels, die es bei diesem Laden gibt)
function splitShop(text, store){
  const m=String(text).match(/^(.*?)((?:\s*@\s*[^@]+)+)$/); if(!m || !m[1].trim()) return {name:text, shops:[]};
  const labs=labelsOf(store), shops=[];
  for(const w of m[2].split("@").map(x=>x.trim()).filter(Boolean)){ const l=labs.find(x=>x.toLowerCase()===w.toLowerCase()); if(!l) return {name:text, shops:[]}; if(!shops.includes(l)) shops.push(l); }
  return {name:m[1].trim(), shops};
}
function patchLocal(id, data){ const it=S.items.find(i=>i.id===id); if(it) Object.assign(it,data); else S.items.push(Object.assign({id},data)); saveLocal(); return S.items.find(i=>i.id===id); }
function pushItem(it){ send("/api/item", itemBody(it)); }

/* ---------- Aktionen ---------- */
function addItem(name, store){
  name=String(name||"").trim(); if(!name) return;
  store=store||S.cur;
  const sp=splitShop(name, store); name=sp.name;
  const ex = S.items.find(i=>i.store===store && norm(i.name)===norm(name));
  if(ex){
    const merged=[...new Set(shopsOf(ex).concat(sp.shops))];
    if(!ex.done){ if(merged.length>shopsOf(ex).length){ pushItem(patchLocal(ex.id,{shops:merged})); render(); toast("„"+ex.name+"“: "+merged.join(", ")); } else toast("„"+ex.name+"“ steht schon drauf"); return; }
    const data={done:false, addedAt:now(), addedBy:S.me||""}; if(sp.shops.length) data.shops=merged;
    pushItem(patchLocal(ex.id,data)); render();
  } else {
    const id=uid();
    pushItem(patchLocal(id,{name:name.slice(0,120), store, note:"", done:false, addedAt:now(), doneAt:null, cat:"", buyCount:0, addedBy:S.me||"", shops:sp.shops})); render();
  }
}
function toggle(id){
  const it=S.items.find(i=>i.id===id); if(!it) return;
  const before={done:it.done, doneAt:it.doneAt||null, addedAt:it.addedAt||null, buyCount:it.buyCount||0};
  const data = it.done ? {done:false, addedAt:now(), addedBy:S.me||""} : {done:true, doneAt:now(), buyCount:(it.buyCount||0)+1};
  pushItem(patchLocal(id,data)); render();
  if(data.done) toast("„"+it.name+"“ abgehakt", ()=>{ pushItem(patchLocal(id,before)); render(); });
}
// Von der Liste nehmen, ohne es zu kaufen: zurück unter „Schon mal gekauft“, zählt nicht als Kauf
function dropItem(id){
  const it=S.items.find(i=>i.id===id); if(!it || it.done) return;
  const before={done:false, doneAt:it.doneAt||null, addedAt:it.addedAt||null};
  send("/api/item", Object.assign(itemBody(patchLocal(id,{done:true, doneAt:it.doneAt||null})), {skip:true})); render();
  toast("„"+it.name+"“ von der Liste genommen", ()=>{ pushItem(patchLocal(id,before)); render(); });
}
function removeItem(id){
  const it=S.items.find(i=>i.id===id); if(!it) return;
  const copy=Object.assign({},it);
  S.items=S.items.filter(i=>i.id!==id); saveLocal(); render();
  send("/api/item/delete",{id});
  toast("„"+it.name+"“ gelöscht", ()=>{ pushItem(patchLocal(id,copy)); render(); });
}

/* ---------- Anzeige ---------- */
const byNew = (a,b)=>(b.addedAt||"").localeCompare(a.addedAt||"");
const byRecent = (a,b)=>(b.doneAt||"").localeCompare(a.doneAt||"");
const byFreq = (a,b)=>(b.buyCount||0)-(a.buyCount||0) || byRecent(a,b);
const byGroup = then => (a,b)=>G.ORDER[G.groupOf(a)]-G.ORDER[G.groupOf(b)] || then(a,b);
const byName = (a,b)=>a.name.localeCompare(b.name,"de",{sensitivity:"base"});
function openOf(store){ return S.items.filter(i=>i.store===store && !i.done).sort(S.sortOpen==="group"?byGroup(byName):byNew); }
function histOf(store){ return S.items.filter(i=>i.store===store && i.done).sort(histMode(store)==="group"?byGroup(byFreq):byFreq); }
// Liste in Abschnitte je Warengruppe teilen
function chunks(list){ const out=[]; for(const i of list){ const g=G.groupOf(i); if(!out.length||out[out.length-1].g!==g) out.push({g,items:[]}); out[out.length-1].items.push(i); } return out; }
function seg(name, cur, opts){ return '<span class="mini-seg">'+opts.map(([k,l])=>'<button class="'+(cur===k?'on':'')+'" data-sort="'+name+'" data-k="'+k+'">'+l+'</button>').join("")+'</span>'; }
function fixCur(){ if(!stores().find(s=>s.id===S.cur)) S.cur=stores()[0].id; }

function storeBtns(){
  return stores().map(s=>{ const n=openOf(s.id).length;
    return '<button class="store'+(s.id===S.cur?' on':'')+'" data-store="'+esc(s.id)+'">'+esc(s.name)+'<span class="cnt">'+n+'</span></button>'; }).join("");
}
const GEAR='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>';
const CHART='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>';
function renderHead(light){
  const h=$("head");
  if(S.view==="stats") return;
  if(light && $("storebar")){
    // Nur Läden, Platzhalter und Status aktualisieren, damit das Eingabefeld (und die Tastatur) stehen bleibt
    $("storebar").innerHTML=storeBtns();
    const q=$("q"); if(q) q.placeholder="Was brauchen wir bei "+storeName(S.cur)+"?";
    $("net").textContent = S.online ? "" : "offline";
    renderSugg(); return;
  }
  h.innerHTML='<div class="title"><h1>Einkauf<span class="net" id="net">'+(S.online?"":"offline")+'</span></h1><span class="tbtns"><button class="iconbtn" data-act="stats" aria-label="Statistik">'+CHART+'</button><button class="iconbtn" data-act="menu" aria-label="Einstellungen">'+GEAR+'</button></span></div>'+
    '<div class="stores" id="storebar">'+storeBtns()+'</div>'+
    '<form class="add" id="addf" autocomplete="off"><input id="q" enterkeyhint="done" autocapitalize="sentences" placeholder="Was brauchen wir bei '+esc(storeName(S.cur))+'?" value="'+esc(S.q)+'"><button type="submit" aria-label="Hinzufügen">+</button></form>'+
    '<div class="sugg" id="sugg"></div>';
  const q=$("q");
  q.addEventListener("input",()=>{ S.q=q.value; renderSugg(); });
  $("addf").addEventListener("submit",e=>{ e.preventDefault(); const v=q.value; S.q=""; q.value=""; addItem(v); renderSugg(); q.focus(); });
  renderSugg();
  const on=h.querySelector(".store.on"); if(on) on.scrollIntoView({inline:"nearest",block:"nearest"});
}
function renderSugg(){
  const el=$("sugg"); if(!el) return;
  const q=norm(S.q); if(q.length<2){ el.innerHTML=""; return; }
  const seen=new Set();
  const hits=S.items.filter(i=>i.done && norm(i.name).includes(q))
    .sort((a,b)=>(a.store===S.cur?0:1)-(b.store===S.cur?0:1) || (norm(a.name).startsWith(q)?0:1)-(norm(b.name).startsWith(q)?0:1))
    .filter(i=>{ const k=norm(i.name); if(seen.has(k)) return false; seen.add(k); return true; }).slice(0,6);
  el.innerHTML=hits.map(i=>'<button data-sugg="'+esc(i.id)+'">'+esc(i.name)+(i.store!==S.cur?'<small>'+esc(storeName(i.store))+'</small>':'')+'</button>').join("");
}
function render(){
  if(S.view==="stats"){ renderStats(); return; }
  renderHead(!!$("storebar"));
  const app=$("app");
  if(!S.loaded){ app.innerHTML='<div class="empty"><div class="spin"></div>Liste wird geladen …</div>'; return; }
  const all=openOf(S.cur), hist=histOf(S.cur), labels=labelsOf(S.cur);
  // Filter: ausgewählte Labels → nur Sachen, die mindestens eins davon haben
  const f=(S.filter[S.cur]||[]).filter(l=>labels.includes(l)); S.filter[S.cur]=f;
  const open = f.length ? all.filter(i=>shopsOf(i).some(l=>f.includes(l))) : all;
  let h='';
  if(!S.me) h+='<div class="whobox"><b>Wer benutzt dieses Handy?</b><div class="small">Damit der andere erfährt, wer etwas eingetragen hat.</div><div class="chips">'+
    S.people.map(p=>'<button data-me="'+esc(p)+'">'+esc(p)+'</button>').join("")+'</div></div>';
  h+='<div class="sec"><b>Einkaufen'+(open.length?' · '+open.length:'')+'</b>'+seg("open",S.sortOpen,[["group","Warengruppe"],["new","Neueste"]])+'</div>';
  if(labels.length){
    const cnt=l=>all.filter(i=>shopsOf(i).includes(l)).length;
    h+='<div class="shopbar"><span class="small">Filter:</span><button class="'+(f.length?'':'on')+'" data-filter="">Alle</button>'+
      labels.map(l=>'<button class="'+(f.includes(l)?'on':'')+'" data-filter="'+esc(l)+'">'+esc(l)+(cnt(l)?' <small>'+cnt(l)+'</small>':'')+'</button>').join("")+'</div>';
    if(f.length && all.length>open.length) h+='<div class="small" style="margin:0 4px 8px">Nur Sachen mit Label '+f.map(esc).join(" oder ")+' · '+(all.length-open.length)+' weitere ausgeblendet</div>';
  }
  if(open.length){
    if(S.sortOpen==="group") h+=chunks(open).map(c=>'<div class="grp">'+esc(G.groupName(c.g))+'</div><div class="list">'+c.items.map(rowHtml).join("")+'</div>').join("");
    else h+='<div class="list">'+open.map(rowHtml).join("")+'</div>';
  }
  else if(f.length) h+='<div class="list"><div class="empty">Nichts mit Label '+f.map(esc).join(" oder ")+'.<br><span class="small">Labels vergibst du über „⋯“ am Eintrag oder beim Eintippen mit @, z. B. „Brezel @'+esc(f[0])+'“.</span></div></div>';
  else h+='<div class="list"><div class="empty">Alles erledigt 🎉<br><span class="small">Oben eintippen oder unten antippen, um etwas hinzuzufügen.</span></div></div>';
  if(hist.length){
    const hm=histMode(S.cur), lim=S.showAllHist?hist.length:(hm==="group"?hist.length:24);
    const chip=i=>'<button data-readd="'+esc(i.id)+'">'+esc(i.name)+tags(i)+((i.buyCount||0)>1?'<small>'+i.buyCount+'×</small>':'')+'</button>';
    h+='<div class="sec"><b>Schon mal gekauft</b>'+seg("hist",hm,[["freq","Häufigkeit"],["group","Warengruppe"]])+'</div>';
    h+='<div class="small" style="margin:-2px 4px 8px">Antippen = wieder auf die Liste</div>';
    if(hm==="group") h+=chunks(hist).map(c=>'<div class="grp">'+esc(G.groupName(c.g))+'</div><div class="hist">'+c.items.map(chip).join("")+'</div>').join("");
    else h+='<div class="hist">'+hist.slice(0,lim).map(chip).join("")+'</div>';
    if(hist.length>lim) h+='<button class="linkbtn" data-act="allHist">Alle '+hist.length+' anzeigen</button>';
    else if(S.showAllHist && hist.length>24) h+='<button class="linkbtn" data-act="allHist">Weniger anzeigen</button>';
    h+='<div class="small" style="margin:8px 4px 0">Gedrückt halten, um einen Eintrag zu bearbeiten oder zu löschen.</div>';
  }
  app.innerHTML=h;
}
function rowHtml(i){
  const d=[]; if(i.note) d.push(esc(i.note)); if(i.addedBy && i.addedBy!==S.me) d.push('<span class="by">von '+esc(i.addedBy)+'</span>');
  return '<div class="row"><button class="tick" data-tick="'+esc(i.id)+'"><span class="box"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span><span class="t"><div class="n">'+esc(i.name)+tags(i)+'</div>'+(d.length?'<div class="d">'+d.join(" · ")+'</div>':'')+'</span></button><button class="more" data-edit="'+esc(i.id)+'" aria-label="Bearbeiten">⋯</button><button class="drop" data-drop="'+esc(i.id)+'" aria-label="Von der Liste nehmen (nicht gekauft)" title="Von der Liste nehmen">×</button></div>';
}

/* ---------- Dialoge ---------- */
function closeModal(){ $("modal").innerHTML=""; render(); }
function sheet(inner){
  const m=$("modal");
  m.innerHTML='<div class="scrim" id="scrim"><div class="sheet" role="dialog" aria-modal="true">'+inner+'</div></div>';
  $("scrim").addEventListener("click",e=>{ if(e.target.id==="scrim") closeModal(); });
  return m;
}
function openEdit(id){
  const it=S.items.find(i=>i.id===id); if(!it) return;
  let st=it.store, shops=shopsOf(it).slice(); const auto=G.guessGroup(it.name);
  const shopChips=()=>{ const ls=labelsOf(st); shops=shops.filter(l=>ls.includes(l));
    return ls.length ? '<button type="button" data-sh="" class="'+(shops.length?'':'on')+'">Keins</button>'+ls.map(l=>'<button type="button" data-sh="'+esc(l)+'" class="'+(shops.includes(l)?'on':'')+'">'+esc(l)+'</button>').join("")
      : '<span class="small">Für '+esc(storeName(st))+' gibt es keine Labels. Anlegen unter Einstellungen → Läden bearbeiten.</span>'; };
  const m=sheet('<h3>Eintrag bearbeiten</h3>'+
    '<label class="f"><span>Was?</span><input id="e_name" maxlength="120" value="'+esc(it.name)+'"></label>'+
    '<label class="f"><span>Notiz (Menge, Marke …)</span><input id="e_note" maxlength="300" value="'+esc(it.note||"")+'" placeholder="z. B. 2×, bio, von Edeka"></label>'+
    '<label class="f"><span>Warengruppe</span><select id="e_cat"><option value="">Automatisch ('+esc(G.groupName(auto))+')</option>'+
      G.GROUPS.map(g=>'<option value="'+g.id+'"'+(it.cat===g.id?' selected':'')+'>'+esc(g.name)+'</option>').join("")+'</select></label>'+
    '<label class="f"><span>Laden</span><div class="chips" id="e_st">'+stores().map(s=>'<button type="button" data-s="'+esc(s.id)+'" class="'+(s.id===st?'on':'')+'">'+esc(s.name)+'</button>').join("")+'</div></label>'+
    '<label class="f"><span>Labels (optional, mehrere möglich)</span><div class="chips" id="e_sh">'+shopChips()+'</div></label>'+
    (it.done?'':'<button class="btn ghost block" id="e_drop">Von der Liste nehmen (nicht gekauft)</button>')+
    '<div class="acts"><button class="btn danger" id="e_del">Ganz löschen</button><button class="btn ghost" id="e_x">Abbrechen</button><button class="btn" id="e_ok">Fertig</button></div>'+
    '<div class="small" style="margin:8px 2px 0">„Ganz löschen“ entfernt den Artikel auch aus „Schon mal gekauft“.</div>');
  const bindSh=()=>m.querySelectorAll("#e_sh [data-sh]").forEach(b=>b.onclick=()=>{
    const l=b.dataset.sh; shops = !l ? [] : shops.includes(l) ? shops.filter(x=>x!==l) : shops.concat([l]);
    m.querySelectorAll("#e_sh [data-sh]").forEach(x=>x.classList.toggle("on", x.dataset.sh ? shops.includes(x.dataset.sh) : !shops.length)); });
  bindSh();
  m.querySelectorAll("#e_st button").forEach(b=>b.onclick=()=>{ st=b.dataset.s; m.querySelectorAll("#e_st button").forEach(x=>x.classList.toggle("on",x===b)); $("e_sh").innerHTML=shopChips(); bindSh(); });
  $("e_x").onclick=closeModal;
  $("e_del").onclick=()=>{ $("modal").innerHTML=""; removeItem(id); };
  if($("e_drop")) $("e_drop").onclick=()=>{ $("modal").innerHTML=""; dropItem(id); };
  $("e_ok").onclick=()=>{
    const name=$("e_name").value.trim(), note=$("e_note").value.trim();
    if(!name){ toast("Bitte einen Namen eingeben"); return; }
    const cat=$("e_cat").value;
    const data={}; if(name!==it.name) data.name=name; if(note!==(it.note||"")) data.note=note; if(st!==it.store) data.store=st; if(cat!==(it.cat||"")) data.cat=cat; if(shops.join("|")!==shopsOf(it).join("|")) data.shops=shops;
    if(Object.keys(data).length){ pushItem(patchLocal(id,data)); if(data.store) toast("Verschoben nach "+storeName(st)); }
    closeModal();
  };
}
function openMenu(){
  const m=sheet('<h3>Einstellungen</h3>'+
    '<div class="sec" style="margin:0 0 8px"><b>Dieses Handy gehört</b></div><div class="chips" style="margin-bottom:16px">'+
      S.people.map(p=>'<button data-mp="'+esc(p)+'" class="'+(S.me===p?'on':'')+'">'+esc(p)+'</button>').join("")+'</div>'+
    '<div class="sec" style="margin:0 0 8px"><b>Benachrichtigungen</b></div><div id="pushbox" class="small" style="margin:0 2px 16px">Wird geprüft …</div>'+
    '<button class="btn ghost block" id="m_st">Läden bearbeiten</button>'+
    '<div class="sec" style="margin:18px 0 8px"><b>Passwort ändern</b></div>'+
    '<label class="f"><span>Aktuelles Passwort</span><input id="pw_old" type="password" autocomplete="current-password"></label>'+
    '<label class="f"><span>Neues Passwort (mind. 8 Zeichen)</span><input id="pw_new" type="password" autocomplete="new-password"></label>'+
    '<button class="btn ghost block" id="m_pw">Passwort ändern</button>'+
    '<div class="small" style="margin:8px 2px 0">Danach müsst ihr euch beide einmal mit dem neuen Passwort anmelden.</div>'+
    '<div class="acts" style="margin-top:18px"><button class="btn danger" id="m_out">Abmelden</button><button class="btn" id="m_x">Schließen</button></div>');
  $("m_x").onclick=closeModal;
  $("m_st").onclick=openStores;
  m.querySelectorAll("[data-mp]").forEach(b=>b.onclick=()=>{ setMe(b.dataset.mp); m.querySelectorAll("[data-mp]").forEach(x=>x.classList.toggle("on",x===b)); drawPush(); });
  drawPush();
  $("m_out").onclick=()=>{ try{ localStorage.removeItem(STORE_KEY); }catch(e){} location.href="/logout"; };
  $("m_pw").onclick=()=>{
    const o=$("pw_old").value, n=$("pw_new").value;
    if(n.length<8){ toast("Das neue Passwort braucht mindestens 8 Zeichen."); return; }
    api("POST","/api/password",{old:o,new:n}).then(()=>{ closeModal(); toast("Passwort geändert"); }).catch(e=>toast(e.message));
  };
}
function openStores(){
  let list=stores().map(s=>Object.assign({},s));
  function draw(){
    const m=sheet('<h3>Läden</h3><div class="small" style="margin-bottom:10px">Umbenennen, Reihenfolge ändern oder neue Läden anlegen. Ein Laden lässt sich nur löschen, wenn nichts mehr darin steht. Labels (mit Komma getrennt) sind einzelne Geschäfte, die ihr an Einträge hängen könnt.</div>'+
      list.map((s,ix)=>'<div class="sblock"><div class="srow"><input data-ix="'+ix+'" maxlength="40" value="'+esc(s.name)+'"><button data-up="'+ix+'" aria-label="nach oben"'+(ix?'':' disabled')+'>↑</button><button data-del="'+ix+'" aria-label="löschen">✕</button></div>'+
        '<input class="labels" data-lx="'+ix+'" maxlength="200" value="'+esc((s.labels||[]).join(", "))+'" placeholder="Labels (optional), z. B. Aldi, Edeka"></div>').join("")+
      '<button class="linkbtn" id="s_add">+ Laden hinzufügen</button>'+
      '<div class="acts"><button class="btn ghost" id="s_x">Abbrechen</button><button class="btn" id="s_ok">Speichern</button></div>');
    const sync=()=>{ m.querySelectorAll("input[data-ix]").forEach(i=>{ list[+i.dataset.ix].name=i.value; });
      m.querySelectorAll("input[data-lx]").forEach(i=>{ list[+i.dataset.lx].labels=i.value.split(",").map(x=>x.trim()).filter(Boolean); }); };
    m.querySelectorAll("[data-up]").forEach(b=>b.onclick=()=>{ sync(); const i=+b.dataset.up; [list[i-1],list[i]]=[list[i],list[i-1]]; draw(); });
    m.querySelectorAll("[data-del]").forEach(b=>b.onclick=()=>{ sync(); const s=list[+b.dataset.del];
      const n=S.items.filter(i=>i.store===s.id).length;
      if(n){ toast(s.name+" enthält noch "+n+" Einträge"); return; }
      list.splice(+b.dataset.del,1); draw(); });
    $("s_add").onclick=()=>{ sync(); list.push({id:"s"+Date.now().toString(36),name:""}); draw(); const ins=m.querySelectorAll("input[data-ix]"); ins[ins.length-1].focus(); };
    $("s_x").onclick=closeModal;
    $("s_ok").onclick=()=>{
      sync(); list=list.map(s=>({id:s.id,name:s.name.trim(),labels:(s.labels||[]).slice(0,15)})).filter(s=>s.name);
      if(!list.length){ toast("Mindestens ein Laden"); return; }
      S.stores=list; fixCur(); saveLocal(); closeModal();
      send("/api/stores",{list});
    };
  }
  draw();
}

/* ---------- Wer bin ich & Benachrichtigungen ---------- */
function setMe(p){ S.me=p; saveLocal(); if(S.pushOn) enablePush(true).catch(()=>{}); }
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform==="MacIntel" && navigator.maxTouchPoints>1);
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone===true;
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
function keyBytes(b64){ const s=b64.replace(/-/g,"+").replace(/_/g,"/"); const bin=atob(s+"===".slice((s.length+3)%4)); return Uint8Array.from(bin,c=>c.charCodeAt(0)); }
async function swReg(){ return navigator.serviceWorker.register("/sw.js",{scope:"/"}).then(()=>navigator.serviceWorker.ready); }
async function currentSub(){ if(!pushSupported()) return null; try{ const r=await navigator.serviceWorker.getRegistration("/"); return r ? await r.pushManager.getSubscription() : null; }catch(e){ return null; } }
async function enablePush(silent){
  if(!S.me) throw new Error("Bitte zuerst oben auswählen, wem dieses Handy gehört.");
  const reg=await swReg();
  if(Notification.permission!=="granted"){
    const p=await Notification.requestPermission();
    if(p!=="granted") throw new Error("Benachrichtigungen wurden nicht erlaubt. Du kannst sie in den Einstellungen des Handys erlauben.");
  }
  const {key}=await api("GET","/api/push/key");
  let sub=await reg.pushManager.getSubscription();
  if(!sub) sub=await reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:keyBytes(key)});
  const j=sub.toJSON();
  await api("POST","/api/push/subscribe",{endpoint:j.endpoint, keys:j.keys, person:S.me});
  S.pushOn=true;
  if(!silent) await api("POST","/api/push/test",{endpoint:j.endpoint});
}
async function disablePush(){
  const sub=await currentSub(); if(!sub){ S.pushOn=false; return; }
  try{ await api("POST","/api/push/unsubscribe",{endpoint:sub.endpoint}); }catch(e){}
  await sub.unsubscribe(); S.pushOn=false;
}
async function drawPush(){
  const box=$("pushbox"); if(!box) return;
  const other=S.people.filter(p=>p!==S.me).join(" / ")||"der andere";
  if(!pushSupported()){
    box.innerHTML = isIOS && !isStandalone()
      ? 'Auf dem iPhone gehen Benachrichtigungen nur, wenn die Liste auf dem Home-Bildschirm liegt: unten auf <b>Teilen</b> → <b>Zum Home-Bildschirm</b>, dann die Liste von dort öffnen und hier einschalten.'
      : 'Dieser Browser kann keine Benachrichtigungen empfangen.';
    return;
  }
  const sub=await currentSub(); S.pushOn=!!sub && Notification.permission==="granted";
  box.innerHTML = (S.pushOn
      ? '✓ An. Du bekommst eine Nachricht, wenn '+esc(other)+' etwas einträgt oder einkaufen war.<div class="acts" style="margin-top:8px"><button class="btn ghost" id="p_test">Testen</button><button class="btn danger" id="p_off">Ausschalten</button></div>'
      : 'Bekomme eine Nachricht, wenn '+esc(other)+' etwas auf die Liste setzt oder einkaufen war.<button class="btn block" style="margin-top:8px" id="p_on">Benachrichtigungen einschalten</button>');
  const busy=(b,t)=>{ b.disabled=true; b.textContent=t; };
  if($("p_on")) $("p_on").onclick=e=>{ busy(e.target,"Wird eingeschaltet …"); enablePush().then(()=>{ toast("Eingeschaltet – eine Test-Nachricht ist unterwegs"); drawPush(); }).catch(err=>{ toast(err.message||"Hat nicht geklappt"); drawPush(); }); };
  if($("p_test")) $("p_test").onclick=e=>{ busy(e.target,"Gesendet …"); currentSub().then(s=>api("POST","/api/push/test",{endpoint:s.endpoint})).then(()=>toast("Test-Nachricht ist unterwegs")).catch(err=>toast(err.message)).finally(drawPush); };
  if($("p_off")) $("p_off").onclick=e=>{ busy(e.target,"…"); disablePush().then(()=>{ toast("Benachrichtigungen aus"); drawPush(); }); };
}

/* ---------- Statistik ---------- */
const MON=["Jan","Feb","Mär","Apr","Mai","Jun","Jul","Aug","Sep","Okt","Nov","Dez"];
const MONL=["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];
const WD=["Mo","Di","Mi","Do","Fr","Sa","So"];
const dayKey = d => d.getFullYear()+"-"+(d.getMonth()+1)+"-"+d.getDate();
function startOfWeek(d){ const x=new Date(d.getFullYear(),d.getMonth(),d.getDate()); x.setDate(x.getDate()-((x.getDay()+6)%7)); return x; }
function isoWeek(d){ const t=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())); const day=(t.getUTCDay()+6)%7; t.setUTCDate(t.getUTCDate()-day+3);
  const fy=new Date(Date.UTC(t.getUTCFullYear(),0,4)); return 1+Math.round(((t-fy)/86400000-3+((fy.getUTCDay()+6)%7))/7); }
// Zeitraum (lokale Zeit): Beginn, Ende, Beschriftung und Unterteilung für den Verlauf
function period(range, offset){
  const now=new Date(); let from,to,label,buckets=[];
  if(range==="week"){
    from=startOfWeek(now); from.setDate(from.getDate()+7*offset); to=new Date(from); to.setDate(to.getDate()+7);
    const last=new Date(to); last.setDate(last.getDate()-1);
    label="KW "+isoWeek(from)+" · "+from.getDate()+". "+(from.getMonth()!==last.getMonth()?MON[from.getMonth()]+" ":"")+"– "+last.getDate()+". "+MON[last.getMonth()]+" "+last.getFullYear();
    for(let i=0;i<7;i++){ const d=new Date(from); d.setDate(d.getDate()+i); buckets.push({from:d, label:WD[i], tip:WD[i]+" "+d.getDate()+". "+MON[d.getMonth()]}); }
  } else if(range==="month"){
    from=new Date(now.getFullYear(), now.getMonth()+offset, 1); to=new Date(from.getFullYear(), from.getMonth()+1, 1);
    label=MONL[from.getMonth()]+" "+from.getFullYear();
    for(let d=new Date(from); d<to; d.setDate(d.getDate()+1)){ const n=d.getDate(); buckets.push({from:new Date(d), label:(n===1||n%5===0)?String(n):"", tip:n+". "+MONL[d.getMonth()]}); }
  } else {
    from=new Date(now.getFullYear()+offset,0,1); to=new Date(from.getFullYear()+1,0,1); label=String(from.getFullYear());
    for(let m=0;m<12;m++) buckets.push({from:new Date(from.getFullYear(),m,1), label:MON[m].slice(0,1), tip:MONL[m]+" "+from.getFullYear()});
  }
  buckets.forEach((b,i)=>b.to = buckets[i+1] ? buckets[i+1].from : to);
  return {from,to,label,buckets};
}
async function loadStats(){
  const st=S.st; st.loading=true; st.err=""; renderStats();
  try{ const d=await api("GET","/api/purchases?since=2000-01-01T00:00:00.000Z"); st.rows=d.rows.map(r=>({id:r[0],name:r[1],store:r[2],cat:r[3],shops:r[4]?r[4].split("|"):[],person:r[5],at:new Date(r[6])})); st.first=d.first?new Date(d.first):null; }
  catch(e){ st.err=e.message||"Statistik konnte nicht geladen werden."; }
  st.loading=false; renderStats();
}
function openStats(){ S.view="stats"; S.st.tip=""; window.scrollTo(0,0); renderStats(); loadStats(); }
function closeStats(){ S.view="list"; $("head").innerHTML=""; render(); window.scrollTo(0,0); }
function barsHtml(list, max, label){
  // waagerechte Balken: Name, Balken, Zahl
  return '<div class="hbars">'+list.map(x=>'<div class="hb"><div class="hl"><span>'+esc(x.name)+(x.sub?'<small>'+esc(x.sub)+'</small>':'')+'</span><b>'+x.n+'</b></div>'+
    '<div class="ht"><span style="width:'+Math.max(2,Math.round(x.n/max*100))+'%"></span></div></div>').join("")+'</div>';
}
function renderStats(){
  const st=S.st, h=$("head"), app=$("app");
  const ranges=[["week","Woche"],["month","Monat"],["year","Jahr"]];
  const p=period(st.range, st.offset);
  h.innerHTML='<div class="title"><button class="backbtn" data-st="back">‹ Liste</button><h1 class="sttitle">Statistik</h1><span style="width:64px"></span></div>'+
    '<div class="seg3">'+ranges.map(([k,l])=>'<button class="'+(st.range===k?'on':'')+'" data-st="range" data-k="'+k+'">'+l+'</button>').join("")+'</div>'+
    '<div class="pnav"><button data-st="prev" aria-label="früher">‹</button><b>'+esc(p.label)+'</b><button data-st="next" aria-label="später"'+(st.offset>=0?' disabled':'')+'>›</button></div>'+
    '<div class="shopbar stshops"><button class="'+(st.store?'':'on')+'" data-st="store" data-k="">Alle Läden</button>'+stores().map(s=>'<button class="'+(st.store===s.id?'on':'')+'" data-st="store" data-k="'+esc(s.id)+'">'+esc(s.name)+'</button>').join("")+'</div>';
  if(st.err){ app.innerHTML='<div class="empty">'+esc(st.err)+'<br><button class="linkbtn" data-st="reload">Nochmal versuchen</button></div>'; return; }
  if(!st.rows){ app.innerHTML='<div class="empty"><div class="spin"></div>Statistik wird geladen …</div>'; return; }
  const inStore = r => !st.store || r.store===st.store;
  const rows = st.rows.filter(r=>inStore(r) && r.at>=p.from && r.at<p.to);
  const prevP = period(st.range, st.offset-1);
  const prevN = st.rows.filter(r=>inStore(r) && r.at>=prevP.from && r.at<prevP.to).length;
  const prevName = {week:"Vorwoche", month:"Vormonat", year:"Vorjahr"}[st.range];
  const days = new Set(rows.map(r=>dayKey(r.at))).size;
  const items = new Map(); rows.forEach(r=>{ const e=items.get(r.id)||{id:r.id,name:r.name,store:r.store,n:0}; e.n++; items.set(r.id,e); });
  const cur = id => S.items.find(i=>i.id===id);
  let html='';
  // Kennzahlen
  const diff = rows.length-prevN;
  html+='<div class="tiles">'+
    '<div class="tile"><div class="tv">'+rows.length+'</div><div class="tl">Sachen gekauft</div>'+(prevN||rows.length?'<div class="td">'+(diff===0?'wie':(diff>0?'+':'−')+Math.abs(diff)+' ggü.')+' '+prevName+'</div>':'')+'</div>'+
    '<div class="tile"><div class="tv">'+items.size+'</div><div class="tl">verschiedene Artikel</div></div>'+
    '<div class="tile"><div class="tv">'+days+'</div><div class="tl">Einkaufstage</div></div>'+
    '<div class="tile"><div class="tv">'+(days?(Math.round(rows.length/days*10)/10).toLocaleString("de-DE"):"–")+'</div><div class="tl">Sachen pro Einkaufstag</div></div></div>';
  if(!rows.length){
    html+='<div class="card-s"><div class="empty" style="padding:24px 8px">In diesem Zeitraum wurde '+(st.store?'bei '+esc(storeName(st.store))+' ':'')+'nichts abgehakt.</div></div>';
  } else {
    // Verlauf
    const counts=p.buckets.map(b=>rows.filter(r=>r.at>=b.from && r.at<b.to).length), max=Math.max(1,...counts);
    html+='<div class="card-s"><div class="ch"><b>Verlauf</b><span id="sttip">'+(st.tip?esc(st.tip):'Balken antippen für Details')+'</span></div>'+
      '<div class="vbars r-'+st.range+'"><span class="ymax">'+max+'</span>'+p.buckets.map((b,i)=>'<button class="vb" data-st="tip" data-k="'+esc(b.tip+": "+counts[i]+" "+(counts[i]===1?"Sache":"Sachen"))+'" title="'+esc(b.tip+": "+counts[i])+'">'+
        '<span class="vbar'+(counts[i]?'':' zero')+'" style="height:'+(counts[i]?Math.max(4,counts[i]/max*100):0)+'%"></span><span class="vl">'+esc(b.label)+'</span></button>').join("")+'</div></div>';
    // Am häufigsten gekauft
    const top=[...items.values()].sort((a,b)=>b.n-a.n || a.name.localeCompare(b.name,"de"));
    const shown=st.topAll?top:top.slice(0,10);
    html+='<div class="card-s"><div class="ch"><b>Am häufigsten gekauft</b><span>'+top.length+' Artikel</span></div>'+
      barsHtml(shown.map(x=>{ const c=cur(x.id); return {name:c?c.name:x.name, sub:st.store?"":storeName(x.store), n:x.n}; }), top[0].n)+
      (top.length>10?'<button class="linkbtn" data-st="topall">'+(st.topAll?'Weniger anzeigen':'Alle '+top.length+' anzeigen')+'</button>':'')+'</div>';
    // Warengruppen
    const grp=new Map(); rows.forEach(r=>{ const c=cur(r.id); const g=G.groupOf(c||{name:r.name,cat:r.cat}); grp.set(g,(grp.get(g)||0)+1); });
    const gl=[...grp].map(([g,n])=>({name:G.groupName(g),n})).sort((a,b)=>b.n-a.n);
    html+='<div class="card-s"><div class="ch"><b>Nach Warengruppe</b></div>'+barsHtml(gl, gl[0].n)+'</div>';
    // Läden und Labels
    if(!st.store){
      const sl=stores().map(s=>({name:s.name,n:rows.filter(r=>r.store===s.id).length})).filter(x=>x.n).sort((a,b)=>b.n-a.n);
      if(sl.length>1) html+='<div class="card-s"><div class="ch"><b>Nach Laden</b></div>'+barsHtml(sl, sl[0].n)+'</div>';
    }
    const lab=new Map(); rows.forEach(r=>r.shops.forEach(l=>lab.set(l,(lab.get(l)||0)+1)));
    if(lab.size){ const ll=[...lab].map(([name,n])=>({name,n})).sort((a,b)=>b.n-a.n);
      html+='<div class="card-s"><div class="ch"><b>Nach Label</b><span>nur Sachen mit Label</span></div>'+barsHtml(ll, ll[0].n)+'</div>'; }
    // Wer hat abgehakt
    const pp=new Map(); rows.forEach(r=>{ const k=r.person||"ohne Angabe"; pp.set(k,(pp.get(k)||0)+1); });
    const pl=[...pp].map(([name,n])=>({name,n})).sort((a,b)=>b.n-a.n);
    html+='<div class="card-s"><div class="ch"><b>Wer hat abgehakt</b></div>'+barsHtml(pl, pl[0].n)+'</div>';
  }
  html+='<div class="small" style="margin:14px 6px 0">Gezählt wird jedes Abhaken'+(st.first?' seit '+st.first.toLocaleDateString("de-DE"):'')+
    '. Käufe aus der alten Apple-Notiz haben kein Datum und fehlen hier – sie stecken nur in der „×“-Zahl bei „Schon mal gekauft“.</div>';
  app.innerHTML=html;
}
document.addEventListener("click",e=>{
  const b=e.target.closest("[data-st]"); if(!b || S.view!=="stats") return;
  const st=S.st, k=b.dataset.st;
  if(k==="back") closeStats();
  else if(k==="range"){ st.range=b.dataset.k; st.offset=0; st.tip=""; renderStats(); }
  else if(k==="prev"){ st.offset--; st.tip=""; renderStats(); }
  else if(k==="next"){ if(st.offset<0) st.offset++; st.tip=""; renderStats(); }
  else if(k==="store"){ st.store=b.dataset.k; st.tip=""; renderStats(); }
  else if(k==="topall"){ st.topAll=!st.topAll; renderStats(); }
  else if(k==="reload") loadStats();
  else if(k==="tip"){ st.tip=b.dataset.k; const t=$("sttip"); if(t) t.textContent=st.tip;
    document.querySelectorAll(".vb.sel").forEach(x=>x.classList.remove("sel")); b.classList.add("sel"); }
});

/* ---------- Ereignisse ---------- */
let pressT=null, pressed=false;
document.addEventListener("pointerdown",e=>{
  const b=e.target.closest("[data-readd]"); if(!b) return;
  pressed=false; clearTimeout(pressT);
  pressT=setTimeout(()=>{ pressed=true; openEdit(b.dataset.readd); },550);
});
["pointerup","pointercancel","pointerleave"].forEach(ev=>document.addEventListener(ev,()=>clearTimeout(pressT)));
document.addEventListener("contextmenu",e=>{ if(e.target.closest("[data-readd]")) e.preventDefault(); });

document.addEventListener("click",e=>{
  if($("modal").contains(e.target)) return;
  const t=e.target.closest("[data-store],[data-tick],[data-edit],[data-readd],[data-sugg],[data-act],[data-sort],[data-me],[data-filter],[data-drop]"); if(!t) return;
  if(t.dataset.drop){ dropItem(t.dataset.drop); return; }
  if(t.dataset.filter!=null){ const l=t.dataset.filter, cur=S.filter[S.cur]||[];
    S.filter[S.cur] = !l ? [] : cur.includes(l) ? cur.filter(x=>x!==l) : cur.concat([l]); render(); return; }
  if(t.dataset.sort){ if(t.dataset.sort==="open") S.sortOpen=t.dataset.k; else S.histBy[S.cur]=t.dataset.k; saveLocal(); render(); return; }
  if(t.dataset.me){ setMe(t.dataset.me); render(); toast("Danke, "+t.dataset.me+"! Benachrichtigungen kannst du oben rechts einschalten."); return; }
  if(t.dataset.store){ S.cur=t.dataset.store; saveLocal(); render(); window.scrollTo(0,0); return; }
  if(t.dataset.tick) toggle(t.dataset.tick);
  else if(t.dataset.edit) openEdit(t.dataset.edit);
  else if(t.dataset.readd){ if(pressed){ pressed=false; return; } const it=S.items.find(i=>i.id===t.dataset.readd); if(it){ addItem(it.name,it.store); toast("„"+it.name+"“ wieder auf der Liste"); } }
  else if(t.dataset.sugg){ const it=S.items.find(i=>i.id===t.dataset.sugg); if(it){ S.q=""; addItem(it.name,S.cur); const q=$("q"); if(q){ q.value=""; q.focus(); } renderSugg(); } }
  else if(t.dataset.act==="menu") openMenu();
  else if(t.dataset.act==="stats") openStats();
  else if(t.dataset.act==="allHist"){ S.showAllHist=!S.showAllHist; saveView(); render(); }
});
document.addEventListener("keydown",e=>{ if(e.key==="Escape" && $("modal").innerHTML) closeModal(); });

/* ---------- Start ---------- */
loadLocal(); fixCur(); render(); refresh(true);
if(pushSupported()) navigator.serviceWorker.register("/sw.js",{scope:"/"}).catch(()=>{});
document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="visible") refresh(); });
window.addEventListener("online",()=>refresh());
setInterval(()=>{ if(document.visibilityState==="visible") refresh(); }, POLL_MS);
})();
