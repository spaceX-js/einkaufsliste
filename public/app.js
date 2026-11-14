(function(){
"use strict";

const STORE_KEY = "einkaufsliste.v1";
const POLL_MS = 4000;
const DEFAULT_STORES = [
  {id:"supermarkt",name:"Supermarkt"},{id:"drogerie",name:"Drogerie"},
  {id:"tier",name:"Fressnapf"},{id:"baumarkt",name:"Baumarkt"},{id:"ikea",name:"IKEA"}
];
const S = { loaded:false, online:true, rev:null, items:[], stores:null, cur:null, q:"", showAllHist:false, pending:0, dirty:false };

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
  try{ const o=JSON.parse(localStorage.getItem(STORE_KEY)||"null"); if(o){ S.items=o.items||[]; S.stores=o.stores||null; S.cur=o.cur||null; if(S.items.length) S.loaded=true; } }catch(e){}
}
function saveLocal(){ try{ localStorage.setItem(STORE_KEY, JSON.stringify({items:S.items, stores:S.stores, cur:S.cur})); }catch(e){} }

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
function itemBody(it){ return {id:it.id,name:it.name,store:it.store,note:it.note||"",done:!!it.done,addedAt:it.addedAt||null,doneAt:it.doneAt||null}; }
function patchLocal(id, data){ const it=S.items.find(i=>i.id===id); if(it) Object.assign(it,data); else S.items.push(Object.assign({id},data)); saveLocal(); return S.items.find(i=>i.id===id); }
function pushItem(it){ send("/api/item", itemBody(it)); }

/* ---------- Aktionen ---------- */
function addItem(name, store){
  name=String(name||"").trim(); if(!name) return;
  store=store||S.cur;
  const ex = S.items.find(i=>i.store===store && norm(i.name)===norm(name));
  if(ex){
    if(!ex.done){ toast("„"+ex.name+"“ steht schon drauf"); return; }
    pushItem(patchLocal(ex.id,{done:false, addedAt:now()})); render();
  } else {
    const id=uid();
    pushItem(patchLocal(id,{name:name.slice(0,120), store, note:"", done:false, addedAt:now(), doneAt:null})); render();
  }
}
function toggle(id){
  const it=S.items.find(i=>i.id===id); if(!it) return;
  const before={done:it.done, doneAt:it.doneAt||null, addedAt:it.addedAt||null};
  const data = it.done ? {done:false, addedAt:now()} : {done:true, doneAt:now()};
  pushItem(patchLocal(id,data)); render();
  if(data.done) toast("„"+it.name+"“ abgehakt", ()=>{ pushItem(patchLocal(id,before)); render(); });
}
function removeItem(id){
  const it=S.items.find(i=>i.id===id); if(!it) return;
  const copy=Object.assign({},it);
  S.items=S.items.filter(i=>i.id!==id); saveLocal(); render();
  send("/api/item/delete",{id});
  toast("„"+it.name+"“ gelöscht", ()=>{ pushItem(patchLocal(id,copy)); render(); });
}

/* ---------- Anzeige ---------- */
function openOf(store){ return S.items.filter(i=>i.store===store && !i.done).sort((a,b)=>(b.addedAt||"").localeCompare(a.addedAt||"")); }
function histOf(store){ return S.items.filter(i=>i.store===store && i.done).sort((a,b)=>(b.doneAt||"").localeCompare(a.doneAt||"")); }
function fixCur(){ if(!stores().find(s=>s.id===S.cur)) S.cur=stores()[0].id; }

function storeBtns(){
  return stores().map(s=>{ const n=openOf(s.id).length;
    return '<button class="store'+(s.id===S.cur?' on':'')+'" data-store="'+esc(s.id)+'">'+esc(s.name)+'<span class="cnt">'+n+'</span></button>'; }).join("");
}
const GEAR='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>';
function renderHead(light){
  const h=$("head");
  if(light && $("storebar")){
    // Nur Läden, Platzhalter und Status aktualisieren, damit das Eingabefeld (und die Tastatur) stehen bleibt
    $("storebar").innerHTML=storeBtns();
    const q=$("q"); if(q) q.placeholder="Was brauchen wir bei "+storeName(S.cur)+"?";
    $("net").textContent = S.online ? "" : "offline";
    renderSugg(); return;
  }
  h.innerHTML='<div class="title"><h1>Einkauf<span class="net" id="net">'+(S.online?"":"offline")+'</span></h1><button class="iconbtn" data-act="menu" aria-label="Einstellungen">'+GEAR+'</button></div>'+
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
  renderHead(!!$("storebar"));
  const app=$("app");
  if(!S.loaded){ app.innerHTML='<div class="empty"><div class="spin"></div>Liste wird geladen …</div>'; return; }
  const open=openOf(S.cur), hist=histOf(S.cur);
  let h='<div class="sec"><b>Einkaufen</b><span>'+(open.length?open.length+' Sache'+(open.length>1?'n':''):'')+'</span></div>';
  if(open.length) h+='<div class="list">'+open.map(rowHtml).join("")+'</div>';
  else h+='<div class="list"><div class="empty">Alles erledigt 🎉<br><span class="small">Oben eintippen oder unten antippen, um etwas hinzuzufügen.</span></div></div>';
  if(hist.length){
    const lim=S.showAllHist?hist.length:24;
    h+='<div class="sec"><b>Schon mal gekauft</b><span>antippen = wieder drauf</span></div><div class="hist">';
    h+=hist.slice(0,lim).map(i=>'<button data-readd="'+esc(i.id)+'">'+esc(i.name)+'</button>').join("")+'</div>';
    if(hist.length>lim) h+='<button class="linkbtn" data-act="allHist">Alle '+hist.length+' anzeigen</button>';
    else if(S.showAllHist && hist.length>24) h+='<button class="linkbtn" data-act="allHist">Weniger anzeigen</button>';
    h+='<div class="small" style="margin:8px 4px 0">Gedrückt halten, um einen Eintrag zu bearbeiten oder zu löschen.</div>';
  }
  app.innerHTML=h;
}
function rowHtml(i){
  return '<div class="row"><button class="tick" data-tick="'+esc(i.id)+'"><span class="box"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span><span class="t"><div class="n">'+esc(i.name)+'</div>'+(i.note?'<div class="d">'+esc(i.note)+'</div>':'')+'</span></button><button class="more" data-edit="'+esc(i.id)+'" aria-label="Bearbeiten">⋯</button></div>';
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
  let st=it.store;
  const m=sheet('<h3>Eintrag bearbeiten</h3>'+
    '<label class="f"><span>Was?</span><input id="e_name" maxlength="120" value="'+esc(it.name)+'"></label>'+
    '<label class="f"><span>Notiz (Menge, Marke …)</span><input id="e_note" maxlength="300" value="'+esc(it.note||"")+'" placeholder="z. B. 2×, bio, von Edeka"></label>'+
    '<label class="f"><span>Laden</span><div class="chips" id="e_st">'+stores().map(s=>'<button type="button" data-s="'+esc(s.id)+'" class="'+(s.id===st?'on':'')+'">'+esc(s.name)+'</button>').join("")+'</div></label>'+
    '<div class="acts"><button class="btn danger" id="e_del">Löschen</button><button class="btn ghost" id="e_x">Abbrechen</button><button class="btn" id="e_ok">Fertig</button></div>');
  m.querySelectorAll("#e_st button").forEach(b=>b.onclick=()=>{ st=b.dataset.s; m.querySelectorAll("#e_st button").forEach(x=>x.classList.toggle("on",x===b)); });
  $("e_x").onclick=closeModal;
  $("e_del").onclick=()=>{ $("modal").innerHTML=""; removeItem(id); };
  $("e_ok").onclick=()=>{
    const name=$("e_name").value.trim(), note=$("e_note").value.trim();
    if(!name){ toast("Bitte einen Namen eingeben"); return; }
    const data={}; if(name!==it.name) data.name=name; if(note!==(it.note||"")) data.note=note; if(st!==it.store) data.store=st;
    if(Object.keys(data).length){ pushItem(patchLocal(id,data)); if(data.store) toast("Verschoben nach "+storeName(st)); }
    closeModal();
  };
}
function openMenu(){
  const m=sheet('<h3>Einstellungen</h3>'+
    '<button class="btn ghost block" id="m_st">Läden bearbeiten</button>'+
    '<div class="sec" style="margin:18px 0 8px"><b>Passwort ändern</b></div>'+
    '<label class="f"><span>Aktuelles Passwort</span><input id="pw_old" type="password" autocomplete="current-password"></label>'+
    '<label class="f"><span>Neues Passwort (mind. 8 Zeichen)</span><input id="pw_new" type="password" autocomplete="new-password"></label>'+
    '<button class="btn ghost block" id="m_pw">Passwort ändern</button>'+
    '<div class="small" style="margin:8px 2px 0">Danach müsst ihr euch beide einmal mit dem neuen Passwort anmelden.</div>'+
    '<div class="acts" style="margin-top:18px"><button class="btn danger" id="m_out">Abmelden</button><button class="btn" id="m_x">Schließen</button></div>');
  $("m_x").onclick=closeModal;
  $("m_st").onclick=openStores;
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
    const m=sheet('<h3>Läden</h3><div class="small" style="margin-bottom:10px">Umbenennen, Reihenfolge ändern oder neue Läden anlegen. Ein Laden lässt sich nur löschen, wenn nichts mehr darin steht.</div>'+
      list.map((s,ix)=>'<div class="srow"><input data-ix="'+ix+'" maxlength="40" value="'+esc(s.name)+'"><button data-up="'+ix+'" aria-label="nach oben"'+(ix?'':' disabled')+'>↑</button><button data-del="'+ix+'" aria-label="löschen">✕</button></div>').join("")+
      '<button class="linkbtn" id="s_add">+ Laden hinzufügen</button>'+
      '<div class="acts"><button class="btn ghost" id="s_x">Abbrechen</button><button class="btn" id="s_ok">Speichern</button></div>');
    const sync=()=>m.querySelectorAll("input[data-ix]").forEach(i=>{ list[+i.dataset.ix].name=i.value; });
    m.querySelectorAll("[data-up]").forEach(b=>b.onclick=()=>{ sync(); const i=+b.dataset.up; [list[i-1],list[i]]=[list[i],list[i-1]]; draw(); });
    m.querySelectorAll("[data-del]").forEach(b=>b.onclick=()=>{ sync(); const s=list[+b.dataset.del];
      const n=S.items.filter(i=>i.store===s.id).length;
      if(n){ toast(s.name+" enthält noch "+n+" Einträge"); return; }
      list.splice(+b.dataset.del,1); draw(); });
    $("s_add").onclick=()=>{ sync(); list.push({id:"s"+Date.now().toString(36),name:""}); draw(); const ins=m.querySelectorAll("input[data-ix]"); ins[ins.length-1].focus(); };
    $("s_x").onclick=closeModal;
    $("s_ok").onclick=()=>{
      sync(); list=list.map(s=>({id:s.id,name:s.name.trim()})).filter(s=>s.name);
      if(!list.length){ toast("Mindestens ein Laden"); return; }
      S.stores=list; fixCur(); saveLocal(); closeModal();
      send("/api/stores",{list});
    };
  }
  draw();
}

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
  const t=e.target.closest("[data-store],[data-tick],[data-edit],[data-readd],[data-sugg],[data-act]"); if(!t) return;
  if(t.dataset.store){ S.cur=t.dataset.store; S.showAllHist=false; saveLocal(); render(); window.scrollTo(0,0); return; }
  if(t.dataset.tick) toggle(t.dataset.tick);
  else if(t.dataset.edit) openEdit(t.dataset.edit);
  else if(t.dataset.readd){ if(pressed){ pressed=false; return; } const it=S.items.find(i=>i.id===t.dataset.readd); if(it){ addItem(it.name,it.store); toast("„"+it.name+"“ wieder auf der Liste"); } }
  else if(t.dataset.sugg){ const it=S.items.find(i=>i.id===t.dataset.sugg); if(it){ S.q=""; addItem(it.name,S.cur); const q=$("q"); if(q){ q.value=""; q.focus(); } renderSugg(); } }
  else if(t.dataset.act==="menu") openMenu();
  else if(t.dataset.act==="allHist"){ S.showAllHist=!S.showAllHist; render(); }
});
document.addEventListener("keydown",e=>{ if(e.key==="Escape" && $("modal").innerHTML) closeModal(); });

/* ---------- Start ---------- */
loadLocal(); fixCur(); render(); refresh(true);
document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="visible") refresh(); });
window.addEventListener("online",()=>refresh());
setInterval(()=>{ if(document.visibilityState==="visible") refresh(); }, POLL_MS);
})();
