
const DEFAULT_SUBJECTS = [];
const DEFAULT_KLAUSUR_SLOTS = {};
let SUBJECTS = [...DEFAULT_SUBJECTS];
let KLAUSUR_SLOTS = {...DEFAULT_KLAUSUR_SLOTS};
let SEMESTERS = [];   // Array von Perioden-IDs, z.B. ["p1","p2","p3"] — Anzahl & Namen frei konfigurierbar
let SEM_LABELS = {};  // Perioden-ID -> Anzeigename, z.B. {"p1":"Halbjahr 1"}
const TYPES = {
  klausuren:["Klausur","Test","Nachschreibeklausur"],
  muendlich:["Abfrage","Referat","Präsentation","Unterrichtsbeteiligung","Prüfungsgespräch"],
  sonstige:["Hausaufgaben","Projektarbeit","Portfolio","Protokoll","Facharbeit","Gruppenarbeit","Praktische Leistung"]
};
const TAB_TITLES = {overview:"Übersicht",klausuren:"Klausuren",muendlich:"Mündliche Noten",sonstige:"Sonstige Leistungen",ziele:"Zielnoten-Rechner",absenzen:"Fehlstunden/Absenzen",abi:"Abitur/Fachabi-Modul",mittelstufe:"Mittelstufen-Modus",statistik:"Statistik & Analyse",faecher:"Einstellungen"};

/* ======================= Profile (mehrere Schüler/Datensätze im selben Browser) =======================
 * Jedes Profil hat seinen eigenen, isolierten Datensatz (Config, Fächer, Noten, Abi-Einstellungen).
 * Das zuerst angelegte/verwendete Profil heißt "default" und nutzt bewusst dieselben, unpräfigierten
 * Storage-Keys wie vor Einführung dieses Features (z.B. "notenkompass_config") — so bleibt bestehenden
 * Nutzern ihr Datensatz ohne jede Migration erhalten. Jedes weitere Profil bekommt eigene, präfigierte
 * Keys ("notenkompass_p_<id>_config" usw.). Das Theme (hell/dunkel) ist bewusst profilübergreifend.
 */
const PROFILES_KEY = "notenkompass_profiles";
const ACTIVE_PROFILE_KEY = "notenkompass_active_profile";
let PROFILES = [{id:"default", name:"Profil 1"}];
let activeProfileId = "default";
function pKey(name){
  return activeProfileId==="default" ? "notenkompass_"+name : "notenkompass_p_"+activeProfileId+"_"+name;
}
async function loadProfiles(){
  try{
    const res=await window.storage.get(PROFILES_KEY);
    if(res&&res.value){
      const parsed=JSON.parse(res.value);
      if(Array.isArray(parsed)&&parsed.length) PROFILES=parsed;
    }
    const act=await window.storage.get(ACTIVE_PROFILE_KEY);
    if(act&&act.value&&PROFILES.some(p=>p.id===act.value)) activeProfileId=act.value;
  }catch(e){ /* noch keine Profile gespeichert — Standard "default" bleibt aktiv */ }
}
async function saveProfiles(){
  try{ await window.storage.set(PROFILES_KEY, JSON.stringify(PROFILES)); }catch(e){ console.error(e); }
}
async function setActiveProfile(id){
  activeProfileId=id;
  try{ await window.storage.set(ACTIVE_PROFILE_KEY, id); }catch(e){ /* best effort */ }
}
function newProfileId(){
  let n=1; const ids=PROFILES.map(p=>p.id);
  while(ids.includes("prof"+n)) n++;
  return "prof"+n;
}
async function createProfile(name){
  const id=newProfileId();
  PROFILES.push({id, name:name||("Profil "+(PROFILES.length+1))});
  await saveProfiles();
  return id;
}
async function switchToProfile(id){
  await setActiveProfile(id);
  document.getElementById("content").innerHTML='<div style="padding:60px;text-align:center;color:var(--text-muted)">Lade Profil…</div>';
  await loadProfileData();
}
async function loadProfileData(){
  // Zustand aus dem vorherigen Profil zurücksetzen, damit nichts dorthin "durchsickert", wenn das
  // neue/gewechselte Profil noch keine eigenen gespeicherten Daten hat (loadData/loadAbiSettings/
  // loadSubjects überschreiben nur bei einem Treffer, lassen sonst den aktuellen In-Memory-Stand stehen).
  CONFIG=null;
  SUBJECTS=[];
  KLAUSUR_SLOTS={};
  data={klausuren:[],muendlich:[],sonstige:[]};
  abiSettings=loadAbiSettingsDefault();
  const hasConfig=await loadConfig();
  await loadSubjects();
  await Promise.all([loadData(), loadAbiSettings()]);
  if(!hasConfig || !SUBJECTS.length){
    runSetupWizard();
    return;
  }
  if(CONFIG&&CONFIG.abiturModule&&CONFIG.abiturModule.numPruefungsfaecher) resizeBlock2(CONFIG.abiturModule.numPruefungsfaecher);
  activeTab="overview";
  render();
}
async function createProfileFromForm(){
  const input=document.getElementById("f-newprofile");
  const name=input?input.value.trim():"";
  if(!name){ showToast("Bitte einen Namen für das neue Profil eingeben."); return; }
  const id=await createProfile(name);
  await switchToProfile(id);
}
async function renameProfile(id,name){
  const p=PROFILES.find(p=>p.id===id);
  if(!p) return;
  p.name=name.trim()||p.name;
  await saveProfiles();
  render();
}
function requestDeleteProfile(id){
  pendingDelete={kind:"profile",id};
  render();
}
async function confirmDeleteProfile(id){
  if(PROFILES.length<=1){ showToast("Das letzte Profil kann nicht gelöscht werden."); pendingDelete=null; render(); return; }
  if(id!=="default"){
    try{
      await Promise.all(["config","subjects","data","abi_settings"].map(k=>window.storage.remove&&window.storage.remove("notenkompass_p_"+id+"_"+k)));
    }catch(e){ /* best effort */ }
  }
  PROFILES=PROFILES.filter(p=>p.id!==id);
  await saveProfiles();
  pendingDelete=null;
  if(activeProfileId===id){
    await switchToProfile(PROFILES[0].id);
  } else {
    render();
  }
}

/* ======================= Konfiguration (Perioden, Module) ======================= */
// CONFIG wird beim ersten Start über den Einrichtungsassistenten erzeugt (siehe setup.js-Abschnitt unten).
let CONFIG = null; // {version, periods:[{id,label}], abiturModuleEnabled, abiturModule:{bundesland, lkDoubleFromIndex, fachabiPeriodsCount, numLK, numPruefungsfaecher}}

/*
 * Bundesland-Voreinstellungen für die Abitur-Gesamtqualifikation (Block I/II nach KMK-Modell).
 * WICHTIG: Dieses Tool rechnet ein VEREINFACHTES Modell (Durchschnitt aller eingetragenen Noten,
 * LK doppelt gewichtet, keine Modellierung der exakten Einbringungspflicht/Kurswahl). Die Werte
 * numLK (Anzahl Leistungskurse/-fächer) und numPruefungsfaecher (Anzahl Abiturprüfungsfächer in
 * Block II) bestimmen die Gewichtung und sind die Haupt-Stellschrauben, in denen sich die Bundes-
 * länder unterscheiden. Die Zahlen wurden anhand öffentlich zugänglicher Quellen (Kultusministerien,
 * Schul-Informationsblätter, Stand 2025/26) recherchiert; die Vertrauenseinschätzung (confidence)
 * zeigt an, wie gut die jeweilige Quelle abgesichert war. Bitte im Zweifel mit deiner Schule/
 * Oberstufenberatung abgleichen — Verordnungen ändern sich und können von Schule zu Schule in
 * Detailfragen abweichen.
 */
const BUNDESLAND_PRESETS = {
  BW: {name:"Baden-Württemberg", numLK:3, numPruefungsfaecher:5, confidence:"mittel", note:"3 Leistungsfächer (statt 2), davon zählen 2 doppelt. Seminarkurs als mögliche 5. Prüfungskomponente."},
  BY: {name:"Bayern", numLK:2, numPruefungsfaecher:5, confidence:"hoch", note:"Fächerkatalog-basiertes System mit W-/P-Seminar statt klassischer LK-Logik; hier als 2 LK angenähert."},
  BE: {name:"Berlin", numLK:2, numPruefungsfaecher:5, confidence:"mittel", note:"5. Prüfungskomponente (Präsentationsprüfung/BLL) ist verpflichtend."},
  BB: {name:"Brandenburg", numLK:2, numPruefungsfaecher:4, confidence:"mittel", note:"Block-II-Gewichtung nicht vollständig verifiziert, Standardannahme (5-fach) übernommen."},
  HB: {name:"Bremen", numLK:2, numPruefungsfaecher:4, confidence:"mittel", note:"LK der ersten 3 Halbjahre zählen doppelt (Sonderregel, hier vereinfacht wie 'ab Beginn' behandelt)."},
  HH: {name:"Hamburg", numLK:3, numPruefungsfaecher:4, confidence:"mittel", note:"Profiloberstufe ohne klassisches LK-System; 3 doppelt gewertete Fächer hier als 'LK' angenähert."},
  HE: {name:"Hessen", numLK:2, numPruefungsfaecher:5, confidence:"hoch", note:"Ursprungsmodell dieser App."},
  MV: {name:"Mecklenburg-Vorpommern", numLK:2, numPruefungsfaecher:5, confidence:"mittel-hoch", note:""},
  NI: {name:"Niedersachsen", numLK:3, numPruefungsfaecher:5, confidence:"hoch", note:"3 Prüfungsfächer auf erhöhtem Niveau zählen doppelt (statt klassischer 2-LK-Logik)."},
  NW: {name:"Nordrhein-Westfalen", numLK:2, numPruefungsfaecher:4, confidence:"hoch", note:""},
  RP: {name:"Rheinland-Pfalz", numLK:3, numPruefungsfaecher:4, confidence:"hoch", note:"3 Leistungsfächer (statt 2), davon zählen 2 doppelt."},
  SL: {name:"Saarland", numLK:2, numPruefungsfaecher:5, confidence:"niedrig", note:"Quellenlage unklar — Standardwerte (analog Hessen) angenommen, bitte unbedingt mit Schule abgleichen."},
  SN: {name:"Sachsen", numLK:2, numPruefungsfaecher:5, confidence:"mittel-hoch", note:""},
  ST: {name:"Sachsen-Anhalt", numLK:2, numPruefungsfaecher:5, confidence:"mittel-hoch", note:"Kein klassisches LK-Label, sondern 2 wählbare Fächer mit doppelter Gewichtung."},
  SH: {name:"Schleswig-Holstein", numLK:3, numPruefungsfaecher:5, confidence:"hoch", note:"3 Kernfächer auf erhöhtem Niveau statt klassischer 2-LK-Logik; 4 oder 5 Prüfungsfächer möglich."},
  TH: {name:"Thüringen", numLK:2, numPruefungsfaecher:5, confidence:"mittel-hoch", note:"Verpflichtendes Seminarfach, kann 5. Prüfungskomponente sein."},
  custom: {name:"Benutzerdefiniert", numLK:2, numPruefungsfaecher:5, confidence:"", note:"Stelle Anzahl Leistungskurse und Prüfungsfächer selbst ein."}
};
function defaultConfig(){
  return {
    version: 1,
    periods: [{id:"p1",label:"Periode 1"},{id:"p2",label:"Periode 2"}],
    abiturModuleEnabled: false,
    abiturModule: { bundesland:"HE", lkDoubleFromIndex: 2, fachabiPeriodsCount: 2, numLK: 2, numPruefungsfaecher: 5 },
    mittelstufeModuleEnabled: false,
    absenzenModuleEnabled: false
  };
}
function applyConfig(cfg){
  CONFIG = cfg;
  SEMESTERS = CONFIG.periods.map(p=>p.id);
  SEM_LABELS = {};
  CONFIG.periods.forEach(p=>{ SEM_LABELS[p.id]=p.label; });
  if(!SEMESTERS.includes(activeSem)) activeSem = SEMESTERS[0]||null;
  exportSemesters = {};
  SEMESTERS.forEach(s=>exportSemesters[s]=true);
}
async function loadConfig(){
  try{
    const res = await window.storage.get(pKey("config"));
    if(res && res.value){
      const parsed = JSON.parse(res.value);
      if(parsed && Array.isArray(parsed.periods) && parsed.periods.length){
        applyConfig(Object.assign(defaultConfig(), parsed, {abiturModule:Object.assign(defaultConfig().abiturModule, parsed.abiturModule||{})}));
        return true;
      }
    }
  }catch(e){ /* keine Konfiguration gespeichert */ }
  return false;
}
async function saveConfig(){
  try{ await window.storage.set(pKey("config"), JSON.stringify(CONFIG)); }catch(e){ console.error(e); }
}
function periodIndex(sem){ return SEMESTERS.indexOf(sem); }
function isDoubleWeightPeriod(sem){
  if(!CONFIG||!CONFIG.abiturModuleEnabled) return false;
  return periodIndex(sem) >= (CONFIG.abiturModule.lkDoubleFromIndex ?? SEMESTERS.length);
}
function fachabiPeriods(){
  const n=(CONFIG&&CONFIG.abiturModule&&CONFIG.abiturModule.fachabiPeriodsCount)||2;
  return SEMESTERS.slice(0, n);
}
function resizeBlock2(newCount){
  const cur=abiSettings.block2;
  if(newCount>cur.length){
    for(let i=cur.length;i<newCount;i++) cur.push({fach:"",punkte:""});
  } else if(newCount<cur.length){
    abiSettings.block2=cur.slice(0,newCount);
  }
}
async function setBundesland(code){
  const preset=BUNDESLAND_PRESETS[code];
  if(!preset) return;
  CONFIG.abiturModule.bundesland=code;
  if(code!=="custom"){
    CONFIG.abiturModule.numLK=preset.numLK;
    CONFIG.abiturModule.numPruefungsfaecher=preset.numPruefungsfaecher;
  }
  if(abiSettings.lk.length>CONFIG.abiturModule.numLK) abiSettings.lk=abiSettings.lk.slice(0,CONFIG.abiturModule.numLK);
  resizeBlock2(CONFIG.abiturModule.numPruefungsfaecher);
  await saveConfig();
  await saveAbiSettings();
  render();
}
async function setNumLK(val){
  const n=Math.max(2,Math.min(4,Number(val)||2));
  CONFIG.abiturModule.numLK=n;
  if(abiSettings.lk.length>n) abiSettings.lk=abiSettings.lk.slice(0,n);
  await saveConfig();
  await saveAbiSettings();
  render();
}
async function setNumPruefungsfaecher(val){
  const n=Math.max(4,Math.min(6,Number(val)||5));
  CONFIG.abiturModule.numPruefungsfaecher=n;
  resizeBlock2(n);
  await saveConfig();
  await saveAbiSettings();
  render();
}

let activeTab = "overview";
let activeSem = null;
let editState = null; // {cat, idx} während ein Eintrag bearbeitet wird
let subjFilter = "alle"; // Fächer-Filter in den Kategorie-Ansichten
let scenarioMode = false; // "Was-wäre-wenn" Modus in der Abi-Übersicht
let scenarioVals = {}; // Hypothetische Werte, Key "Fach|Sem" -> Punkte (0-15)
let zielPlanN = {}; // Zielnoten-Rechner: Key "Fach|Sem" -> Anzahl geplanter weiterer Prüfungen (nur UI-Zustand, nicht gespeichert)
let bulkMode = false; // Mehrfach-Eintrag Modus in den Kategorie-Ansichten
let pendingDelete = null; // {kind:'entry',cat,idx} / {kind:'subject',subj} / {kind:'period',sem} — ersetzt window.confirm (in Sandboxes oft blockiert)
let toastMessage = null; // Ersetzt window.alert (siehe oben)
let monteCarloResult = null; // Letztes Ergebnis der Monte-Carlo-Simulation (nur auf Knopfdruck neu berechnet)
let bootstrapResult = null; // Letztes Ergebnis des Bootstrap-Konfidenzintervalls (nur auf Knopfdruck neu berechnet)
let optimizerMaxExclude = 6; // Einbringungs-Optimierer: max. Anzahl ausschließbarer schwacher GK-Werte
let exportModalOpen = false;
let exportSelection = {bericht:true, noten:true, verlauf:true, abi:true, statistik:true};
let exportSemesters = {};

let data = {klausuren:[],muendlich:[],sonstige:[],absenzen:[],zielnoten:{}};
/* Füllt bei älteren/unvollständigen gespeicherten Datensätzen fehlende Felder mit sinnvollen
 * Defaults auf (z.B. wenn ein Export aus einer Vorversion ohne absenzen/zielnoten importiert wird). */
function ensureDataDefaults(){
  if(!Array.isArray(data.klausuren)) data.klausuren=[];
  if(!Array.isArray(data.muendlich)) data.muendlich=[];
  if(!Array.isArray(data.sonstige)) data.sonstige=[];
  if(!Array.isArray(data.absenzen)) data.absenzen=[];
  if(!data.zielnoten||typeof data.zielnoten!=="object") data.zielnoten={};
}

function setSyncStatus(text, isError){
  const el=document.getElementById("sync-status");
  if(!el) return;
  el.textContent=text;
  el.style.color=isError?"var(--red-fg)":"var(--text-muted)";
}

/* --- Dunkelmodus --- */
function applyTheme(theme){
  document.documentElement.setAttribute("data-theme", theme);
  const btn=document.getElementById("theme-toggle-btn");
  if(btn) btn.textContent=theme==="dark"?"☀ Hell":"🌙 Dunkel";
}
async function loadTheme(){
  try{
    const res=await window.storage.get("notenkompass_theme");
    applyTheme(res&&res.value==="dark"?"dark":"light");
  }catch(e){ applyTheme("light"); }
}
async function toggleTheme(){
  const current=document.documentElement.getAttribute("data-theme")==="dark"?"dark":"light";
  const next=current==="dark"?"light":"dark";
  applyTheme(next);
  try{ await window.storage.set("notenkompass_theme", next); }catch(e){ /* best effort */ }
}

async function loadData(){
  try{
    const res=await window.storage.get(pKey("data"));
    if(res&&res.value) data=JSON.parse(res.value);
  }catch(e){ /* noch keine Daten gespeichert */ }
  ensureDataDefaults();
}
async function loadSubjects(){
  try{
    const res=await window.storage.get(pKey("subjects"));
    if(res&&res.value){
      const parsed=JSON.parse(res.value);
      if(parsed&&Array.isArray(parsed.subjects)&&parsed.slots){
        SUBJECTS=parsed.subjects;
        KLAUSUR_SLOTS=parsed.slots;
      }
    }
  }catch(e){ /* noch keine eigene Fächerliste gespeichert, Default bleibt aktiv */ }
}
async function saveSubjects(){
  setSyncStatus("Speichert…");
  try{
    await window.storage.set(pKey("subjects"), JSON.stringify({subjects:SUBJECTS,slots:KLAUSUR_SLOTS}));
    setSyncStatus("Gespeichert ✓");
    setTimeout(()=>setSyncStatus(""), 1500);
  }catch(e){
    setSyncStatus("Speichern fehlgeschlagen", true);
    console.error(e);
  }
}
async function saveData(){
  setSyncStatus("Speichert…");
  try{
    await window.storage.set(pKey("data"), JSON.stringify(data));
    setSyncStatus("Gespeichert ✓");
    setTimeout(()=>setSyncStatus(""), 1500);
  }catch(e){
    setSyncStatus("Speichern fehlgeschlagen", true);
    console.error(e);
  }
}

function scoreColor(s){
  if(s===null||s===undefined||s==="") return {bg:"var(--gray-bg)",fg:"var(--gray-fg)",bd:"var(--gray-bd)"};
  const n=Number(s);
  if(n>=13) return {bg:"var(--green-bg)",fg:"var(--green-fg)",bd:"var(--green-bd)"};
  if(n>=10) return {bg:"var(--yellow-bg)",fg:"var(--yellow-fg)",bd:"var(--yellow-bd)"};
  if(n>=5)  return {bg:"var(--orange-bg)",fg:"var(--orange-fg)",bd:"var(--orange-bd)"};
  return {bg:"var(--red-bg)",fg:"var(--red-fg)",bd:"var(--red-bd)"};
}
function scoreLabel(s){
  const map={15:"1+",14:"1",13:"1–",12:"2+",11:"2",10:"2–",9:"3+",8:"3",7:"3–",6:"4+",5:"4",4:"4–",3:"5+",2:"5",1:"5–",0:"6"};
  return map[Number(s)]||"—";
}
function avg(arr){
  const v=arr.filter(x=>x!==null&&x!=="").map(Number).filter(x=>!isNaN(x));
  return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;
}
function semE(cat){ return data[cat].filter(e=>e.sem===activeSem&&SUBJECTS.includes(e.subj)); }
function subjAvg(cat,subj){ return avg(semE(cat).filter(e=>e.subj===subj).map(e=>e.score)); }
function overallAvg(subj){
  const v=["klausuren","muendlich","sonstige"].map(c=>subjAvg(c,subj)).filter(v=>v!==null);
  return v.length?avg(v):null;
}
function fmt(v,d=1){ return v===null?"—":v.toFixed(d); }

/* --- Datums-Helfer für Countdown & Erinnerungen (Format TT.MM.JJJJ) --- */
function parseGermanDate(str){
  if(!str) return null;
  const m=String(str).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if(!m) return null;
  let d=Number(m[1]),mo=Number(m[2]),y=Number(m[3]);
  if(y<100) y+=2000;
  const dt=new Date(y,mo-1,d);
  if(isNaN(dt.getTime())) return null;
  dt.setHours(0,0,0,0);
  return dt;
}
function todayMidnight(){ const n=new Date(); n.setHours(0,0,0,0); return n; }
function daysBetween(a,b){ return Math.round((a-b)/86400000); }
function isEmptyScore(v){ return v===null||v===undefined||v===""; }
function getKlausurReminders(){
  const now=todayMidnight();
  const items=data.klausuren
    .filter(e=>SUBJECTS.includes(e.subj))
    .map(e=>({entry:e,date:parseGermanDate(e.date)}))
    .filter(x=>x.date);
  const upcoming=items.filter(x=>x.date>=now).sort((a,b)=>a.date-b.date);
  const overdue=items.filter(x=>x.date<now&&isEmptyScore(x.entry.score)).sort((a,b)=>b.date-a.date);
  return {upcoming,overdue};
}

/* --- Semester-unabhängige Helfer für die Abi/Fachabi-Übersicht --- */
function entriesForSem(cat,sem){ return data[cat].filter(e=>e.sem===sem); }
function subjAvgSem(cat,subj,sem){ return avg(entriesForSem(cat,sem).filter(e=>e.subj===subj).map(e=>e.score)); }
function overallAvgSem(subj,sem){
  const v=["klausuren","muendlich","sonstige"].map(c=>subjAvgSem(c,subj,sem)).filter(v=>v!==null);
  return v.length?avg(v):null;
}
/* Effektiver Wert für den "Was-wäre-wenn"-Modus: echte Daten haben Vorrang, sonst der hypothetische Wert */
function overallAvgSemEff(subj,sem){
  const real=overallAvgSem(subj,sem);
  if(real!==null) return real;
  if(!scenarioMode) return null;
  const v=scenarioVals[subj+"|"+sem];
  return (v!==undefined&&v!==""&&!isNaN(Number(v)))?Math.min(15,Math.max(0,Number(v))):null;
}

function pill(v){
  if(v===null) return `<span style="color:var(--text-muted)">—</span>`;
  const c=scoreColor(Math.round(v));
  return `<span class="badge" style="background:${c.bg};color:${c.fg};border-color:${c.bd}">${v.toFixed(1)}</span>`;
}

/* Mini-Verlaufsdiagramm: kleine Linie über die (bis zu 4) Halbjahreswerte eines Fachs, feste Skala 0–15 */
function sparklineSVG(vals,w=72,h=26){
  const pts=vals.map((v,i)=>({i,v})).filter(p=>p.v!==null);
  if(pts.length<2){
    return `<svg class="sparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><text x="${w/2}" y="${h/2+4}" text-anchor="middle" font-size="10" fill="var(--text-faint)">–</text></svg>`;
  }
  const xStep=vals.length>1?w/(vals.length-1):0;
  const toY=v=>h-4-((v/15)*(h-8));
  const coords=pts.map(p=>`${(p.i*xStep).toFixed(1)},${toY(p.v).toFixed(1)}`).join(" ");
  const last=pts[pts.length-1];
  const color=scoreColor(Math.round(last.v)).bd;
  const dots=pts.map(p=>`<circle cx="${(p.i*xStep).toFixed(1)}" cy="${toY(p.v).toFixed(1)}" r="2.2" fill="${color}"/>`).join("");
  return `<svg class="sparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <polyline points="${coords}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
  </svg>`;
}

/* Entwicklungs-Badge für den Jahresvergleich */
function trendBadge(y1,y2){
  if(y1===null||y2===null) return `<span style="color:var(--text-muted)">—</span>`;
  const diff=y2-y1;
  const sign=diff>=0?"+":"";
  if(diff>0.3) return `<span style="color:var(--green-fg);font-weight:600">▲ ${sign}${diff.toFixed(1)}</span>`;
  if(diff<-0.3) return `<span style="color:var(--red-fg);font-weight:600">▼ ${diff.toFixed(1)}</span>`;
  return `<span style="color:var(--text-muted)">→ ${sign}${diff.toFixed(1)}</span>`;
}

function setSubjFilter(s){ subjFilter=s; render(); }

function switchTab(id){
  if(id==="abi"&&!(CONFIG&&CONFIG.abiturModuleEnabled)) id="overview";
  activeTab=id;
  editState=null;
  subjFilter="alle";
  bulkMode=false;
  pendingDelete=null;
  document.querySelectorAll(".nav-item").forEach(b=>b.classList.remove("active"));
  const navBtn=document.getElementById("nav-"+id);
  if(navBtn) navBtn.classList.add("active");
  document.getElementById("topbar-title").textContent=TAB_TITLES[id];
  render();
}
function switchSem(s){
  activeSem=String(s);
  editState=null;
  bulkMode=false;
  pendingDelete=null;
  document.querySelectorAll(".sem-btn").forEach(b=>b.classList.remove("active"));
  const btn=document.getElementById("sem-"+s);
  if(btn) btn.classList.add("active");
  document.getElementById("topbar-sem").textContent=SEM_LABELS[activeSem];
  render();
}
function renderSidebarNav(){
  const nav=document.getElementById("sidebar-nav-items");
  if(!nav) return;
  const items=[
    {id:"overview",icon:"◈",label:"Übersicht"},
    {id:"klausuren",icon:"✎",label:"Klausuren"},
    {id:"muendlich",icon:"◎",label:"Mündlich"},
    {id:"sonstige",icon:"◇",label:"Sonstige"},
    {id:"ziele",icon:"🎯",label:"Zielnoten"}
  ];
  if(CONFIG&&CONFIG.abiturModuleEnabled) items.push({id:"abi",icon:"🎓",label:"Abitur/Fachabi"});
  if(CONFIG&&CONFIG.mittelstufeModuleEnabled) items.push({id:"mittelstufe",icon:"🏫",label:"Mittelstufe"});
  if(CONFIG&&CONFIG.absenzenModuleEnabled) items.push({id:"absenzen",icon:"🗓",label:"Absenzen"});
  items.push({id:"statistik",icon:"📊",label:"Statistik"});
  items.push({id:"faecher",icon:"⚙",label:"Einstellungen"});
  nav.innerHTML=items.map(it=>`<button class="nav-item${it.id===activeTab?" active":""}" onclick="switchTab('${it.id}')" id="nav-${it.id}"><span class="icon">${it.icon}</span> ${it.label}</button>`).join("");
}
function renderSidebarPeriods(){
  const el=document.getElementById("sem-section-items");
  if(!el) return;
  el.innerHTML=SEMESTERS.map(s=>`<button class="sem-btn${s===activeSem?" active":""}" onclick="switchSem('${s}')" id="sem-${s}">${SEM_LABELS[s]}</button>`).join("");
}

function renderProfileSwitcher(){
  const el=document.getElementById("profile-switcher");
  if(!el) return;
  if(PROFILES.length<=1){
    el.innerHTML=`<button class="theme-toggle" onclick="switchTab('faecher')" title="Weiteres Profil anlegen (in den Einstellungen)">👤 ${PROFILES[0].name}</button>`;
  } else {
    el.innerHTML=`<select onchange="switchToProfile(this.value)" style="font-size:12px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)">
      ${PROFILES.map(p=>`<option value="${p.id}" ${p.id===activeProfileId?"selected":""}>👤 ${p.name}</option>`).join("")}
    </select>`;
  }
}
function render(){
  renderSidebarNav();
  renderSidebarPeriods();
  renderProfileSwitcher();
  const el=document.getElementById("content");
  let body;
  if(activeTab==="overview") body=renderOverview();
  else if(activeTab==="abi"&&CONFIG&&CONFIG.abiturModuleEnabled) body=renderAbi();
  else if(activeTab==="mittelstufe"&&CONFIG&&CONFIG.mittelstufeModuleEnabled) body=renderMittelstufe();
  else if(activeTab==="ziele") body=renderZiele();
  else if(activeTab==="absenzen"&&CONFIG&&CONFIG.absenzenModuleEnabled) body=renderAbsenzen();
  else if(activeTab==="statistik") body=renderStatistik();
  else if(activeTab==="faecher") body=renderFaecher();
  else body=renderCategory(activeTab);

  const toast=toastMessage?`<div style="background:var(--yellow-bg);color:var(--yellow-fg);border:1px solid var(--yellow-bd);border-radius:8px;padding:10px 16px;margin-bottom:16px;font-size:13px;font-weight:600">${toastMessage}</div>`:"";
  el.innerHTML=toast+body;
}
function showToast(msg){
  toastMessage=msg;
  render();
  setTimeout(()=>{ if(toastMessage===msg){ toastMessage=null; render(); } },3500);
}

function renderOverview(){
  const allE=[...semE("klausuren"),...semE("muendlich"),...semE("sonstige")];
  const allS=allE.map(e=>Number(e.score)).filter(v=>!isNaN(v));
  const gAvg=allS.length?avg(allS):null;
  const gC=scoreColor(gAvg!==null?Math.round(gAvg):null);

  let h=`<div class="metrics">
    <div class="metric"><div class="metric-label">Einträge gesamt</div><div class="metric-value">${allE.length}</div></div>
    <div class="metric"><div class="metric-label">Gesamtdurchschnitt</div><div class="metric-value" style="color:${gAvg!==null?gC.fg:"var(--text)"}">${fmt(gAvg)}</div></div>
    <div class="metric"><div class="metric-label">Klausuren</div><div class="metric-value">${semE("klausuren").length}</div></div>
    <div class="metric"><div class="metric-label">Bester Wert</div><div class="metric-value">${allS.length?Math.max(...allS):"—"}</div></div>
  </div>`;

  const {upcoming,overdue}=getKlausurReminders();
  const now=todayMidnight();

  if(overdue.length){
    h+=`<div class="section-head" style="color:var(--red-fg)">⚠ Note fehlt noch (Klausurtermin bereits vorbei)</div><div class="card-grid" style="margin-bottom:24px">`;
    overdue.forEach(x=>{
      const e=x.entry;
      h+=`<div class="card" style="border-color:var(--red-bd);background:var(--red-bg)">
        <div class="card-top"><div class="card-name" style="color:var(--red-fg)">${e.subj}</div></div>
        <div class="slot-label" style="color:var(--red-fg)">${e.type} · war am ${e.date} (${SEM_LABELS[e.sem]})</div>
      </div>`;
    });
    h+=`</div>`;
  }

  if(upcoming.length){
    h+=`<div class="section-head">Nächste Klausuren</div><div class="card-grid" style="margin-bottom:24px">`;
    upcoming.slice(0,6).forEach(x=>{
      const e=x.entry;
      const days=daysBetween(x.date,now);
      const label=days===0?"Heute":days===1?"Morgen":`in ${days} Tagen`;
      const urgent=days<=3;
      h+=`<div class="card" ${urgent?'style="border-color:var(--yellow-bd);background:var(--yellow-bg)"':""}>
        <div class="card-top">
          <div class="card-name">${e.subj}</div>
          <div class="card-avg" style="font-size:13px;color:${urgent?"var(--yellow-fg)":"var(--text-muted)"}">${label}</div>
        </div>
        <div class="slot-label">${e.type} · ${e.date} (${SEM_LABELS[e.sem]})</div>
      </div>`;
    });
    h+=`</div>`;
  }

  h+=`<div class="section-head">Klausur-Fortschritt</div><div class="card-grid">`;
  Object.entries(KLAUSUR_SLOTS).forEach(([subj,slots])=>{
    const done=semE("klausuren").filter(e=>e.subj===subj).length;
    const a=subjAvg("klausuren",subj);
    const c=scoreColor(a!==null?Math.round(a):null);
    const tag=done>=slots?`<span class="tag tag-ok">✓ fertig</span>`:`<span class="tag tag-warn">${done}/${slots}</span>`;
    const slotsH=Array.from({length:slots},(_,i)=>`<div class="slot ${i<done?"filled":""}"></div>`).join("");
    h+=`<div class="card">
      <div class="card-top">
        <div><div class="card-name">${subj}${tag}</div></div>
        <div class="card-avg" style="color:${a!==null?c.fg:"var(--text-muted)"}">${fmt(a)}</div>
      </div>
      <div class="slots">${slotsH}</div>
      <div class="slot-label">${done} von ${slots} Klausuren</div>
    </div>`;
  });
  h+=`</div>`;

  h+=`<div class="section-head">Alle Fächer — Durchschnitt</div>`;
  SUBJECTS.forEach(s=>{
    const a=overallAvg(s);
    const c=scoreColor(a!==null?Math.round(a):null);
    const pct=a!==null?(a/15*100).toFixed(1):0;
    h+=`<div class="bar-row">
      <div class="bar-label">${s}</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${pct}%;background:${c.bd}"></div>
        <span class="bar-val" style="color:${a!==null?c.fg:"var(--text-muted)"}">
          ${a!==null?a.toFixed(1)+" · "+scoreLabel(Math.round(a)):"keine Daten"}
        </span>
      </div>
    </div>`;
  });

  h+=`<div class="section-head" style="margin-top:24px">Aufschlüsselung</div>
  <div class="ov-table"><table>
    <thead><tr><th>Fach</th><th>Klausuren Ø</th><th>Mündlich Ø</th><th>Sonstige Ø</th><th>Gesamt Ø</th></tr></thead>
    <tbody>`;
  SUBJECTS.forEach(s=>{
    h+=`<tr><td class="subj">${s}</td><td>${pill(subjAvg("klausuren",s))}</td><td>${pill(subjAvg("muendlich",s))}</td><td>${pill(subjAvg("sonstige",s))}</td><td>${pill(overallAvg(s))}</td></tr>`;
  });
  h+=`</tbody></table></div>`;
  return h;
}

function renderCategory(cat){
  const allSemEntries=semE(cat);
  const entries=subjFilter==="alle"?allSemEntries:allSemEntries.filter(e=>e.subj===subjFilter);
  const scores=entries.map(e=>Number(e.score)).filter(v=>!isNaN(v));
  const catAvg=scores.length?avg(scores):null;
  const avgC=scoreColor(catAvg!==null?Math.round(catAvg):null);
  const isK=cat==="klausuren";
  const mittel=isMittelstufe();
  const schulnoten=scores.map(punkteZuSchulnote);
  const schulnotenAvg=schulnoten.length?avg(schulnoten):null;

  let h=`<div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:16px;gap:12px;flex-wrap:wrap">
    <div class="fg" style="max-width:220px">
      <label>Fächer-Filter</label>
      <select id="f-subjfilter" onchange="setSubjFilter(this.value)">
        <option value="alle" ${subjFilter==="alle"?"selected":""}>Alle Fächer</option>
        ${SUBJECTS.map(s=>`<option value="${s}" ${subjFilter===s?"selected":""}>${s}</option>`).join("")}
      </select>
    </div>
    <button class="btn ${bulkMode?"btn-primary":""}" style="padding:7px 16px;font-size:12px;font-weight:600" onclick="toggleBulkMode('${cat}')">${bulkMode?"✓ Mehrfach-Modus aktiv":"📋 Mehrere auf einmal eintragen"}</button>
  </div>`;

  h+=mittel?`<div class="metrics">
    <div class="metric"><div class="metric-label">Einträge</div><div class="metric-value">${entries.length}</div></div>
    <div class="metric"><div class="metric-label">Durchschnitt</div><div class="metric-value" style="color:${catAvg!==null?avgC.fg:"var(--text)"}">${fmt(schulnotenAvg)}</div></div>
    <div class="metric"><div class="metric-label">Beste Note</div><div class="metric-value">${schulnoten.length?Math.min(...schulnoten):"—"}</div></div>
    <div class="metric"><div class="metric-label">Schlechteste Note</div><div class="metric-value">${schulnoten.length?Math.max(...schulnoten):"—"}</div></div>
  </div>`:`<div class="metrics">
    <div class="metric"><div class="metric-label">Einträge</div><div class="metric-value">${entries.length}</div></div>
    <div class="metric"><div class="metric-label">Durchschnitt</div><div class="metric-value" style="color:${catAvg!==null?avgC.fg:"var(--text)"}">${fmt(catAvg)}</div></div>
    <div class="metric"><div class="metric-label">Bester Wert</div><div class="metric-value">${scores.length?Math.max(...scores):"—"}</div></div>
    <div class="metric"><div class="metric-label">Schlechtester</div><div class="metric-value">${scores.length?Math.min(...scores):"—"}</div></div>
  </div>`;

  if(isK){
    h+=`<div class="section-head">Klausur-Slots</div><div class="card-grid" style="margin-bottom:24px">`;
    Object.entries(KLAUSUR_SLOTS).filter(([subj])=>subjFilter==="alle"||subjFilter===subj).forEach(([subj,slots])=>{
      const done=allSemEntries.filter(e=>e.subj===subj).length;
      const a=subjAvg("klausuren",subj);
      const c=scoreColor(a!==null?Math.round(a):null);
      const slotsH=Array.from({length:slots},(_,i)=>`<div class="slot ${i<done?"filled":""}"></div>`).join("");
      h+=`<div class="card">
        <div class="card-top">
          <div class="card-name">${subj}</div>
          <div class="card-avg" style="color:${a!==null?c.fg:"var(--text-muted)"}">${mittel?fmt(a!==null?punkteZuSchulnote(Math.round(a)):null,0):fmt(a)}</div>
        </div>
        <div class="slots">${slotsH}</div>
        <div class="slot-label">${done}/${slots} eingetragen</div>
      </div>`;
    });
    h+=`</div>`;
  }

  const editingEntry=(editState&&editState.cat===cat)?data[cat][editState.idx]:null;

  if(bulkMode&&!editingEntry){
    const bulkSubjects=subjFilter==="alle"?SUBJECTS:[subjFilter];
    h+=`<div class="form-section">
      <div class="form-title">Mehrere Einträge auf einmal erfassen</div>
      <div class="form-grid">
        <div class="fg"><label>Art (für alle)</label><select id="bulk-type">${TYPES[cat].map(t=>`<option>${t}</option>`).join("")}</select></div>
        <div class="fg"><label>Datum (für alle, optional)</label><input type="text" id="bulk-date" placeholder="z.B. 15.01.2026"></div>
      </div>
      <table class="bulk-table" style="width:100%;border-collapse:collapse;margin-top:12px">
        <thead><tr>
          <th style="text-align:left;padding:6px 4px;font-size:11px;color:var(--text-muted);text-transform:uppercase">Fach</th>
          <th style="text-align:left;padding:6px 4px;font-size:11px;color:var(--text-muted);text-transform:uppercase">${mittel?"Schulnote (1–6)":"Punkte (0–15)"}</th>
          <th style="text-align:left;padding:6px 4px;font-size:11px;color:var(--text-muted);text-transform:uppercase">Bemerkung</th>
        </tr></thead>
        <tbody>
          ${bulkSubjects.map((s,i)=>`<tr>
            <td style="padding:6px 4px;font-weight:600;font-size:13px">${s}</td>
            <td style="padding:6px 4px"><input type="number" min="${mittel?1:0}" max="${mittel?6:15}" placeholder="—" id="bulk-score-${i}"></td>
            <td style="padding:6px 4px"><input type="text" placeholder="Optional..." id="bulk-note-${i}" style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;font-family:inherit"></td>
          </tr>`).join("")}
        </tbody>
      </table>
      <div class="form-footer" style="margin-top:14px">
        <button class="btn btn-primary" onclick="addBulkEntries('${cat}')">+ Alle ausgefüllten Fächer eintragen</button>
        <button class="btn" onclick="toggleBulkMode('${cat}')">Abbrechen</button>
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin-top:10px">${mittel?"Leere Noten-Felder werden übersprungen — du musst nicht für jedes Fach etwas eintragen.":"Leere Punkte-Felder werden übersprungen — du musst nicht für jedes Fach etwas eintragen."}</p>
    </div>`;
  } else {
    h+=`<div class="form-section">
      <div class="form-title">${editingEntry?"Eintrag bearbeiten":"Neuer Eintrag"}</div>
      <div class="form-grid">
        <div class="fg"><label>Fach</label><select id="f-subj">${SUBJECTS.map(s=>`<option ${editingEntry&&editingEntry.subj===s?"selected":""}>${s}</option>`).join("")}</select></div>
        <div class="fg"><label>Art</label><select id="f-type">${TYPES[cat].map(t=>`<option ${editingEntry&&editingEntry.type===t?"selected":""}>${t}</option>`).join("")}</select></div>
        <div class="fg"><label>Datum</label><input type="text" id="f-date" placeholder="z.B. 15.01.2026" value="${editingEntry?(editingEntry.date||""):""}"></div>
        <div class="fg"><label>${mittel?"Schulnote (1–6)":"Punkte (0–15)"}</label><input type="number" id="f-score" min="${mittel?1:0}" max="${mittel?6:15}" placeholder="${mittel?"1–6":"0–15"}" value="${editingEntry&&editingEntry.score!==null&&editingEntry.score!==""?(mittel?punkteZuSchulnote(editingEntry.score):editingEntry.score):""}"></div>
        <div class="fg"><label>Bemerkung</label><input type="text" id="f-note" placeholder="Optional..." value="${editingEntry?(editingEntry.note||""):""}"></div>
      </div>
      <div class="form-footer">
        <button class="btn btn-primary" onclick="${editingEntry?`saveEditEntry('${cat}')`:`addEntry('${cat}')`}">${editingEntry?"Speichern":"+ Eintragen"}</button>
        ${editingEntry?`<button class="btn" onclick="cancelEdit()">Abbrechen</button>`:""}
      </div>
    </div>`;
  }

  h+=`<div class="table-card"><table><thead><tr>
    <th>Fach</th><th>Art</th><th>Datum</th><th>${mittel?"Note":"Punkte"}</th><th>${mittel?"Bewertung":"Note"}</th><th>Bemerkung</th><th></th>
  </tr></thead><tbody>`;
  if(!entries.length){
    h+=`<tr><td colspan="7"><div class="empty-state"><p>Noch keine Einträge für dieses Semester.</p></div></td></tr>`;
  } else {
    [...entries].reverse().forEach(e=>{
      const idx=data[cat].indexOf(e);
      const c=scoreColor(e.score);
      const dt=parseGermanDate(e.date);
      const overdueRow=isK&&dt&&dt<todayMidnight()&&isEmptyScore(e.score);
      const hasScore=e.score!==null&&e.score!=="";
      const schulnote=hasScore?punkteZuSchulnote(e.score):null;
      h+=`<tr ${overdueRow?'style="background:var(--red-bg)"':""}>
        <td class="subj">${e.subj}</td>
        <td class="muted">${e.type}</td>
        <td class="muted">${e.date||"—"}${overdueRow?' <span title="Klausur war bereits, Note fehlt" style="color:var(--red-fg);font-weight:700">⚠</span>':""}</td>
        <td><span class="badge" style="background:${c.bg};color:${c.fg};border-color:${c.bd}">${hasScore?(mittel?schulnote:e.score):"—"}</span></td>
        <td class="note-name" style="color:${c.fg}">${hasScore?(mittel?schulnoteLabel(schulnote):scoreLabel(e.score)):"—"}</td>
        <td class="muted" style="font-size:12px">${e.note||""}</td>
        <td>
          ${pendingDelete&&pendingDelete.kind==="entry"&&pendingDelete.cat===cat&&pendingDelete.idx===idx
            ?`<span style="font-size:11px;color:var(--red-fg);margin-right:4px">Löschen?</span><button class="btn btn-primary" style="padding:3px 9px;font-size:11px" onclick="confirmDeleteEntry('${cat}',${idx})">Ja</button> <button class="btn" style="padding:3px 9px;font-size:11px" onclick="cancelPendingDelete()">Nein</button>`
            :`<button class="btn-edit" onclick="editEntry('${cat}',${idx})" title="Bearbeiten">✎</button>
          <button class="btn-delete" onclick="requestDeleteEntry('${cat}',${idx})" title="Löschen">✕</button>`}
        </td>
      </tr>`;
    });
  }
  h+=`</tbody></table></div>`;
  return h;
}

/* --- Abitur/Fachabi Hochrechnung: Einstellungen & Berechnung --- */
function loadAbiSettingsDefault(){
  return {ziel:"beide",lk:[],block2:[{fach:"",punkte:""},{fach:"",punkte:""},{fach:"",punkte:""},{fach:"",punkte:""},{fach:"",punkte:""}]};
}
let abiSettings = loadAbiSettingsDefault();
async function loadAbiSettings(){
  try{
    const res=await window.storage.get(pKey("abi_settings"));
    if(res&&res.value) abiSettings=JSON.parse(res.value);
  }catch(e){ /* noch keine Einstellungen gespeichert */ }
}
async function saveAbiSettings(){
  setSyncStatus("Speichert…");
  try{
    await window.storage.set(pKey("abi_settings"), JSON.stringify(abiSettings));
    setSyncStatus("Gespeichert ✓");
    setTimeout(()=>setSyncStatus(""), 1500);
  }catch(e){
    setSyncStatus("Speichern fehlgeschlagen", true);
    console.error(e);
  }
}

async function setAbiZiel(z){ abiSettings.ziel=z; await saveAbiSettings(); render(); }
async function toggleLK(subj){
  const maxLK=(CONFIG&&CONFIG.abiturModule&&CONFIG.abiturModule.numLK)||2;
  const i=abiSettings.lk.indexOf(subj);
  if(i>=0){ abiSettings.lk.splice(i,1); }
  else{
    if(abiSettings.lk.length>=maxLK){ showToast("Du kannst maximal "+maxLK+" Leistungskurse auswählen."); return; }
    abiSettings.lk.push(subj);
  }
  await saveAbiSettings(); render();
}
async function setBlock2(i,field,val){ abiSettings.block2[i][field]=val; await saveAbiSettings(); render(); }

function csvCell(v){ return `"${String(v).replace(/"/g,'""')}"`; }
function downloadCSV(filename, rows){
  const csv=rows.map(r=>r.map(csvCell).join(";")).join("\r\n");
  const blob=new Blob(["﻿"+csv],{type:"text/csv;charset=utf-8;"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url; a.download=filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function exportAbiCSV(){
  const avgFn=scenarioMode?overallAvgSemEff:overallAvgSem;
  const rows=[["Fach",...SEMESTERS.map(sem=>SEM_LABELS[sem]),"Ø gesamt"]];
  SUBJECTS.forEach(subj=>{
    const rowVals=SEMESTERS.map(sem=>avgFn(subj,sem));
    const filled=rowVals.filter(v=>v!==null);
    const rowAvg=filled.length?avg(filled):null;
    rows.push([subj,...rowVals.map(v=>v!==null?v.toFixed(1):""),rowAvg!==null?rowAvg.toFixed(1):""]);
  });
  downloadCSV("Abi_Fachabi_Uebersicht.csv", rows);
}

function toggleScenarioMode(){ scenarioMode=!scenarioMode; render(); }
function resetScenario(){ scenarioVals={}; render(); }
function setScenarioVal(subj,sem,val){
  const key=subj+"|"+sem;
  if(val==="") delete scenarioVals[key]; else scenarioVals[key]=val;
  render();
}

function computeBlockI(avgFn){
  avgFn=avgFn||overallAvgSem;
  const lk=abiSettings.lk;
  const gkVals=[]; const lkVals=[]; // lkVals: nur Q3/Q4-Werte der LK-Fächer (ab hier zählt der LK-Status)
  SUBJECTS.forEach(s=>{
    SEMESTERS.forEach(sem=>{
      const v=avgFn(s,sem);
      if(v===null) return;
      const isLkSem=lk.includes(s)&&isDoubleWeightPeriod(sem);
      if(isLkSem) lkVals.push(v); else gkVals.push(v);
    });
  });
  const gkAvg=gkVals.length?avg(gkVals):null;
  const lkAvg=lkVals.length?avg(lkVals):null;
  const weightedCount=gkVals.length+lkVals.length*2;
  let blockI=null;
  if(weightedCount>0){
    const weightedSum=(gkAvg!==null?gkAvg*gkVals.length:0)+(lkAvg!==null?lkAvg*lkVals.length*2:0);
    blockI=Math.min(600,Math.round((weightedSum/weightedCount)*40));
  }
  return {blockI,gkAvg,lkAvg,count:gkVals.length+lkVals.length};
}
function computeBlockII(){
  const numFaecher=(CONFIG&&CONFIG.abiturModule&&CONFIG.abiturModule.numPruefungsfaecher)||abiSettings.block2.length||5;
  const weightFactor=20/numFaecher; // insgesamt immer 20 Wertungseinheiten -> max. 300 Punkte, unabhängig von der Fächerzahl
  const filled=abiSettings.block2.filter(p=>p.punkte!==""&&p.punkte!==null&&p.punkte!==undefined&&!isNaN(Number(p.punkte)));
  if(!filled.length) return {blockII:null,count:0};
  const sum=filled.reduce((a,p)=>a+Math.min(15,Math.max(0,Number(p.punkte)))*weightFactor,0);
  return {blockII:Math.round(sum),count:filled.length};
}

/* ======================= Statistik-Toolkit ======================= */
function mean(arr){ return arr.length?arr.reduce((a,b)=>a+b,0)/arr.length:null; }
function variance(arr){ if(arr.length<2) return null; const m=mean(arr); return arr.reduce((s,x)=>s+(x-m)*(x-m),0)/(arr.length-1); }
function stdev(arr){ const v=variance(arr); return v!==null?Math.sqrt(v):null; }
function clipScore(v){ return Math.min(15,Math.max(0,v)); }

function allEntriesForSubject(subj){
  return ["klausuren","muendlich","sonstige"].flatMap(c=>data[c].filter(e=>e.subj===subj&&!isEmptyScore(e.score)).map(e=>({...e,cat:c})));
}
function allEnteredScores(){
  return ["klausuren","muendlich","sonstige"].flatMap(c=>data[c].filter(e=>!isEmptyScore(e.score)).map(e=>Number(e.score)));
}

/* --- 1) Standardabweichung & Z-Score-Ausreißer --- */
function getSubjectStats(subj){
  const scores=allEntriesForSubject(subj).map(e=>Number(e.score));
  return {mean:mean(scores),sd:stdev(scores),n:scores.length};
}
function zScoreOutliers(threshold=1.3){
  const out=[];
  SUBJECTS.forEach(subj=>{
    const entries=allEntriesForSubject(subj);
    const scores=entries.map(e=>Number(e.score));
    if(scores.length<3) return;
    const m=mean(scores),sd=stdev(scores);
    if(!sd) return;
    entries.forEach(e=>{
      const z=(Number(e.score)-m)/sd;
      if(Math.abs(z)>=threshold) out.push({...e,subj,z,fachMean:m});
    });
  });
  return out.sort((a,b)=>Math.abs(b.z)-Math.abs(a.z));
}

/* --- 2) Korrelationsanalyse zwischen Fächern (Pearson, auf Halbjahresbasis) --- */
function pearson(xs,ys){
  const n=xs.length;
  if(n<3) return null;
  const mx=mean(xs),my=mean(ys);
  let num=0,dx2=0,dy2=0;
  for(let i=0;i<n;i++){ const dx=xs[i]-mx,dy=ys[i]-my; num+=dx*dy; dx2+=dx*dx; dy2+=dy*dy; }
  if(dx2===0||dy2===0) return null;
  return num/Math.sqrt(dx2*dy2);
}
function subjectCorrelations(){
  const pairs=[];
  for(let i=0;i<SUBJECTS.length;i++){
    for(let j=i+1;j<SUBJECTS.length;j++){
      const a=SUBJECTS[i],b=SUBJECTS[j];
      const xs=[],ys=[];
      SEMESTERS.forEach(sem=>{
        const va=overallAvgSem(a,sem),vb=overallAvgSem(b,sem);
        if(va!==null&&vb!==null){ xs.push(va); ys.push(vb); }
      });
      const r=pearson(xs,ys);
      if(r!==null) pairs.push({a,b,r,n:xs.length});
    }
  }
  return pairs.sort((x,y)=>Math.abs(y.r)-Math.abs(x.r));
}

/* --- 3) Trendprognose per linearer Regression mit Unsicherheitsband --- */
function linReg(points){
  const n=points.length;
  if(n<2) return null;
  const sx=points.reduce((s,p)=>s+p.x,0),sy=points.reduce((s,p)=>s+p.y,0);
  const sxx=points.reduce((s,p)=>s+p.x*p.x,0),sxy=points.reduce((s,p)=>s+p.x*p.y,0);
  const denom=n*sxx-sx*sx;
  if(denom===0) return null;
  const slope=(n*sxy-sx*sy)/denom, intercept=(sy-slope*sx)/n;
  const resid=points.map(p=>p.y-(slope*p.x+intercept));
  const sse=resid.reduce((s,r)=>s+r*r,0);
  const residStdErr=n>2?Math.sqrt(sse/(n-2)):null;
  return {slope,intercept,residStdErr,n};
}
function predictSemester(subj,targetSem){
  const points=[];
  SEMESTERS.forEach((sem,idx)=>{ const v=overallAvgSem(subj,sem); if(v!==null) points.push({x:idx,y:v}); });
  const reg=linReg(points);
  if(!reg) return null;
  const targetIdx=SEMESTERS.indexOf(targetSem);
  const pred=clipScore(reg.slope*(targetIdx>=0?targetIdx:SEMESTERS.length)+reg.intercept);
  const band=reg.residStdErr!==null?reg.residStdErr:(stdev(points.map(p=>p.y))||1.5);
  return {pred,low:clipScore(pred-band),high:clipScore(pred+band),n:reg.n};
}

/* --- 4) Grenznutzen-Analyse: welches Fach hebt die Gesamtpunktzahl am meisten? --- */
function marginalUtility(){
  const baseline=computeBlockI(overallAvgSem).blockI||0;
  const rows=SUBJECTS.map(subj=>{
    const hasData=SEMESTERS.some(sem=>overallAvgSem(subj,sem)!==null);
    if(!hasData) return {subj,delta:null};
    const avgFnPlus1=(s,sem)=>{
      const v=overallAvgSem(s,sem);
      if(v===null) return null;
      return s===subj?clipScore(v+1):v;
    };
    const newBI=computeBlockI(avgFnPlus1).blockI||0;
    return {subj,delta:newBI-baseline,isLK:abiSettings.lk.includes(subj)};
  }).filter(r=>r.delta!==null).sort((a,b)=>b.delta-a.delta);
  return {baseline,rows};
}

/* --- 5) Monte-Carlo-Simulation der Gesamtpunktzahl --- */
function sampleNormal(m,sd){
  let u=0,v=0;
  while(u===0) u=Math.random();
  while(v===0) v=Math.random();
  const z=Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
  return m+z*sd;
}
function runMonteCarlo(trials=2000){
  const allScores=allEnteredScores();
  const globalMean=allScores.length?mean(allScores):10;
  const globalSd=allScores.length>=2?(stdev(allScores)||2.5):2.5;
  const lk=abiSettings.lk;
  const results=[];
  for(let t=0;t<trials;t++){
    const gkVals=[],lkVals=[];
    SUBJECTS.forEach(s=>{
      const st=getSubjectStats(s);
      SEMESTERS.forEach(sem=>{
        let v=overallAvgSem(s,sem);
        if(v===null){
          const m=st.mean!==null?st.mean:globalMean;
          const sd=st.sd!==null&&st.sd>0?st.sd:globalSd;
          v=clipScore(sampleNormal(m,sd));
        }
        const isLkSem=lk.includes(s)&&isDoubleWeightPeriod(sem);
        if(isLkSem) lkVals.push(v); else gkVals.push(v);
      });
    });
    const gkAvg=gkVals.length?avg(gkVals):0;
    const lkAvg=lkVals.length?avg(lkVals):0;
    const weightedCount=gkVals.length+lkVals.length*2;
    const blockI=weightedCount>0?Math.min(600,((gkAvg*gkVals.length+lkAvg*lkVals.length*2)/weightedCount)*40):0;

    let blockIIsum=0;
    abiSettings.block2.forEach(p=>{
      let pts;
      if(p.punkte!==""&&p.punkte!==null&&p.punkte!==undefined&&!isNaN(Number(p.punkte))) pts=Number(p.punkte);
      else pts=clipScore(sampleNormal(globalMean,globalSd));
      blockIIsum+=clipScore(pts)*4;
    });
    results.push(Math.round(blockI+blockIIsum));
  }
  results.sort((a,b)=>a-b);
  const pct=p=>results[Math.min(results.length-1,Math.floor(p*results.length))];
  return {
    p10:pct(0.10),p25:pct(0.25),p50:pct(0.50),p75:pct(0.75),p90:pct(0.90),
    meanVal:avg(results),min:results[0],max:results[results.length-1],trials
  };
}

/* --- 5b) Bootstrap-Konfidenzintervall (verteilungsfrei, zieht aus echten Noten statt aus einer Normalverteilung) --- */
function bootstrapSample(pool){ return pool[Math.floor(Math.random()*pool.length)]; }
function runBootstrap(trials=2000){
  const globalPool=allEnteredScores();
  const pool0=globalPool.length?globalPool:[10];
  const lk=abiSettings.lk;
  const subjPools={};
  SUBJECTS.forEach(s=>{
    const scores=allEntriesForSubject(s).map(e=>Number(e.score));
    subjPools[s]=scores.length>=2?scores:pool0;
  });
  const results=[];
  for(let t=0;t<trials;t++){
    const gkVals=[],lkVals=[];
    SUBJECTS.forEach(s=>{
      SEMESTERS.forEach(sem=>{
        let v=overallAvgSem(s,sem);
        if(v===null) v=clipScore(bootstrapSample(subjPools[s]));
        const isLkSem=lk.includes(s)&&isDoubleWeightPeriod(sem);
        if(isLkSem) lkVals.push(v); else gkVals.push(v);
      });
    });
    const gkAvg=gkVals.length?avg(gkVals):0;
    const lkAvg=lkVals.length?avg(lkVals):0;
    const weightedCount=gkVals.length+lkVals.length*2;
    const blockI=weightedCount>0?Math.min(600,((gkAvg*gkVals.length+lkAvg*lkVals.length*2)/weightedCount)*40):0;

    let blockIIsum=0;
    abiSettings.block2.forEach(p=>{
      let pts;
      if(p.punkte!==""&&p.punkte!==null&&p.punkte!==undefined&&!isNaN(Number(p.punkte))) pts=Number(p.punkte);
      else pts=clipScore(bootstrapSample(pool0));
      blockIIsum+=clipScore(pts)*4;
    });
    results.push(Math.round(blockI+blockIIsum));
  }
  results.sort((a,b)=>a-b);
  const pct=p=>results[Math.min(results.length-1,Math.floor(p*results.length))];
  return {
    p10:pct(0.10),p25:pct(0.25),p50:pct(0.50),p75:pct(0.75),p90:pct(0.90),
    meanVal:avg(results),min:results[0],max:results[results.length-1],trials
  };
}

/* --- 7) Klausur-vs-Mündlich-Vergleich: systematischer Unterschied je Fach --- */
function klausurVsMuendlichVergleichFiltered(semesters){
  const rows=[];
  SUBJECTS.forEach(subj=>{
    const kScores=data.klausuren.filter(e=>e.subj===subj&&semesters.includes(e.sem)&&!isEmptyScore(e.score)).map(e=>Number(e.score));
    const mScores=data.muendlich.filter(e=>e.subj===subj&&semesters.includes(e.sem)&&!isEmptyScore(e.score)).map(e=>Number(e.score));
    if(!kScores.length||!mScores.length) return;
    const kAvg=avg(kScores),mAvg=avg(mScores);
    rows.push({subj,kAvg,mAvg,diff:kAvg-mAvg,nK:kScores.length,nM:mScores.length});
  });
  return rows.sort((a,b)=>Math.abs(b.diff)-Math.abs(a.diff));
}
function klausurVsMuendlichVergleich(){ return klausurVsMuendlichVergleichFiltered(SEMESTERS); }

/* --- 6) Einbringungs-Optimierer (vereinfachtes Modell) --- */
function blockIFromSets(keptGk,lkArr){
  const gkAvg=keptGk.length?avg(keptGk.map(x=>x.val)):null;
  const lkAvg=lkArr.length?avg(lkArr):null;
  const weightedCount=keptGk.length+lkArr.length*2;
  if(weightedCount===0) return null;
  const sum=(gkAvg!==null?gkAvg*keptGk.length:0)+(lkAvg!==null?lkAvg*lkArr.length*2:0);
  return Math.min(600,Math.round((sum/weightedCount)*40));
}
function optimizeEinbringung(maxExclude){
  const lk=abiSettings.lk;
  const gkVals=[],lkVals=[];
  SUBJECTS.forEach(s=>{
    SEMESTERS.forEach(sem=>{
      const v=overallAvgSem(s,sem);
      if(v===null) return;
      const isLkSem=lk.includes(s)&&isDoubleWeightPeriod(sem);
      if(isLkSem) lkVals.push(v); else gkVals.push({subj:s,sem,val:v});
    });
  });
  const sorted=[...gkVals].sort((a,b)=>a.val-b.val);
  const excludable=Math.min(maxExclude,Math.max(0,sorted.length-1));
  const excluded=sorted.slice(0,excludable);
  const kept=sorted.slice(excludable);
  const withoutExclusion=blockIFromSets(gkVals,lkVals);
  const withExclusion=blockIFromSets(kept,lkVals);
  return {
    withoutExclusion,withExclusion,excluded,
    gain:(withExclusion!==null&&withoutExclusion!==null)?withExclusion-withoutExclusion:null,
    totalGk:gkVals.length
  };
}
function punkteToNote(p){
  if(p===null||p===undefined) return null;
  let n=(17-p/60)/3;
  if(n<1) n=1;
  return Math.floor(n*10)/10;
}
/* Standard-Umrechnungstabelle Notenpunkte (0-15) -> Schulnote (1-6), bundesweit einheitlich für die
 * gymnasiale Oberstufe; wird hier für das Mittelstufen-Modul genutzt, um aus den ohnehin in dieser App
 * eingetragenen 0-15-Punkte-Werten eine Schulnote abzuleiten (13-15=1, 10-12=2, 7-9=3, 4-6=4, 1-3=5, 0=6). */
function punkteZuSchulnote(p){
  if(p===null||p===undefined) return null;
  if(p>=13) return 1;
  if(p>=10) return 2;
  if(p>=7) return 3;
  if(p>=4) return 4;
  if(p>=1) return 5;
  return 6;
}
function schulnoteLabel(n){
  return {1:"sehr gut",2:"gut",3:"befriedigend",4:"ausreichend",5:"mangelhaft",6:"ungenügend"}[n]||"—";
}
/* Umgekehrte Richtung für den Mittelstufen-Modus: Nutzer tragen dort Schulnoten (1-6) statt
 * Notenpunkten ein, intern wird weiterhin mit den 0-15-Punkte-Werten gerechnet (dieselbe
 * Datenstruktur wie im Rest der App), damit Statistik/Export/Farben unverändert funktionieren.
 * Jede Schulnote wird auf einen repräsentativen Punktwert aus der Mitte ihres Bereichs abgebildet. */
function schulnoteZuPunkte(n){
  return {1:14,2:11,3:8,4:5,5:2,6:0}[n] ?? null;
}
function isMittelstufe(){ return !!(CONFIG&&CONFIG.mittelstufeModuleEnabled); }
/* Kontinuierliche Punkte(0-15)->Note(1-6)-Umrechnung nach der in der gymnasialen Oberstufe üblichen
 * Formel Note=(17-Punkte)/3 (dieselbe Formel, die punkteToNote() oben für die Abitur-Gesamtpunktzahl
 * verwendet, hier verallgemeinert auf eine einzelne 0-15-Skala). Wird für Zielnoten-Rechner und die
 * GPA-Näherung genutzt, wo eine feinere Abstufung als die ganzzahlige Schulnote hilfreich ist. */
function punkteZuKontinuierlicherNote(punkte){
  if(punkte===null||punkte===undefined||isNaN(punkte)) return null;
  let n=(17-punkte)/3;
  if(n<1) n=1;
  if(n>6) n=6;
  return Math.round(n*10)/10;
}
/* "Modified Bavarian Formula" — gängige Näherung (u.a. von WES für deutsche Abschlüsse verwendet), um
 * eine deutsche Note (1,0 beste .. 4,0 Bestehensgrenze) auf eine US-GPA-Skala (4,0 .. 0,0) abzubilden.
 * Noten schlechter als 4,0 (nicht bestanden) ergeben GPA 0. Nur eine Näherung, keine offizielle Norm. */
function noteToGPA(note){
  if(note===null||note===undefined||isNaN(note)) return null;
  if(note>4) return 0;
  return Math.round((5-note)*100)/100;
}
/* Liest ein Noten-Eingabefeld abhängig vom aktiven Modus: im Mittelstufen-Modus wird der
 * eingegebene Wert (1-6) als Schulnote interpretiert und in den internen Punktwert umgerechnet,
 * sonst wird der Wert direkt als Punkte (0-15) übernommen. */
function parseScoreInput(raw){
  if(raw===""||raw===null||raw===undefined) return null;
  const n=Number(raw);
  if(isNaN(n)) return null;
  if(isMittelstufe()){
    return schulnoteZuPunkte(Math.min(6,Math.max(1,Math.round(n))));
  }
  return Math.min(15,Math.max(0,n));
}

function renderAbi(){
  // Alle Fach/Halbjahr-Kombinationen sammeln
  const cellVals=[]; // {subj,sem,val}
  SUBJECTS.forEach(subj=>{
    SEMESTERS.forEach(sem=>{
      const v=overallAvgSem(subj,sem);
      if(v!==null) cellVals.push({subj,sem,val:v});
    });
  });
  const allVals=cellVals.map(c=>c.val);
  const gAvg=allVals.length?avg(allVals):null;
  const gC=scoreColor(gAvg!==null?Math.round(gAvg):null);
  const totalSlots=SUBJECTS.length*SEMESTERS.length;

  let h=`<div class="metrics">
    <div class="metric"><div class="metric-label">Halbjahresergebnisse erfasst</div><div class="metric-value">${cellVals.length} / ${totalSlots}</div></div>
    <div class="metric"><div class="metric-label">Gesamtdurchschnitt</div><div class="metric-value" style="color:${gAvg!==null?gC.fg:"var(--text)"}">${fmt(gAvg)}</div></div>
    <div class="metric"><div class="metric-label">Bester Wert</div><div class="metric-value">${allVals.length?Math.max(...allVals).toFixed(1):"—"}</div></div>
    <div class="metric"><div class="metric-label">Schwächster Wert</div><div class="metric-value">${allVals.length?Math.min(...allVals).toFixed(1):"—"}</div></div>
  </div>`;

  h+=`<div class="section-head" style="display:flex;justify-content:space-between;align-items:center">
    <span>Fächer im Verlauf ${SEMESTERS.length>1?SEM_LABELS[SEMESTERS[0]]+" → "+SEM_LABELS[SEMESTERS[SEMESTERS.length-1]]:SEM_LABELS[SEMESTERS[0]]}</span>
    <span style="display:flex;gap:8px;text-transform:none;letter-spacing:0">
      <button class="btn" style="padding:5px 12px;font-size:11px;font-weight:600" onclick="window.print()">🖨 Drucken</button>
      <button class="btn" style="padding:5px 12px;font-size:11px;font-weight:600" onclick="exportAbiCSV()">⬇ CSV exportieren</button>
      <button class="btn ${scenarioMode?"btn-primary":""}" style="padding:5px 12px;font-size:11px;font-weight:600" onclick="toggleScenarioMode()">${scenarioMode?"✓ Was-wäre-wenn aktiv":"Was-wäre-wenn?"}</button>
      ${scenarioMode?`<button class="btn" style="padding:5px 12px;font-size:11px;font-weight:600" onclick="resetScenario()">Zurücksetzen</button>`:""}
    </span>
  </div>`;
  if(scenarioMode){
    h+=`<p style="font-size:11px;color:var(--text-muted);margin:-6px 0 12px">Trag für noch offene Halbjahre hypothetische Punkte ein (0–15) und sieh dir die Auswirkung auf deine Hochrechnung unten an. Echte Einträge haben Vorrang und werden nicht überschrieben. Diese Werte werden nicht gespeichert.</p>`;
  }
  h+=`<div class="ov-table"><table>
    <thead><tr><th>Fach</th>${SEMESTERS.map(sem=>`<th>${SEM_LABELS[sem]}</th>`).join("")}<th>Ø gesamt</th><th>Verlauf</th></tr></thead>
    <tbody>`;
  SUBJECTS.forEach(subj=>{
    const rowCells=SEMESTERS.map(sem=>{
      const real=overallAvgSem(subj,sem);
      if(real!==null) return pill(real);
      if(scenarioMode){
        const key=subj+"|"+sem;
        const val=scenarioVals[key]!==undefined?scenarioVals[key]:"";
        return `<input type="number" min="0" max="15" placeholder="0–15" value="${val}" style="width:56px;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:12px" onchange="setScenarioVal('${subj}','${sem}',this.value)">`;
      }
      return pill(null);
    });
    const rowValsEff=SEMESTERS.map(sem=>overallAvgSemEff(subj,sem));
    const rowAvg=avg(rowValsEff.filter(v=>v!==null));
    h+=`<tr><td class="subj">${subj}</td>${rowCells.map(c=>`<td>${c}</td>`).join("")}<td>${pill(rowValsEff.filter(v=>v!==null).length?rowAvg:null)}</td><td>${sparklineSVG(rowValsEff)}</td></tr>`;
  });
  h+=`</tbody></table></div>`;

  const semPairs=SEMESTERS.slice(0,-1).map((sem,i)=>[sem,SEMESTERS[i+1]]);
  if(semPairs.length){
    h+=`<div class="section-head">Halbjahresvergleich: Entwicklung ${SEMESTERS.map(sem=>SEM_LABELS[sem]).join(" → ")}</div>
    <div class="ov-table"><table>
      <thead><tr><th>Fach</th>${semPairs.map(([a,b])=>`<th>${SEM_LABELS[a]} → ${SEM_LABELS[b]}</th>`).join("")}</tr></thead>
      <tbody>`;
    const gesamtPerSem={}; SEMESTERS.forEach(sm=>gesamtPerSem[sm]=[]);
    SUBJECTS.forEach(subj=>{
      const vals={};
      SEMESTERS.forEach(sem=>{ vals[sem]=overallAvgSemEff(subj,sem); if(vals[sem]!==null) gesamtPerSem[sem].push(vals[sem]); });
      h+=`<tr><td class="subj">${subj}</td>${semPairs.map(([a,b])=>`<td>${trendBadge(vals[a],vals[b])}</td>`).join("")}</tr>`;
    });
    const gVals={}; SEMESTERS.forEach(sem=>{ gVals[sem]=gesamtPerSem[sem].length?avg(gesamtPerSem[sem]):null; });
    h+=`<tr style="font-weight:700"><td class="subj">Gesamt</td>${semPairs.map(([a,b])=>`<td>${trendBadge(gVals[a],gVals[b])}</td>`).join("")}</tr>`;
    h+=`</tbody></table></div>`;
  }

  h+=`<div class="section-head">Klausur-Status je Halbjahr</div><div class="card-grid">`;
  SEMESTERS.forEach(sem=>{
    const doneCount=Object.keys(KLAUSUR_SLOTS).reduce((sum,subj)=>sum+Math.min(entriesForSem("klausuren",sem).filter(e=>e.subj===subj).length,KLAUSUR_SLOTS[subj]),0);
    const totalCount=Object.values(KLAUSUR_SLOTS).reduce((a,b)=>a+b,0);
    const done=doneCount>=totalCount;
    h+=`<div class="card">
      <div class="card-top">
        <div class="card-name">${SEM_LABELS[sem]}${done?`<span class="tag tag-ok">✓ komplett</span>`:`<span class="tag tag-warn">${doneCount}/${totalCount}</span>`}</div>
      </div>
      <div class="slot-label">${doneCount} von ${totalCount} Klausuren geschrieben</div>
    </div>`;
  });
  h+=`</div>`;

  h+=`<div class="section-head">Gesamtnotenpunkte-Hochrechnung</div>
  <div class="form-section">
    <div class="form-title">Einstellungen</div>
    <div class="form-grid">
      <div class="fg">
        <label>Zielabschluss</label>
        <select id="f-abiziel" onchange="setAbiZiel(this.value)">
          <option value="beide" ${abiSettings.ziel==="beide"?"selected":""}>Beide offen halten</option>
          <option value="abitur" ${abiSettings.ziel==="abitur"?"selected":""}>Abitur</option>
          <option value="fachabi" ${abiSettings.ziel==="fachabi"?"selected":""}>Fachhochschulreife</option>
        </select>
      </div>
    </div>`;

  if(abiSettings.ziel==="abitur"||abiSettings.ziel==="beide"){
    const maxLK=(CONFIG.abiturModule.numLK)||2;
    h+=`<div style="margin-top:6px">
      <label style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em">Leistungskurse (max. ${maxLK}, für Abitur-Hochrechnung)</label>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">
        ${SUBJECTS.map(s=>`<button class="btn ${abiSettings.lk.includes(s)?"btn-primary":""}" style="padding:6px 14px;font-size:12px" onclick="toggleLK('${s}')">${s}</button>`).join("")}
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin-top:8px">${abiSettings.lk.length===maxLK?"LK gewählt: "+abiSettings.lk.join(" & ")+" — doppelte Gewichtung gilt erst ab "+(SEM_LABELS[SEMESTERS[CONFIG.abiturModule.lkDoubleFromIndex]]||"der konfigurierten Periode")+" (davor zählen sie einfach, wie ein GK).":"Noch nicht alle "+maxLK+" LK gewählt — bis dahin wird mit einheitlicher Gewichtung (kein LK-Bonus) gerechnet."}</p>
    </div>

    <div style="margin-top:18px">
      <label style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em">Abiturprüfungen (Block II) — optional, je 0–15 Punkte</label>
      <div class="form-grid" style="margin-top:8px">
        ${abiSettings.block2.map((p,i)=>`
          <div class="fg">
            <label>Prüfung ${i+1}</label>
            <input type="number" min="0" max="15" placeholder="0–15" value="${p.punkte}" onchange="setBlock2(${i},'punkte',this.value)">
          </div>`).join("")}
      </div>
    </div>`;
  }
  h+=`</div>`;

  // Berechnungen
  const avgFn=scenarioMode?overallAvgSemEff:overallAvgSem;
  const bi=computeBlockI(avgFn);
  const bii=computeBlockII();

  if(abiSettings.ziel==="abitur"||abiSettings.ziel==="beide"){
    const gesamt=bi.blockI!==null?bi.blockI+(bii.blockII||0):null;
    const note=punkteToNote(gesamt);
    h+=`<div class="section-head">Abitur-Hochrechnung${scenarioMode?` <span style="color:var(--gold-light);background:var(--navy-mid);padding:2px 8px;border-radius:10px;font-size:10px;letter-spacing:0;text-transform:none;vertical-align:middle">inkl. Szenario</span>`:""}</div>
    <div class="metrics">
      <div class="metric"><div class="metric-label">Block I (Qualifikationsphase, max. 600)</div><div class="metric-value">${bi.blockI!==null?bi.blockI:"—"}</div></div>
      <div class="metric"><div class="metric-label">Block II (Abiturprüfung, max. 300)</div><div class="metric-value">${bii.blockII!==null?bii.blockII:"—"} <span style="font-size:11px;color:var(--text-muted)">(${bii.count}/${CONFIG.abiturModule.numPruefungsfaecher||abiSettings.block2.length} eingetragen)</span></div></div>
      <div class="metric"><div class="metric-label">Gesamtpunktzahl (max. 900)</div><div class="metric-value">${gesamt!==null?gesamt:"—"}</div></div>
      <div class="metric"><div class="metric-label">Voraussichtliche Note</div><div class="metric-value" style="color:${note!==null?scoreColor(note<=2.5?13:note<=4?9:2).fg:"var(--text)"}">${note!==null?note.toFixed(1):"—"}</div></div>
      <div class="metric"><div class="metric-label">≈ US-GPA (Näherung)</div><div class="metric-value">${note!==null?noteToGPA(note).toFixed(2):"—"}</div></div>
    </div>
    <p style="font-size:11px;color:var(--text-muted);margin:-12px 0 20px">Bestanden ab 300 Gesamtpunkten (mind. 200 in Block I, 100 in Block II). 1,0 ab 823 Punkten. Die GPA-Spalte ist eine Näherung nach der <em>Modified Bavarian Formula</em> für internationale Bewerbungen, keine offizielle Umrechnung.</p>`;
  }

  if(abiSettings.ziel==="fachabi"||abiSettings.ziel==="beide"){
    const allVals=[]; SUBJECTS.forEach(s=>SEMESTERS.forEach(sem=>{const v=avgFn(s,sem); if(v!==null) allVals.push(v);}));
    const fAvg=allVals.length?avg(allVals):null;
    const fNote=fAvg!==null?Math.floor(((17-fAvg)/3)*10)/10:null;
    h+=`<div class="section-head">Fachhochschulreife-Hochrechnung (schulischer Teil)${scenarioMode?` <span style="color:var(--gold-light);background:var(--navy-mid);padding:2px 8px;border-radius:10px;font-size:10px;letter-spacing:0;text-transform:none;vertical-align:middle">inkl. Szenario</span>`:""}</div>
    <div class="metrics">
      <div class="metric"><div class="metric-label">Ø Punkte über alle Halbjahre</div><div class="metric-value">${fmt(fAvg)}</div></div>
      <div class="metric"><div class="metric-label">Geschätzte Note</div><div class="metric-value">${fNote!==null?fNote.toFixed(1):"—"}</div></div>
      <div class="metric"><div class="metric-label">≈ US-GPA (Näherung)</div><div class="metric-value">${fNote!==null?noteToGPA(fNote).toFixed(2):"—"}</div></div>
    </div>
    <p style="font-size:11px;color:var(--text-muted);margin:-12px 0 20px">Für die volle Fachhochschulreife kommt zusätzlich der berufsbezogene Teil (z.B. Praktikum) hinzu, der hier nicht erfasst wird. Die GPA-Spalte ist eine Näherung nach der <em>Modified Bavarian Formula</em>, keine offizielle Umrechnung.</p>`;
  }

  h+=`<div class="form-section">
    <div class="form-title">Wichtiger Hinweis</div>
    <p style="font-size:12px;color:var(--text-muted);line-height:1.6">
      Diese Hochrechnung basiert nur auf den ${SUBJECTS.length} in dieser App erfassten Fächern. Die echte Gesamtqualifikation bezieht
      zusätzlich weitere Fächer ein (z.B. Sport, Religion/Ethik, Kunst/Musik) und unterliegt genauen
      Einbringungs- und Ausgleichsregelungen, die je nach Schule/Abendschule leicht abweichen können. Nutze diese Zahlen
      als Orientierung und gleiche sie zur Sicherheit mit deiner Schulleitung bzw. Oberstufenberatung ab.
    </p>
  </div>`;
  return h;
}

/* ======================= Mittelstufen-Modus (Realschule/Haupt-/Mittelstufe) =======================
 * Rechnet mit denselben 0-15-Punkte-Einträgen wie der Rest der App, leitet daraus aber pro Fach eine
 * Schulnote (1-6) her (Standard-Umrechnungstabelle) und bildet einen Zeugnisdurchschnitt sowie eine
 * vereinfachte Versetzungs-Einschätzung — als Orientierung, nicht als verbindliche Berechnung, da die
 * genauen Versetzungsordnungen je nach Bundesland und Schulform (Haupt-/Realschule) unterschiedlich sind.
 */
function renderMittelstufe(){
  const sem=activeSem||SEMESTERS[0];
  let h=`<div class="section-head" style="display:flex;justify-content:space-between;align-items:center">
    <span>Zeugnisnoten ${SEM_LABELS[sem]||""}</span>
  </div>`;

  const rows=SUBJECTS.map(subj=>{
    const avgPunkte=overallAvgSem(subj,sem);
    const note=avgPunkte!==null?punkteZuSchulnote(Math.round(avgPunkte)):null;
    return {subj,avgPunkte,note};
  });
  const notenVorhanden=rows.filter(r=>r.note!==null).map(r=>r.note);
  const zeugnisDurchschnitt=notenVorhanden.length?avg(notenVorhanden):null;

  h+=`<div class="metrics">
    <div class="metric"><div class="metric-label">Zeugnisdurchschnitt</div><div class="metric-value">${zeugnisDurchschnitt!==null?zeugnisDurchschnitt.toFixed(1):"—"}</div></div>
    <div class="metric"><div class="metric-label">Beste Note</div><div class="metric-value">${notenVorhanden.length?Math.min(...notenVorhanden):"—"}</div></div>
    <div class="metric"><div class="metric-label">Schwächste Note</div><div class="metric-value">${notenVorhanden.length?Math.max(...notenVorhanden):"—"}</div></div>
    <div class="metric"><div class="metric-label">Fächer erfasst</div><div class="metric-value">${notenVorhanden.length} / ${SUBJECTS.length}</div></div>
  </div>`;

  h+=`<div class="ov-table"><table>
    <thead><tr><th>Fach</th><th>Schulnote</th></tr></thead>
    <tbody>
      ${rows.map(r=>`<tr><td class="subj">${r.subj}</td><td>${r.note!==null?`<strong>${r.note}</strong> <span class="muted">(${schulnoteLabel(r.note)})</span>`:"—"}</td></tr>`).join("")}
    </tbody>
  </table></div>`;

  const mangelhaft=rows.filter(r=>r.note===5).length;
  const unguengend=rows.filter(r=>r.note===6).length;
  let einschaetzung, einschaetzungColor;
  if(!notenVorhanden.length){
    einschaetzung="Noch keine Noten erfasst."; einschaetzungColor="var(--text-muted)";
  } else if(unguengend>=1||mangelhaft>=3){
    einschaetzung="Versetzung nach dieser Daumenregel gefährdet — mind. 1× ungenügend oder 3+× mangelhaft."; einschaetzungColor="var(--red-fg)";
  } else if(mangelhaft===2){
    einschaetzung="Versetzung meist nur mit Ausgleich möglich (z.B. eine gute Note in einem anderen Fach) — hängt von der genauen Versetzungsordnung ab."; einschaetzungColor="var(--yellow-fg)";
  } else if(mangelhaft===1){
    einschaetzung="In der Regel unproblematisch (1× mangelhaft wird meist toleriert)."; einschaetzungColor="var(--green-fg)";
  } else {
    einschaetzung="Keine mangelhaften/ungenügenden Noten — Versetzung nach dieser Daumenregel unproblematisch."; einschaetzungColor="var(--green-fg)";
  }

  h+=`<div class="section-head">Versetzungs-Einschätzung (vereinfachte Daumenregel)</div>
  <div class="form-section">
    <p style="font-size:14px;font-weight:600;color:${einschaetzungColor};margin-bottom:10px">${einschaetzung}</p>
    <p style="font-size:12px;color:var(--text-muted);line-height:1.6">
      Mangelhaft (5): <strong>${mangelhaft}</strong> Fach/Fächer · Ungenügend (6): <strong>${unguengend}</strong> Fach/Fächer.
      <strong>Wichtig:</strong> Die echten Versetzungsregeln unterscheiden sich nach Bundesland und Schulform (Haupt-, Real-, Gesamtschule)
      und berücksichtigen oft auch, in welchen Fächern (Kernfach vs. Nebenfach) die Note steht, sowie Ausgleichsmöglichkeiten.
      Diese Einschätzung ist nur eine grobe Orientierung — verbindlich ist allein, was deine Schule dir mitteilt.
    </p>
  </div>`;

  return h;
}

/* ======================= Zielnoten-Rechner ======================= */
/* Vereinfachtes Modell: zählt für das aktuelle Halbjahr alle Klausuren/mündlichen/sonstigen Noten
 * eines Fachs flach gleich gewichtet (anders als der Fach-Gesamtdurchschnitt in der Übersicht, der die
 * drei Kategorien je einmal mittelt) und rechnet aus, welchen Punkte-Schnitt die restlichen, noch
 * geplanten Prüfungen bräuchten, um ein selbst gesetztes Ziel zu erreichen. */
function renderZiele(){
  const sem=activeSem||SEMESTERS[0];
  if(!SUBJECTS.length||!sem) return `<div class="empty-state"><p>Noch keine Fächer/Halbjahre angelegt.</p></div>`;
  const mittel=isMittelstufe();
  let h=`<div class="section-head">Zielnoten ${SEM_LABELS[sem]||""}</div>
  <p style="font-size:12px;color:var(--text-muted);margin:-8px 0 20px;line-height:1.6">
    Setze pro Fach ein Ziel für den Halbjahresdurchschnitt. Der Rechner zeigt, welchen Schnitt du in den noch
    geplanten Prüfungen brauchst, um es zu erreichen. <strong>Vereinfachtes Modell:</strong> hier zählt jede einzelne
    Note gleich (Klausur, mündlich, sonstige) — anders als der Fach-Gesamtdurchschnitt in der Übersicht, der die drei
    Kategorien je einmal mittelt und deshalb leicht abweichen kann.
  </p>
  <div class="card-grid">`;

  SUBJECTS.forEach(subj=>{
    const key=subj+"|"+sem;
    const zielPunkte=(data.zielnoten&&data.zielnoten[key]!==undefined)?data.zielnoten[key]:null;
    const entries=["klausuren","muendlich","sonstige"].flatMap(cat=>entriesForSem(cat,sem).filter(e=>e.subj===subj));
    const scores=entries.map(e=>Number(e.score)).filter(v=>!isNaN(v));
    const n=scores.length;
    const sum=scores.reduce((a,b)=>a+b,0);
    const currentAvg=n?sum/n:null;
    const planN=zielPlanN[key]!==undefined?zielPlanN[key]:1;
    const zielInputVal=zielPunkte!==null?(mittel?punkteZuSchulnote(zielPunkte):zielPunkte):"";

    let statusHTML;
    if(zielPunkte===null){
      statusHTML=`<p style="font-size:12px;color:var(--text-muted)">Noch kein Ziel gesetzt.</p>`;
    } else if(currentAvg!==null&&currentAvg>=zielPunkte){
      statusHTML=`<p style="font-size:12px;color:var(--green-fg);font-weight:600">🎉 Ziel in diesem Halbjahr bereits erreicht.</p>`;
    } else {
      const neededAvgPunkte=(zielPunkte*(n+planN)-sum)/planN;
      if(neededAvgPunkte>15){
        statusHTML=`<p style="font-size:12px;color:var(--red-fg)">Mit ${planN} weiteren Prüfung(en) rechnerisch nicht mehr erreichbar (bräuchtest mehr als 15 Punkte Ø). Erhöhe die Anzahl geplanter Prüfungen oder passe das Ziel an.</p>`;
      } else {
        const display=mittel?`Note ${punkteZuKontinuierlicherNote(neededAvgPunkte).toFixed(1)}`:`${neededAvgPunkte.toFixed(1)} Punkte`;
        statusHTML=`<p style="font-size:12px">Benötigter Ø in den nächsten <strong>${planN}</strong> Prüfung(en): <strong style="color:var(--gold)">${display}</strong></p>`;
      }
    }

    h+=`<div class="card" style="align-items:stretch;min-width:240px">
      <div class="card-top"><div class="card-name">${subj}</div></div>
      <div style="display:flex;align-items:center;gap:8px;margin:8px 0;font-size:12px;color:var(--text-muted)">
        <label>Ziel (${mittel?"Note 1–6":"Punkte 0–15"})</label>
        <input type="number" min="${mittel?1:0}" max="${mittel?6:15}" value="${zielInputVal}" placeholder="–"
          style="width:60px;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)"
          onchange="setZielnote('${subj}','${sem}',this.value)">
      </div>
      <p style="font-size:12px;color:var(--text-muted);margin:4px 0">
        Aktueller Schnitt: ${currentAvg!==null?(mittel?`Note ${punkteZuKontinuierlicherNote(currentAvg).toFixed(1)}`:`${currentAvg.toFixed(1)} Punkte`):"—"}
        <span class="muted">(${n} Note${n===1?"":"n"})</span>
      </p>
      <div style="display:flex;align-items:center;gap:8px;margin:4px 0 8px;font-size:12px;color:var(--text-muted)">
        <label>Geplante weitere Prüfungen</label>
        <input type="number" min="1" max="20" value="${planN}" style="width:50px;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)" onchange="setZielPlanN('${subj}','${sem}',this.value)">
      </div>
      ${statusHTML}
    </div>`;
  });

  h+=`</div>`;
  return h;
}
async function setZielnote(subj,sem,raw){
  if(!data.zielnoten) data.zielnoten={};
  const key=subj+"|"+sem;
  const val=parseScoreInput(raw);
  if(val===null) delete data.zielnoten[key]; else data.zielnoten[key]=val;
  await saveData();
  render();
}
function setZielPlanN(subj,sem,raw){
  const key=subj+"|"+sem;
  zielPlanN[key]=Math.max(1,Math.min(20,Number(raw)||1));
  render();
}

/* ======================= Fehlstunden/Absenzen-Tracker ======================= */
const ABSENZ_STATUS={
  entschuldigt:{label:"Entschuldigt",fg:"var(--green-fg)",bg:"var(--green-bg)",bd:"var(--green-bd)"},
  unentschuldigt:{label:"Unentschuldigt",fg:"var(--red-fg)",bg:"var(--red-bg)",bd:"var(--red-bd)"},
  offen:{label:"Offen/unklar",fg:"var(--yellow-fg)",bg:"var(--yellow-bg)",bd:"var(--yellow-bd)"}
};
function absenzenForSem(sem){ return data.absenzen.filter(a=>a.sem===sem); }
function renderAbsenzen(){
  const sem=activeSem||SEMESTERS[0];
  const entries=absenzenForSem(sem);
  const sumStunden=cat=>entries.filter(a=>a.status===cat).reduce((s,a)=>s+(Number(a.stunden)||0),0);
  const gesamt=entries.reduce((s,a)=>s+(Number(a.stunden)||0),0);

  let h=`<div class="section-head">Fehlstunden ${SEM_LABELS[sem]||""}</div>
  <div class="metrics">
    <div class="metric"><div class="metric-label">Gesamt</div><div class="metric-value">${gesamt}</div></div>
    <div class="metric"><div class="metric-label">Entschuldigt</div><div class="metric-value" style="color:var(--green-fg)">${sumStunden("entschuldigt")}</div></div>
    <div class="metric"><div class="metric-label">Unentschuldigt</div><div class="metric-value" style="color:var(--red-fg)">${sumStunden("unentschuldigt")}</div></div>
    <div class="metric"><div class="metric-label">Offen/unklar</div><div class="metric-value" style="color:var(--yellow-fg)">${sumStunden("offen")}</div></div>
  </div>`;

  h+=`<div class="form-section">
    <div class="form-title">Neuer Eintrag</div>
    <div class="form-grid">
      <div class="fg"><label>Datum</label><input type="text" id="f-abs-date" placeholder="z.B. 15.01.2026"></div>
      <div class="fg"><label>Stunden</label><input type="number" id="f-abs-stunden" min="0" max="12" step="1" placeholder="z.B. 2"></div>
      <div class="fg"><label>Status</label><select id="f-abs-status">
        <option value="entschuldigt">Entschuldigt</option>
        <option value="unentschuldigt">Unentschuldigt</option>
        <option value="offen">Offen/unklar</option>
      </select></div>
      <div class="fg"><label>Fach (optional)</label><select id="f-abs-fach">
        <option value="">Allgemein/alle Fächer</option>
        ${SUBJECTS.map(s=>`<option value="${s}">${s}</option>`).join("")}
      </select></div>
      <div class="fg"><label>Bemerkung</label><input type="text" id="f-abs-note" placeholder="Optional..."></div>
    </div>
    <div class="form-footer"><button class="btn btn-primary" onclick="addAbsenz()">+ Eintragen</button></div>
  </div>`;

  h+=`<div class="table-card"><table><thead><tr>
    <th>Datum</th><th>Fach</th><th>Stunden</th><th>Status</th><th>Bemerkung</th><th></th>
  </tr></thead><tbody>`;
  if(!entries.length){
    h+=`<tr><td colspan="6"><div class="empty-state"><p>Noch keine Fehlstunden für dieses Halbjahr erfasst.</p></div></td></tr>`;
  } else {
    [...entries].reverse().forEach(a=>{
      const idx=data.absenzen.indexOf(a);
      const st=ABSENZ_STATUS[a.status]||ABSENZ_STATUS.offen;
      h+=`<tr>
        <td class="muted">${a.datum||"—"}</td>
        <td class="subj">${a.fach||"—"}</td>
        <td>${a.stunden}</td>
        <td><span class="badge" style="background:${st.bg};color:${st.fg};border-color:${st.bd}">${st.label}</span></td>
        <td class="muted" style="font-size:12px">${a.bemerkung||""}</td>
        <td>
          ${pendingDelete&&pendingDelete.kind==="absenz"&&pendingDelete.idx===idx
            ?`<span style="font-size:11px;color:var(--red-fg);margin-right:4px">Löschen?</span><button class="btn btn-primary" style="padding:3px 9px;font-size:11px" onclick="confirmDeleteAbsenz(${idx})">Ja</button> <button class="btn" style="padding:3px 9px;font-size:11px" onclick="cancelPendingDelete()">Nein</button>`
            :`<button class="btn-delete" onclick="requestDeleteAbsenz(${idx})" title="Löschen">✕</button>`}
        </td>
      </tr>`;
    });
  }
  h+=`</tbody></table></div>
  <p style="font-size:11px;color:var(--text-muted);margin-top:10px">Rein informativ — ersetzt keine offizielle Fehlzeitenerfassung deiner Schule.</p>`;
  return h;
}
async function addAbsenz(){
  const g=id=>document.getElementById(id).value;
  const stundenRaw=g("f-abs-stunden");
  const stunden=stundenRaw===""?0:Math.max(0,Number(stundenRaw));
  if(!stunden){ showToast("Bitte eine Stundenzahl größer 0 eintragen."); return; }
  data.absenzen.push({
    sem:activeSem, datum:g("f-abs-date").trim(), stunden,
    status:g("f-abs-status"), fach:g("f-abs-fach"), bemerkung:g("f-abs-note").trim()
  });
  await saveData();
  render();
}
function requestDeleteAbsenz(idx){ pendingDelete={kind:"absenz",idx}; render(); }
async function confirmDeleteAbsenz(idx){
  data.absenzen.splice(idx,1);
  pendingDelete=null;
  await saveData();
  render();
}

function renderStatistik(){
  const totalEntries=allEnteredScores().length;
  if(totalEntries<4){
    return `<div class="empty-state"><p>Noch nicht genug Daten für eine Analyse. Trag mindestens ein paar Noten ein, dann stehen dir hier Standardabweichung, Klausur-vs-Mündlich-Vergleich, Trendprognose, Korrelationsanalyse, Grenznutzen-Analyse, eine Monte-Carlo-Simulation, ein Bootstrap-Konfidenzintervall und ein Einbringungs-Optimierer zur Verfügung.</p></div>`;
  }

  let h="";

  /* 1) Konstanz & Z-Score-Ausreißer */
  h+=`<div class="section-head">Konstanz je Fach (Standardabweichung)</div>
  <div class="ov-table"><table>
    <thead><tr><th>Fach</th><th>Ø Punkte</th><th>Streuung (σ)</th><th>Einschätzung</th><th>n</th></tr></thead>
    <tbody>`;
  SUBJECTS.forEach(subj=>{
    const st=getSubjectStats(subj);
    let urteil="—";
    if(st.sd!==null){
      if(st.sd<1.2) urteil=`<span style="color:var(--green-fg)">sehr konstant</span>`;
      else if(st.sd<2.5) urteil=`<span style="color:var(--yellow-fg)">leicht schwankend</span>`;
      else urteil=`<span style="color:var(--red-fg)">stark schwankend</span>`;
    }
    h+=`<tr><td class="subj">${subj}</td><td>${pill(st.mean)}</td><td>${st.sd!==null?st.sd.toFixed(2):"—"}</td><td>${urteil}</td><td class="muted">${st.n}</td></tr>`;
  });
  h+=`</tbody></table></div>
  <p style="font-size:11px;color:var(--text-muted);margin:-12px 0 20px">σ (Sigma) zeigt, wie stark einzelne Noten um deinen Fach-Durchschnitt streuen. Niedrig = konstante Leistung, hoch = große Ausschläge nach oben oder unten.</p>`;

  const outliers=zScoreOutliers();
  if(outliers.length){
    h+=`<div class="section-head">Auffällige Einzelnoten (Z-Score-Ausreißer)</div>
    <div class="table-card"><table><thead><tr>
      <th>Fach</th><th>Art</th><th>Datum</th><th>Punkte</th><th>Fach-Ø</th><th>Z-Score</th>
    </tr></thead><tbody>`;
    outliers.slice(0,10).forEach(o=>{
      const good=o.z>0;
      h+=`<tr>
        <td class="subj">${o.subj}</td>
        <td class="muted">${o.type}</td>
        <td class="muted">${o.date||"—"}</td>
        <td>${pill(Number(o.score))}</td>
        <td class="muted">${o.fachMean.toFixed(1)}</td>
        <td style="color:${good?"var(--green-fg)":"var(--red-fg)"};font-weight:600">${good?"▲":"▼"} ${o.z.toFixed(2)}</td>
      </tr>`;
    });
    h+=`</tbody></table></div>
    <p style="font-size:11px;color:var(--text-muted);margin:-12px 0 20px">Noten mit |Z| ≥ 1.3 weichen deutlich von deinem persönlichen Fach-Durchschnitt ab — auffällig gut oder auffällig schwach relativ zu deiner sonstigen Leistung in diesem Fach.</p>`;
  }

  /* 2) Korrelationsanalyse */
  const correlations=subjectCorrelations();
  if(correlations.length){
    h+=`<div class="section-head">Korrelation zwischen Fächern</div>
    <div class="ov-table"><table>
      <thead><tr><th>Fächerpaar</th><th>Korrelation (r)</th><th>Tendenz</th><th>Datenpunkte</th></tr></thead>
      <tbody>`;
    correlations.slice(0,8).forEach(c=>{
      const abs=Math.abs(c.r);
      let tendenz,color;
      if(abs>=0.7){ tendenz=c.r>0?"stark gleichläufig":"stark gegenläufig"; color=c.r>0?"var(--green-fg)":"var(--red-fg)"; }
      else if(abs>=0.4){ tendenz=c.r>0?"mäßig gleichläufig":"mäßig gegenläufig"; color="var(--yellow-fg)"; }
      else { tendenz="kaum Zusammenhang"; color="var(--text-muted)"; }
      h+=`<tr><td class="subj">${c.a} ↔ ${c.b}</td><td style="color:${color};font-weight:600">${c.r.toFixed(2)}</td><td class="muted">${tendenz}</td><td class="muted">${c.n}</td></tr>`;
    });
    h+=`</tbody></table></div>
    <p style="font-size:11px;color:var(--text-muted);margin:-12px 0 20px">Basis sind max. 4 Halbjahreswerte pro Fach — die Datengrundlage ist klein, Werte zeigen also eine Tendenz, keinen statistischen Beweis. Hoher gleichläufiger Wert = wenn ein Fach besser läuft, läuft das andere tendenziell auch besser (z.B. allgemeine Lernintensität); gegenläufig = eher ein Verteilungskonflikt zwischen den Fächern.</p>`;
  }

  /* 2b) Klausur-vs-Mündlich-Vergleich */
  const kvm=klausurVsMuendlichVergleich();
  if(kvm.length){
    h+=`<div class="section-head">Klausur vs. Mündlich: Wo liegt der Unterschied?</div>
    <div class="ov-table"><table>
      <thead><tr><th>Fach</th><th>Ø Klausuren</th><th>Ø Mündlich</th><th>Differenz</th></tr></thead>
      <tbody>`;
    kvm.forEach(r=>{
      const color=Math.abs(r.diff)<1?"var(--text-muted)":(r.diff>0?"var(--green-fg)":"var(--red-fg)");
      const text=Math.abs(r.diff)<0.3?"kaum Unterschied":(r.diff>0?`schriftlich stärker`:`mündlich stärker`);
      h+=`<tr><td class="subj">${r.subj}</td><td>${pill(r.kAvg)}</td><td>${pill(r.mAvg)}</td><td style="color:${color};font-weight:600">${r.diff>0?"+":""}${r.diff.toFixed(1)} <span class="muted" style="font-weight:400">(${text})</span></td></tr>`;
    });
    h+=`</tbody></table></div>
    <p style="font-size:11px;color:var(--text-muted);margin:-12px 0 20px">Positive Differenz = Klausuren besser als mündliche Mitarbeit, negative Differenz = umgekehrt. Große Unterschiede können auf Prüfungsangst, Vorbereitungslücken oder einfach unterschiedliche Stärken (schriftlich vs. mündlich) hindeuten.</p>`;
  }

  /* 3) Trendprognose mit Unsicherheitsband */
  h+=`<div class="section-head">Trendprognose fürs nächste Halbjahr</div>
  <div class="ov-table"><table>
    <thead><tr><th>Fach</th><th>Prognose</th><th>Unsicherheitsband</th><th>Basis</th></tr></thead>
    <tbody>`;
  const nextSem=SEMESTERS.find(s=>!SUBJECTS.every(subj=>overallAvgSem(subj,s)!==null))||null;
  SUBJECTS.forEach(subj=>{
    const targetSem=nextSem||SEMESTERS[SEMESTERS.length-1];
    const p=predictSemester(subj,targetSem);
    if(!p){ h+=`<tr><td class="subj">${subj}</td><td colspan="3" class="muted">Zu wenig Datenpunkte (min. 2 Halbjahre nötig)</td></tr>`; return; }
    h+=`<tr><td class="subj">${subj}</td><td>${pill(p.pred)}</td><td class="muted">${p.low.toFixed(1)} – ${p.high.toFixed(1)}</td><td class="muted">${p.n} Halbjahre</td></tr>`;
  });
  h+=`</tbody></table></div>
  <p style="font-size:11px;color:var(--text-muted);margin:-12px 0 20px">Lineare Regression über deine bisherigen Halbjahreswerte, projiziert auf ${SEM_LABELS[nextSem||SEMESTERS[SEMESTERS.length-1]]}. Das Band ist keine exakte Konfidenzgrenze (dafür sind 2–4 Datenpunkte zu wenig), sondern eine grobe Unsicherheitsspanne (±1 Streuung).</p>`;

  /* 3b) GPA / internationale Notenskala (Näherung) */
  h+=`<div class="section-head">GPA / internationale Notenskala (Näherung)</div>
  <div class="ov-table"><table>
    <thead><tr><th>Fach</th><th>Ø Punkte (gesamt)</th><th>≈ Note</th><th>≈ US-GPA</th></tr></thead>
    <tbody>
      ${SUBJECTS.map(subj=>{
        const a=overallAvg(subj);
        const note=a!==null?punkteZuKontinuierlicherNote(a):null;
        const gpa=noteToGPA(note);
        return `<tr><td class="subj">${subj}</td><td>${fmt(a)}</td><td>${note!==null?note.toFixed(1):"—"}</td><td style="font-weight:600">${gpa!==null?gpa.toFixed(2):"—"}</td></tr>`;
      }).join("")}
    </tbody>
  </table></div>
  <p style="font-size:11px;color:var(--text-muted);margin:-12px 0 20px">Näherung für internationale Bewerbungen: die Punkte→Note-Umrechnung folgt der in der Oberstufe üblichen Formel (Note = (17−Punkte)/3), die GPA-Umrechnung der <em>Modified Bavarian Formula</em> (GPA = 5−Note, ab Note 4,1 = 0,0), wie sie u.a. von WES für deutsche Abschlüsse verwendet wird. Das ist eine verbreitete Näherung, keine offizielle Umrechnung — Hochschulen/Programme im Ausland können eigene Konvertierungstabellen verlangen.</p>`;

  /* 4-6) Abitur/Fachabi-gebundene Analysen (Grenznutzen, Monte-Carlo, Bootstrap, Optimierer) */
  if(!(CONFIG&&CONFIG.abiturModuleEnabled)){
    h+=`<div class="section-head">Weitere Analysen</div>
    <p style="font-size:12px;color:var(--text-muted);margin-bottom:20px">Grenznutzen-Analyse, Monte-Carlo-Simulation, Bootstrap-Konfidenzintervall und Einbringungs-Optimierer basieren auf dem Abitur/Fachabi-Modell (Block I/II). Aktiviere das Abitur/Fachabi-Modul in den <a href="#" onclick="switchTab('faecher');return false" style="color:var(--gold)">Einstellungen</a>, um sie zu sehen.</p>`;
    return h;
  }

  /* 4) Grenznutzen-Analyse */
  const mu=marginalUtility();
  if(mu.rows.length){
    h+=`<div class="section-head">Grenznutzen-Analyse: Was bringt am meisten?</div>
    <div class="ov-table"><table>
      <thead><tr><th>Fach</th><th>+1 Punkt bringt</th><th>Hebel</th></tr></thead>
      <tbody>`;
    mu.rows.forEach(r=>{
      h+=`<tr><td class="subj">${r.subj}${r.isLK?` <span class="tag tag-ok" style="margin-left:4px">LK</span>`:""}</td><td style="font-weight:600;color:var(--green-fg)">+${r.delta} Punkte</td><td class="muted">${"█".repeat(Math.max(1,Math.round(r.delta)))}</td></tr>`;
    });
    h+=`</tbody></table></div>
    <p style="font-size:11px;color:var(--text-muted);margin:-12px 0 20px">Zeigt, wie stark sich Block I (max. 600) verändert, wenn sich der Durchschnitt in genau diesem Fach um 1 Punkt verbessert (ab ${SEM_LABELS[SEMESTERS[CONFIG.abiturModule.lkDoubleFromIndex]]||"der konfigurierten Periode"} zählen Leistungskurse doppelt — daher meist größerer Hebel). Baseline Block I aktuell: ${mu.baseline} Punkte.</p>`;
  }

  /* 5) Monte-Carlo-Simulation */
  h+=`<div class="section-head" style="display:flex;justify-content:space-between;align-items:center">
    <span>Monte-Carlo-Simulation: Wahrscheinliche Gesamtpunktzahl</span>
    <button class="btn btn-primary" style="padding:5px 12px;font-size:11px;font-weight:600" onclick="runMonteCarloAndRender()">🎲 Simulation starten (2000 Durchläufe)</button>
  </div>`;
  if(!monteCarloResult){
    h+=`<p style="font-size:12px;color:var(--text-muted);margin-bottom:20px">Noch keine Simulation gelaufen. Offene Halbjahre/Prüfungen werden dabei zufällig aus deiner bisherigen Streuung pro Fach gezogen (2000 Durchläufe), um eine realistische Bandbreite statt einer einzelnen Prognosezahl zu zeigen.</p>`;
  } else {
    const r=monteCarloResult;
    h+=`<div class="metrics">
      <div class="metric"><div class="metric-label">10. Perzentil (pessimistisch)</div><div class="metric-value">${r.p10}</div></div>
      <div class="metric"><div class="metric-label">Median (50. Perzentil)</div><div class="metric-value" style="color:var(--gold)">${r.p50}</div></div>
      <div class="metric"><div class="metric-label">90. Perzentil (optimistisch)</div><div class="metric-value">${r.p90}</div></div>
      <div class="metric"><div class="metric-label">Spannweite gesamt</div><div class="metric-value" style="font-size:16px">${r.min}–${r.max}</div></div>
    </div>
    <p style="font-size:11px;color:var(--text-muted);margin:-12px 0 20px">Mit 80% Wahrscheinlichkeit landest du laut Simulation zwischen <b>${r.p10}</b> und <b>${r.p90}</b> Gesamtpunkten (von max. 900). Basiert auf ${r.trials} simulierten Verläufen auf Basis deiner bisherigen Notenstreuung je Fach — jede neue Simulation liefert eine leicht andere Stichprobe.</p>`;
  }

  /* 5b) Bootstrap-Konfidenzintervall */
  h+=`<div class="section-head" style="display:flex;justify-content:space-between;align-items:center">
    <span>Bootstrap-Konfidenzintervall (verteilungsfrei)</span>
    <button class="btn btn-primary" style="padding:5px 12px;font-size:11px;font-weight:600" onclick="runBootstrapAndRender()">🔁 Bootstrap starten (2000 Durchläufe)</button>
  </div>`;
  if(!bootstrapResult){
    h+=`<p style="font-size:12px;color:var(--text-muted);margin-bottom:20px">Noch kein Bootstrap gelaufen. Im Gegensatz zur Monte-Carlo-Simulation (die eine Normalverteilung annimmt) zieht dieses Verfahren fehlende Werte direkt aus deinen tatsächlich eingetragenen Noten — robuster, wenn deine Notenverteilung schief oder unregelmäßig ist.</p>`;
  } else {
    const r=bootstrapResult;
    h+=`<div class="metrics">
      <div class="metric"><div class="metric-label">10. Perzentil (pessimistisch)</div><div class="metric-value">${r.p10}</div></div>
      <div class="metric"><div class="metric-label">Median (50. Perzentil)</div><div class="metric-value" style="color:var(--gold)">${r.p50}</div></div>
      <div class="metric"><div class="metric-label">90. Perzentil (optimistisch)</div><div class="metric-value">${r.p90}</div></div>
      <div class="metric"><div class="metric-label">Spannweite gesamt</div><div class="metric-value" style="font-size:16px">${r.min}–${r.max}</div></div>
    </div>
    <p style="font-size:11px;color:var(--text-muted);margin:-12px 0 20px">Mit 80% Wahrscheinlichkeit landest du laut Bootstrap-Resampling zwischen <b>${r.p10}</b> und <b>${r.p90}</b> Gesamtpunkten (von max. 900). Fehlende Noten werden dabei zufällig aus deinen eigenen bisherigen Noten gezogen (statt aus einer angenommenen Normalverteilung wie bei der Monte-Carlo-Simulation) — nützlich als Gegenprobe, falls deine Ergebnisse stark schief verteilt sind.</p>`;
  }

  /* 6) Einbringungs-Optimierer */
  h+=`<div class="section-head">Einbringungs-Optimierer (vereinfachtes Modell)</div>
  <div class="form-section">
    <div class="form-grid" style="max-width:260px">
      <div class="fg"><label>Max. ausschließbare schwache GK-Werte</label><input type="number" min="0" max="20" value="${optimizerMaxExclude}" onchange="setOptimizerMaxExclude(this.value)"></div>
    </div>`;
  const opt=optimizeEinbringung(optimizerMaxExclude);
  if(opt.withoutExclusion===null){
    h+=`<p style="font-size:12px;color:var(--text-muted)">Noch keine Grundkurs-Halbjahreswerte vorhanden.</p>`;
  } else {
    h+=`<div class="metrics">
      <div class="metric"><div class="metric-label">Block I ohne Ausschluss</div><div class="metric-value">${opt.withoutExclusion}</div></div>
      <div class="metric"><div class="metric-label">Block I mit Optimierung</div><div class="metric-value" style="color:var(--green-fg)">${opt.withExclusion}</div></div>
      <div class="metric"><div class="metric-label">Rechnerischer Gewinn</div><div class="metric-value" style="color:var(--green-fg)">+${opt.gain||0}</div></div>
    </div>`;
    if(opt.excluded.length){
      h+=`<p style="font-size:12px;margin-bottom:8px"><b>Schwächste ${opt.excluded.length} von ${opt.totalGk} GK-Werten, die im Modell ausgeschlossen würden:</b></p>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">
        ${opt.excluded.map(e=>`<span class="tag tag-warn">${e.subj} ${SEM_LABELS[e.sem]}: ${e.val.toFixed(1)}</span>`).join("")}
      </div>`;
    }
    h+=`<p style="font-size:11px;color:var(--text-muted)">Vereinfachtes Modell: schließt probeweise die schwächsten Grundkurs-Halbjahreswerte aus (Leistungskurse bleiben immer eingebracht). Die echten hessischen Einbringungsregeln sind fachspezifisch geregelt (bestimmte Fächer müssen durchgehend eingebracht werden, max. 6 Unterkurse dürfen unter 5 Punkten liegen) — dieses Ergebnis zeigt dir die Größenordnung des Hebels, ersetzt aber keine verbindliche Prüfung durch deine Oberstufenberatung.</p>`;
  }
  h+=`</div>`;

  return h;
}

function runMonteCarloAndRender(){
  monteCarloResult=runMonteCarlo(2000);
  render();
}
function runBootstrapAndRender(){
  bootstrapResult=runBootstrap(2000);
  render();
}
function setOptimizerMaxExclude(val){
  optimizerMaxExclude=Math.max(0,Math.min(20,Number(val)||0));
  render();
}

function renderFaecher(){
  let h=`<div class="section-head">Profile</div>
  <div class="form-section">
    <p style="font-size:12px;color:var(--text-muted);line-height:1.6;margin-bottom:12px">
      Jedes Profil hat einen komplett getrennten Datensatz (Fächer, Noten, Halbjahre, Abi-Einstellungen) — praktisch,
      wenn sich z.B. Geschwister denselben Browser teilen. Theme (hell/dunkel) gilt profilübergreifend.
    </p>
    <div class="form-grid">
      <div class="fg"><label>Name des neuen Profils</label><input type="text" id="f-newprofile" placeholder="z.B. Vorname"></div>
    </div>
    <div class="form-footer"><button class="btn btn-primary" onclick="createProfileFromForm()">+ Profil hinzufügen</button></div>
  </div>
  <div class="table-card"><table><thead><tr><th>Profil</th><th></th></tr></thead><tbody>
    ${PROFILES.map(p=>`<tr>
      <td>
        <input type="text" value="${p.name}" style="width:100%;max-width:220px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px" onchange="renameProfile('${p.id}',this.value)">
        ${p.id===activeProfileId?`<span class="tag tag-ok" style="margin-left:8px">aktiv</span>`:`<button class="btn" style="padding:3px 9px;font-size:11px;margin-left:8px" onclick="switchToProfile('${p.id}')">Wechseln</button>`}
      </td>
      <td>
        ${pendingDelete&&pendingDelete.kind==="profile"&&pendingDelete.id===p.id
          ?`<span style="font-size:11px;color:var(--red-fg);margin-right:4px">Löschen inkl. aller Daten?</span><button class="btn btn-primary" style="padding:3px 9px;font-size:11px" onclick="confirmDeleteProfile('${p.id}')">Ja</button> <button class="btn" style="padding:3px 9px;font-size:11px" onclick="cancelPendingDelete()">Nein</button>`
          :(PROFILES.length>1?`<button class="btn-delete" onclick="requestDeleteProfile('${p.id}')" title="Profil löschen">✕</button>`:"")}
      </td>
    </tr>`).join("")}
  </tbody></table></div>
  <p style="font-size:11px;color:var(--text-muted);margin:-12px 0 20px">Das Löschen eines Profils entfernt auch dessen Fächer, Noten und Einstellungen unwiderruflich. Exportiere vorher bei Bedarf eine Sicherungsdatei.</p>

  <div class="form-section">
    <div class="form-title">Einrichtung ändern</div>
    <p style="font-size:12px;color:var(--text-muted);line-height:1.6;margin-bottom:12px">Halbjahre, Fächer und das Abitur-Modul lassen sich unten einzeln anpassen. Wenn du stattdessen alles auf einmal neu durchgehen willst (z.B. weil die Anzahl Halbjahre nicht mehr passt), nutze den Einrichtungsassistenten erneut — bereits eingetragene Noten bleiben dabei erhalten.</p>
    <div class="form-footer"><button class="btn" onclick="runSetupWizard(true)">🔄 Einrichtungsassistent erneut durchlaufen</button></div>
  </div>

  <div class="form-section">
    <div class="form-title">Neues Fach hinzufügen</div>
    <div class="form-grid">
      <div class="fg"><label>Fachname</label><input type="text" id="f-newsubj" placeholder="z.B. Chemie, Religion, Sport"></div>
      <div class="fg"><label>Klausuren pro Halbjahr</label><input type="number" id="f-newslots" min="0" max="6" value="2"></div>
    </div>
    <div class="form-footer"><button class="btn btn-primary" onclick="addSubject()">+ Fach hinzufügen</button></div>
  </div>`;

  h+=`<div class="table-card"><table><thead><tr>
    <th>Fach</th><th>Klausuren/Halbjahr</th><th>Bereits vorhandene Einträge</th><th></th>
  </tr></thead><tbody>`;
  if(!SUBJECTS.length){
    h+=`<tr><td colspan="4"><div class="empty-state"><p>Keine Fächer vorhanden.</p></div></td></tr>`;
  } else {
    SUBJECTS.forEach(subj=>{
      const entryCount=["klausuren","muendlich","sonstige"].reduce((sum,cat)=>sum+data[cat].filter(e=>e.subj===subj).length,0);
      h+=`<tr>
        <td class="subj">${subj}</td>
        <td><input type="number" min="0" max="6" value="${KLAUSUR_SLOTS[subj]!==undefined?KLAUSUR_SLOTS[subj]:2}" style="width:60px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px" onchange="setSubjectSlots('${subj}',this.value)"></td>
        <td class="muted">${entryCount} Eintrag/Einträge${entryCount?" — bleiben beim Entfernen als Daten erhalten":""}</td>
        <td>
          ${pendingDelete&&pendingDelete.kind==="subject"&&pendingDelete.subj===subj
            ?`<span style="font-size:11px;color:var(--red-fg);margin-right:4px">Entfernen?</span><button class="btn btn-primary" style="padding:3px 9px;font-size:11px" onclick="confirmRemoveSubject('${subj}')">Ja</button> <button class="btn" style="padding:3px 9px;font-size:11px" onclick="cancelPendingDelete()">Nein</button>`
            :`<button class="btn-delete" onclick="requestRemoveSubject('${subj}')" title="Fach entfernen">✕</button>`}
        </td>
      </tr>`;
    });
  }
  h+=`</tbody></table></div>`;

  h+=`<div class="form-section">
    <div class="form-title">Hinweis</div>
    <p style="font-size:12px;color:var(--text-muted);line-height:1.6">
      Hier kannst du deine Fächerliste an zukünftige Halbjahre anpassen (z.B. wenn ein Fach wegfällt oder neu dazukommt).
      Entfernst du ein Fach, bleiben bereits eingetragene Noten dazu in den Rohdaten erhalten, tauchen aber nicht mehr
      in den Tabellen, der Übersicht oder der Abi/Fachabi-Hochrechnung auf. Füge es einfach mit demselben Namen wieder
      hinzu, um die alten Einträge wieder sichtbar zu machen.
    </p>
  </div>`;

  /* ======================= Perioden verwalten ======================= */
  h+=`<div class="section-head">Halbjahre / Perioden</div>
  <div class="form-section">
    <div class="form-grid">
      <div class="fg"><label>Name des neuen Halbjahrs</label><input type="text" id="f-newperiod" placeholder="z.B. Halbjahr 3, Trimester 2, Block A"></div>
    </div>
    <div class="form-footer"><button class="btn btn-primary" onclick="addPeriod()">+ Halbjahr hinzufügen</button></div>
  </div>
  <div class="table-card"><table><thead><tr><th>Halbjahr</th><th>Name</th><th></th></tr></thead><tbody>
    ${SEMESTERS.map(sem=>`<tr>
      <td class="muted">${sem}</td>
      <td><input type="text" value="${SEM_LABELS[sem]}" style="width:100%;max-width:220px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px" onchange="renamePeriod('${sem}',this.value)"></td>
      <td>
        ${pendingDelete&&pendingDelete.kind==="period"&&pendingDelete.sem===sem
          ?`<span style="font-size:11px;color:var(--red-fg);margin-right:4px">Entfernen?</span><button class="btn btn-primary" style="padding:3px 9px;font-size:11px" onclick="confirmRemovePeriod('${sem}')">Ja</button> <button class="btn" style="padding:3px 9px;font-size:11px" onclick="cancelPendingDelete()">Nein</button>`
          :`<button class="btn-delete" onclick="requestRemovePeriod('${sem}')" title="Halbjahr entfernen">✕</button>`}
      </td>
    </tr>`).join("")}
  </tbody></table></div>
  <p style="font-size:11px;color:var(--text-muted);margin:-12px 0 20px">Du kannst beliebig viele Halbjahre/Perioden anlegen und frei benennen. Entfernst du ein Halbjahr, bleiben bereits eingetragene Noten dazu erhalten, erscheinen aber nicht mehr in Tabellen und Auswertungen.</p>`;

  /* ======================= Abitur/Fachabi-Modul ======================= */
  const bl=BUNDESLAND_PRESETS[CONFIG.abiturModule.bundesland]||BUNDESLAND_PRESETS.custom;
  h+=`<div class="section-head">Abitur/Fachabi-Modul</div>
  <div class="form-section">
    <p style="font-size:12px;color:var(--text-muted);line-height:1.6;margin-bottom:12px">
      Optionales Zusatzmodul für die gymnasiale Oberstufe: errechnet Block I/II, Gesamtpunktzahl und Note nach dem
      bundesweiten KMK-Modell (300–900 Punkte). <strong>Wichtig:</strong> dieses Tool rechnet ein vereinfachtes Modell
      (Durchschnitt aller eingetragenen Noten, Leistungskurse doppelt gewichtet) — es bildet NICHT die exakte
      Einbringungspflicht (Auswahl einzelner Kurse) jedes Bundeslands nach. Für alle anderen Schulformen lässt du es
      am besten deaktiviert — der Rest der App funktioniert unabhängig davon.
    </p>
    <label style="display:flex;align-items:center;gap:10px;font-size:13px;cursor:pointer;margin-bottom:${CONFIG.abiturModuleEnabled?"14px":"0"}">
      <input type="checkbox" ${CONFIG.abiturModuleEnabled?"checked":""} onchange="toggleAbiturModule()"> Abitur/Fachabi-Modul aktivieren
    </label>`;
  if(CONFIG.abiturModuleEnabled){
    h+=`<div class="form-grid">
      <div class="fg"><label>Bundesland</label>
        <select onchange="setBundesland(this.value)">
          ${Object.keys(BUNDESLAND_PRESETS).map(code=>`<option value="${code}" ${CONFIG.abiturModule.bundesland===code?"selected":""}>${BUNDESLAND_PRESETS[code].name}</option>`).join("")}
        </select>
      </div>
      <div class="fg"><label>Leistungskurse zählen doppelt ab Halbjahr…</label>
        <select onchange="setLkDoubleFromIndex(this.value)">
          ${SEMESTERS.map((sem,i)=>`<option value="${i}" ${CONFIG.abiturModule.lkDoubleFromIndex===i?"selected":""}>${SEM_LABELS[sem]}</option>`).join("")}
        </select>
      </div>
      <div class="fg"><label>Fachhochschulreife: erste wie viele Halbjahre zählen?</label>
        <select onchange="setFachabiPeriodsCount(this.value)">
          ${SEMESTERS.map((sem,i)=>`<option value="${i+1}" ${(CONFIG.abiturModule.fachabiPeriodsCount===(i+1))?"selected":""}>${i+1}</option>`).join("")}
        </select>
      </div>`;
    if(CONFIG.abiturModule.bundesland==="custom"){
      h+=`<div class="fg"><label>Anzahl Leistungskurse</label>
        <select onchange="setNumLK(this.value)">
          ${[2,3,4].map(n=>`<option value="${n}" ${CONFIG.abiturModule.numLK===n?"selected":""}>${n}</option>`).join("")}
        </select>
      </div>
      <div class="fg"><label>Anzahl Abiturprüfungsfächer (Block II)</label>
        <select onchange="setNumPruefungsfaecher(this.value)">
          ${[4,5,6].map(n=>`<option value="${n}" ${CONFIG.abiturModule.numPruefungsfaecher===n?"selected":""}>${n}</option>`).join("")}
        </select>
      </div>`;
    }
    h+=`</div>`;
    if(bl.note||bl.confidence){
      h+=`<p style="font-size:11px;color:var(--text-muted);margin-top:10px;line-height:1.6">
        ${bl.confidence?`<strong>Datenqualität: ${bl.confidence}.</strong> `:""}${bl.note||""}
        ${bl.confidence==="niedrig"?" Bitte unbedingt mit deiner Schule/Oberstufenberatung abgleichen, bevor du dich darauf verlässt.":""}
      </p>`;
    }
  }
  h+=`</div>`;

  /* ======================= Mittelstufen-Modus ======================= */
  h+=`<div class="section-head">Mittelstufen-Modus</div>
  <div class="form-section">
    <p style="font-size:12px;color:var(--text-muted);line-height:1.6;margin-bottom:12px">
      Alternative zum Abitur/Fachabi-Modul für Haupt-/Realschule oder die Mittelstufe: leitet aus deinen
      Punkte-Einträgen (0–15) eine Schulnote (1–6) je Fach ab, zeigt einen Zeugnisdurchschnitt und eine
      grobe Versetzungs-Einschätzung. Für die Oberstufe lässt du dieses Modul am besten deaktiviert.
    </p>
    <label style="display:flex;align-items:center;gap:10px;font-size:13px;cursor:pointer">
      <input type="checkbox" ${CONFIG.mittelstufeModuleEnabled?"checked":""} onchange="toggleMittelstufeModul()"> Mittelstufen-Modus aktivieren
    </label>
  </div>`;

  /* ======================= Fehlstunden/Absenzen-Tracker ======================= */
  h+=`<div class="section-head">Fehlstunden/Absenzen-Tracker</div>
  <div class="form-section">
    <p style="font-size:12px;color:var(--text-muted);line-height:1.6;margin-bottom:12px">
      Optionales Zusatzmodul zum Erfassen von Fehlstunden (entschuldigt/unentschuldigt) pro Halbjahr — unabhängig von
      Noten und Abitur-/Mittelstufen-Modul.
    </p>
    <label style="display:flex;align-items:center;gap:10px;font-size:13px;cursor:pointer">
      <input type="checkbox" ${CONFIG.absenzenModuleEnabled?"checked":""} onchange="toggleAbsenzenModul()"> Fehlstunden/Absenzen-Tracker aktivieren
    </label>
  </div>`;

  /* ======================= Daten: Import/Export ======================= */
  h+=`<div class="section-head">Daten sichern & übertragen</div>
  <div class="form-section">
    <p style="font-size:12px;color:var(--text-muted);line-height:1.6;margin-bottom:12px">
      Alle Daten dieser App liegen nur lokal in diesem Browser. Exportiere regelmäßig eine Sicherungsdatei, um Daten
      auf ein anderes Gerät zu übertragen oder vor Datenverlust (z.B. beim Leeren des Browser-Caches) zu schützen.
    </p>
    <div class="form-footer" style="gap:10px">
      <button class="btn btn-primary" onclick="exportAllDataJSON()">⬇ Alle Daten exportieren (JSON)</button>
      <button class="btn" onclick="exportRawDataCSV()">⬇ Noten exportieren (CSV)</button>
      <button class="btn" onclick="exportKlausurenICS()">📅 Klausurtermine exportieren (ICS)</button>
      <button class="btn" onclick="triggerImportFile()">⬆ Daten importieren</button>
    </div>
    <p style="font-size:11px;color:var(--text-muted);margin-top:10px">Die JSON-Datei ist eine vollständige Sicherung und kann wieder importiert werden. Die CSV-Datei enthält nur die einzelnen Noteneinträge (eine Zeile pro Eintrag) zur Weiterverarbeitung in Excel/Numbers/Google Sheets. Die ICS-Datei enthält alle Klausurtermine mit gültigem Datum zum Import in Google-/Apple-/Outlook-Kalender. CSV und ICS lassen sich nicht wieder zurück importieren. Ein Import ersetzt alle aktuell in diesem Browser gespeicherten Daten (Fächer, Halbjahre, Noten, Einstellungen) durch den Inhalt der Datei.</p>
  </div>`;

  return h;
}

async function addSubject(){
  const name=document.getElementById("f-newsubj").value.trim();
  const slotsRaw=document.getElementById("f-newslots").value;
  const slots=slotsRaw===""?2:Math.max(0,Math.min(6,Number(slotsRaw)));
  if(!name){ showToast("Bitte einen Fachnamen eingeben."); return; }
  if(SUBJECTS.includes(name)){ showToast("Dieses Fach existiert bereits."); return; }
  SUBJECTS.push(name);
  KLAUSUR_SLOTS[name]=slots;
  await saveSubjects();
  render();
}
function requestRemoveSubject(subj){
  pendingDelete={kind:"subject",subj};
  render();
}
async function confirmRemoveSubject(subj){
  SUBJECTS=SUBJECTS.filter(s=>s!==subj);
  delete KLAUSUR_SLOTS[subj];
  if(abiSettings.lk.includes(subj)){ abiSettings.lk=abiSettings.lk.filter(s=>s!==subj); await saveAbiSettings(); }
  if(subjFilter===subj) subjFilter="alle";
  pendingDelete=null;
  await saveSubjects();
  render();
}
async function setSubjectSlots(subj,val){
  const slots=val===""?0:Math.max(0,Math.min(6,Number(val)));
  KLAUSUR_SLOTS[subj]=slots;
  await saveSubjects();
  render();
}

/* ======================= Perioden verwalten ======================= */
function nextPeriodId(){
  let maxN=0;
  CONFIG.periods.forEach(p=>{ const m=/^p(\d+)$/.exec(p.id); if(m) maxN=Math.max(maxN,Number(m[1])); });
  return "p"+(maxN+1);
}
async function addPeriod(){
  const input=document.getElementById("f-newperiod");
  const label=input.value.trim();
  if(!label){ showToast("Bitte einen Namen für das neue Halbjahr eingeben."); return; }
  const id=nextPeriodId();
  CONFIG.periods.push({id,label});
  applyConfig(CONFIG);
  await saveConfig();
  render();
}
function requestRemovePeriod(sem){ pendingDelete={kind:"period",sem}; render(); }
async function confirmRemovePeriod(sem){
  if(CONFIG.periods.length<=1){ showToast("Mindestens ein Halbjahr muss bestehen bleiben."); pendingDelete=null; render(); return; }
  CONFIG.periods=CONFIG.periods.filter(p=>p.id!==sem);
  applyConfig(CONFIG);
  await saveConfig();
  pendingDelete=null;
  render();
}
async function renamePeriod(sem,newLabel){
  const p=CONFIG.periods.find(p=>p.id===sem);
  const label=newLabel.trim();
  if(p&&label){ p.label=label; applyConfig(CONFIG); await saveConfig(); render(); }
}

/* ======================= Abitur/Fachabi-Modul (Einstellungen) ======================= */
async function toggleAbiturModule(){
  CONFIG.abiturModuleEnabled=!CONFIG.abiturModuleEnabled;
  if(activeTab==="abi"&&!CONFIG.abiturModuleEnabled) activeTab="overview";
  await saveConfig();
  render();
}
async function toggleMittelstufeModul(){
  CONFIG.mittelstufeModuleEnabled=!CONFIG.mittelstufeModuleEnabled;
  if(activeTab==="mittelstufe"&&!CONFIG.mittelstufeModuleEnabled) activeTab="overview";
  await saveConfig();
  render();
}
async function toggleAbsenzenModul(){
  CONFIG.absenzenModuleEnabled=!CONFIG.absenzenModuleEnabled;
  if(activeTab==="absenzen"&&!CONFIG.absenzenModuleEnabled) activeTab="overview";
  await saveConfig();
  render();
}
async function setLkDoubleFromIndex(val){
  CONFIG.abiturModule.lkDoubleFromIndex=Math.max(0,Math.min(SEMESTERS.length,Number(val)));
  await saveConfig();
  render();
}
async function setFachabiPeriodsCount(val){
  CONFIG.abiturModule.fachabiPeriodsCount=Math.max(1,Math.min(SEMESTERS.length,Number(val)));
  await saveConfig();
  render();
}

/* ======================= Daten: Import / Export ======================= */
function exportAllDataJSON(){
  const payload={
    app:"notenkompass",
    exportVersion:1,
    exportedAt:new Date().toISOString(),
    config:CONFIG,
    subjects:SUBJECTS,
    klausurSlots:KLAUSUR_SLOTS,
    data:data,
    abiSettings:abiSettings,
    theme:document.documentElement.getAttribute("data-theme")||"light"
  };
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url;
  a.download="notenkompass-export-"+new Date().toISOString().slice(0,10)+".json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("Export heruntergeladen.");
}
const CAT_LABELS={klausuren:"Klausur",muendlich:"Mündlich",sonstige:"Sonstige"};
function exportRawDataCSV(){
  const rows=[["Kategorie","Fach","Halbjahr","Art","Datum","Punkte","Notiz"]];
  ["klausuren","muendlich","sonstige"].forEach(cat=>{
    data[cat].forEach(e=>{
      rows.push([CAT_LABELS[cat], e.subj, SEM_LABELS[e.sem]||e.sem, e.type||"", e.date||"", isEmptyScore(e.score)?"":e.score, e.note||""]);
    });
  });
  if(rows.length===1){ showToast("Noch keine Noten eingetragen — es gibt nichts zu exportieren."); return; }
  downloadCSV("notenkompass-noten-"+new Date().toISOString().slice(0,10)+".csv", rows);
  showToast("CSV-Export heruntergeladen.");
}
/* ICS-Kalenderexport (RFC 5545) für Klausurtermine — ganztägige VEVENTs, ein Eintrag pro Klausur mit
 * gültigem, parsbarem Datum. Reiner Text-Export, kein Rückimport in die App vorgesehen. */
function exportKlausurenICS(){
  const events=data.klausuren
    .filter(e=>SUBJECTS.includes(e.subj))
    .map(e=>({...e,dateObj:parseGermanDate(e.date)}))
    .filter(e=>e.dateObj);
  if(!events.length){ showToast("Keine Klausuren mit gültigem Datum (TT.MM.JJJJ) zum Exportieren gefunden."); return; }
  const pad=n=>String(n).padStart(2,"0");
  const dtStamp=d=>`${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
  const now=new Date();
  const nowStamp=`${now.getUTCFullYear()}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const escapeICS=s=>String(s||"").replace(/\\/g,"\\\\").replace(/;/g,"\\;").replace(/,/g,"\\,").replace(/\n/g,"\\n");
  let ics="BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Notenkompass//Klausurtermine//DE\r\nCALSCALE:GREGORIAN\r\n";
  events.forEach((e,i)=>{
    const dStr=dtStamp(e.dateObj);
    ics+="BEGIN:VEVENT\r\n";
    ics+=`UID:notenkompass-${dStr}-${i}-${Math.random().toString(36).slice(2,8)}@notenkompass\r\n`;
    ics+=`DTSTAMP:${nowStamp}\r\n`;
    ics+=`DTSTART;VALUE=DATE:${dStr}\r\n`;
    ics+=`SUMMARY:${escapeICS((e.type||"Klausur")+" "+e.subj)}\r\n`;
    if(e.note) ics+=`DESCRIPTION:${escapeICS(e.note)}\r\n`;
    ics+="END:VEVENT\r\n";
  });
  ics+="END:VCALENDAR\r\n";
  const blob=new Blob([ics],{type:"text/calendar;charset=utf-8"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url; a.download="notenkompass-klausurtermine.ics";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`${events.length} Klausurtermin(e) als ICS exportiert.`);
}
function triggerImportFile(){
  const input=document.getElementById("import-file-input");
  if(input) input.click();
}
async function handleImportFile(input){
  const file=input.files&&input.files[0];
  if(!file) return;
  try{
    const text=await file.text();
    const payload=JSON.parse(text);
    if(!payload||!payload.config||!Array.isArray(payload.config.periods)||!payload.data){
      showToast("Ungültige Datei: erwartete Felder (config, data) fehlen.");
      input.value="";
      return;
    }
    applyConfig(Object.assign(defaultConfig(), payload.config, {abiturModule:Object.assign(defaultConfig().abiturModule, payload.config.abiturModule||{})}));
    SUBJECTS=Array.isArray(payload.subjects)?payload.subjects:[];
    KLAUSUR_SLOTS=payload.klausurSlots||{};
    data=payload.data||{klausuren:[],muendlich:[],sonstige:[],absenzen:[],zielnoten:{}};
    ensureDataDefaults();
    if(payload.abiSettings) abiSettings=payload.abiSettings;
    await saveConfig();
    await saveSubjects();
    await saveData();
    if(payload.abiSettings) await saveAbiSettings();
    if(payload.theme){ applyTheme(payload.theme); try{ await window.storage.set("notenkompass_theme", payload.theme); }catch(e){} }
    activeTab="overview";
    showToast("Import erfolgreich.");
    render();
  }catch(e){
    console.error(e);
    showToast("Import fehlgeschlagen: Datei konnte nicht gelesen werden.");
  }
  input.value="";
}

async function addEntry(cat){
  const g=id=>document.getElementById(id).value;
  const score=parseScoreInput(g("f-score"));
  data[cat].push({subj:g("f-subj"),type:g("f-type"),date:g("f-date").trim(),score,note:g("f-note").trim(),sem:activeSem});
  await saveData();
  render();
}

function toggleBulkMode(cat){
  bulkMode=!bulkMode;
  editState=null;
  render();
}
async function addBulkEntries(cat){
  const bulkSubjects=subjFilter==="alle"?SUBJECTS:[subjFilter];
  const type=document.getElementById("bulk-type").value;
  const date=document.getElementById("bulk-date").value.trim();
  let added=0;
  bulkSubjects.forEach((subj,i)=>{
    const scoreEl=document.getElementById(`bulk-score-${i}`);
    const noteEl=document.getElementById(`bulk-note-${i}`);
    if(!scoreEl) return;
    const raw=scoreEl.value;
    if(raw===""||raw===null) return;
    const score=parseScoreInput(raw);
    if(score===null) return;
    data[cat].push({subj,type,date,score,note:noteEl?noteEl.value.trim():"",sem:activeSem});
    added++;
  });
  if(added===0){ showToast(isMittelstufe()?"Bitte für mindestens ein Fach eine Note eintragen.":"Bitte für mindestens ein Fach Punkte eintragen."); return; }
  bulkMode=false;
  await saveData();
  render();
}

function requestDeleteEntry(cat,idx){
  pendingDelete={kind:"entry",cat,idx};
  render();
}
async function confirmDeleteEntry(cat,idx){
  data[cat].splice(idx,1);
  if(editState&&editState.cat===cat&&editState.idx===idx) editState=null;
  pendingDelete=null;
  await saveData();
  render();
}
function cancelPendingDelete(){
  pendingDelete=null;
  render();
}

function editEntry(cat,idx){
  editState={cat,idx};
  render();
}
function cancelEdit(){
  editState=null;
  render();
}
async function saveEditEntry(cat){
  const g=id=>document.getElementById(id).value;
  const score=parseScoreInput(g("f-score"));
  const idx=editState.idx;
  const original=data[cat][idx];
  data[cat][idx]={subj:g("f-subj"),type:g("f-type"),date:g("f-date").trim(),score,note:g("f-note").trim(),sem:original.sem};
  editState=null;
  await saveData();
  render();
}

/* ======================= Read-only-Zusammenfassung ======================= */
/* ======================= PDF-Export ======================= */
function openExportModal(){ exportModalOpen=true; renderExportModal(); }
function closeExportModal(){ exportModalOpen=false; renderExportModal(); }
function toggleExportSel(key){ exportSelection[key]=!exportSelection[key]; renderExportModal(); }
function setAllExportSel(val){
  Object.keys(exportSelection).forEach(k=>exportSelection[k]=val);
  renderExportModal();
}
function selectedExportSemesters(){ return SEMESTERS.filter(s=>exportSemesters[s]); }
function toggleExportSem(sem){ exportSemesters[sem]=!exportSemesters[sem]; renderExportModal(); }
function setAllExportSem(val){ SEMESTERS.forEach(s=>exportSemesters[s]=val); renderExportModal(); }
function renderExportModal(){
  const root=document.getElementById("export-modal-root");
  if(!exportModalOpen){ root.innerHTML=""; return; }
  const moduleOn=!!(CONFIG&&CONFIG.abiturModuleEnabled);
  const items=[
    {key:"bericht",label:"📝 Analysebericht (automatisch erstellter Fließtext zu Noten & Statistiken)"},
    {key:"noten",label:"Noten (Klausuren, Mündliche Noten, Sonstige Leistungen)"},
    {key:"verlauf",label:"Fächerübersicht & Verlauf"},
    ...(moduleOn?[{key:"abi",label:"Abi/Fachabi-Übersicht"}]:[]),
    {key:"statistik",label:"Statistik & Analyse"}
  ];
  if(!moduleOn) exportSelection.abi=false;
  const anySelected=Object.values(exportSelection).some(v=>v);
  const anySemester=selectedExportSemesters().length>0;
  root.innerHTML=`<div class="modal-overlay" onclick="if(event.target===this) closeExportModal()">
    <div class="modal-box">
      <h3>📄 Als PDF exportieren</h3>
      <p class="modal-sub">Wähle aus, was im PDF enthalten sein soll.</p>
      <div style="margin:4px 0 14px 0">
        <label style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em">Halbjahre</label>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          ${SEMESTERS.map(sem=>`<button type="button" class="btn ${exportSemesters[sem]?"btn-primary":""}" style="padding:6px 14px;font-size:12px" onclick="toggleExportSem('${sem}')">${SEM_LABELS[sem]}</button>`).join("")}
          <button type="button" class="btn" style="padding:6px 14px;font-size:12px" onclick="setAllExportSem(true)">Alle</button>
        </div>
      </div>
      ${items.map(it=>`
        <div class="modal-check-row">
          <input type="checkbox" id="exp-${it.key}" ${exportSelection[it.key]?"checked":""} onchange="toggleExportSel('${it.key}')">
          <label for="exp-${it.key}" style="cursor:pointer">${it.label}</label>
        </div>`).join("")}
      <div class="modal-actions">
        <button class="btn" style="padding:8px 14px;font-size:12px" onclick="setAllExportSel(true)">Alle auswählen</button>
        <button class="btn" style="padding:8px 14px;font-size:12px" onclick="setAllExportSel(false)">Keine</button>
      </div>
      <div class="modal-actions">
        <button class="btn" style="padding:9px 16px;font-size:13px" onclick="closeExportModal()">Abbrechen</button>
        <button class="btn" style="padding:9px 16px;font-size:13px" ${anySelected&&anySemester?"":"disabled"} onclick="doExportPrint(exportSelection, selectedExportSemesters())">Auswahl exportieren</button>
        <button class="btn btn-primary" style="padding:9px 16px;font-size:13px;font-weight:600" onclick="exportAllFull()">📦 Alles vollständig als PDF</button>
      </div>
    </div>
  </div>`;
}
function exportAllFull(){
  Object.keys(exportSelection).forEach(k=>exportSelection[k]=true);
  SEMESTERS.forEach(s=>exportSemesters[s]=true);
  doExportPrint(exportSelection, SEMESTERS);
}

function subjOverallAvgFiltered(subj,semesters){
  const vals=semesters.map(sem=>overallAvgSem(subj,sem)).filter(v=>v!==null);
  return vals.length?avg(vals):null;
}
function subjTrendLabelFiltered(subj,semesters){
  const points=[]; semesters.forEach((sem,idx)=>{ const v=overallAvgSem(subj,sem); if(v!==null) points.push({x:idx,y:v}); });
  if(points.length<2) return null;
  const reg=linReg(points);
  if(!reg) return null;
  if(reg.slope>=0.35) return "steigend";
  if(reg.slope<=-0.35) return "fallend";
  return "stabil";
}
function filteredEntriesForSubject(subj,semesters){
  return ["klausuren","muendlich","sonstige"].flatMap(c=>data[c].filter(e=>e.subj===subj&&semesters.includes(e.sem)&&!isEmptyScore(e.score)).map(e=>({...e,cat:c})));
}
function filteredAllEnteredScores(semesters){
  return ["klausuren","muendlich","sonstige"].flatMap(c=>data[c].filter(e=>semesters.includes(e.sem)&&SUBJECTS.includes(e.subj)&&!isEmptyScore(e.score)).map(e=>Number(e.score)));
}
function getSubjectStatsFiltered(subj,semesters){
  const scores=filteredEntriesForSubject(subj,semesters).map(e=>Number(e.score));
  return {mean:mean(scores),sd:stdev(scores),n:scores.length};
}
function zScoreOutliersFiltered(semesters,threshold=1.3){
  const out=[];
  SUBJECTS.forEach(subj=>{
    const entries=filteredEntriesForSubject(subj,semesters);
    const scores=entries.map(e=>Number(e.score));
    if(scores.length<3) return;
    const m=mean(scores),sd=stdev(scores);
    if(!sd) return;
    entries.forEach(e=>{
      const z=(Number(e.score)-m)/sd;
      if(Math.abs(z)>=threshold) out.push({...e,subj,z,fachMean:m});
    });
  });
  return out.sort((a,b)=>Math.abs(b.z)-Math.abs(a.z));
}
function subjectCorrelationsFiltered(semesters){
  const pairs=[];
  for(let i=0;i<SUBJECTS.length;i++){
    for(let j=i+1;j<SUBJECTS.length;j++){
      const a=SUBJECTS[i],b=SUBJECTS[j];
      const xs=[],ys=[];
      semesters.forEach(sem=>{
        const va=overallAvgSem(a,sem),vb=overallAvgSem(b,sem);
        if(va!==null&&vb!==null){ xs.push(va); ys.push(vb); }
      });
      const r=pearson(xs,ys);
      if(r!==null) pairs.push({a,b,r,n:xs.length});
    }
  }
  return pairs.sort((x,y)=>Math.abs(y.r)-Math.abs(x.r));
}

function exportBuildBerichtSection(semesters){
  semesters=(semesters&&semesters.length)?semesters:SEMESTERS;
  const isSingle=semesters.length===1;
  const isFull=semesters.length===SEMESTERS.length;
  const semListText=semesters.map(s=>SEM_LABELS[s]).join(", ");
  const semScopeText=isFull?"alle bisherigen Halbjahre":isSingle?`das Halbjahr ${SEM_LABELS[semesters[0]]}`:`die Halbjahre ${semListText}`;

  const totalEntries=filteredAllEnteredScores(semesters).length;
  let h=`<div class="export-section"><h2>Analysebericht${!isFull?` — ${semListText}`:""}</h2>`;
  if(totalEntries<4){
    h+=`<p style="font-size:12px">Für ${semScopeText} sind noch nicht genügend Noten eingetragen, um einen aussagekräftigen Bericht zu erstellen.</p></div>`;
    return h;
  }

  const subjData=SUBJECTS.map(s=>({subj:s,avgv:subjOverallAvgFiltered(s,semesters)})).filter(r=>r.avgv!==null);
  const sortedDesc=[...subjData].sort((a,b)=>b.avgv-a.avgv);
  const staerken=sortedDesc.slice(0,2);
  const schwaechen=[...sortedDesc].reverse().slice(0,2).filter(r=>!staerken.includes(r));
  const gesamtAvg=subjData.length?avg(subjData.map(r=>r.avgv)):null;

  h+=`<p style="font-size:12px;line-height:1.6"><strong>Zusammenfassung:</strong> ${isSingle?`Im Halbjahr <strong>${SEM_LABELS[semesters[0]]}</strong> liegt`:`Über ${semScopeText} liegt`} der Durchschnitt bei <strong>${fmt(gesamtAvg)} Punkten</strong>, basierend auf ${totalEntries} eingetragenen Noten in ${subjData.length} von ${SUBJECTS.length} Fächern.</p>`;

  if(staerken.length){
    h+=`<p style="font-size:12px;line-height:1.6"><strong>Stärken:</strong> Am stärksten stehst du ${isSingle?`in ${SEM_LABELS[semesters[0]]}`:"aktuell"} in ${staerken.map(r=>`<strong>${r.subj}</strong> (Ø ${fmt(r.avgv)})`).join(" und ")}.</p>`;
  }
  if(schwaechen.length){
    h+=`<p style="font-size:12px;line-height:1.6"><strong>Ausbaufähig:</strong> Den größten Nachholbedarf gibt es in ${schwaechen.map(r=>`<strong>${r.subj}</strong> (Ø ${fmt(r.avgv)})`).join(" und ")}. Hier könnte gezielte Vorbereitung auf künftige Klausuren den größten Hebel bringen.</p>`;
  }

  if(semesters.length>=2){
    const trendData=subjData.map(r=>({...r,trend:subjTrendLabelFiltered(r.subj,semesters)}));
    const steigend=trendData.filter(r=>r.trend==="steigend").map(r=>r.subj);
    const fallend=trendData.filter(r=>r.trend==="fallend").map(r=>r.subj);
    let trendText="";
    if(steigend.length) trendText+=`Ein positiver Trend zeigt sich in ${steigend.map(s=>`<strong>${s}</strong>`).join(", ")}. `;
    if(fallend.length) trendText+=`Ein rückläufiger Trend ist in ${fallend.map(s=>`<strong>${s}</strong>`).join(", ")} erkennbar. `;
    if(!steigend.length&&!fallend.length) trendText=`Die Leistungen sind über ${semListText} weitgehend stabil geblieben, ohne klaren Aufwärts- oder Abwärtstrend.`;
    h+=`<p style="font-size:12px;line-height:1.6"><strong>Entwicklung über die Halbjahre:</strong> ${trendText}</p>`;
  } else {
    h+=`<p style="font-size:12px;line-height:1.6"><strong>Entwicklung:</strong> Da nur ein Halbjahr (${SEM_LABELS[semesters[0]]}) ausgewählt ist, kann hier noch keine Entwicklung über die Zeit gezeigt werden. Wähle mehrere Halbjahre aus, um Trends zu sehen.</p>`;
  }

  const outliers=zScoreOutliersFiltered(semesters);
  if(outliers.length){
    const o=outliers[0];
    h+=`<p style="font-size:12px;line-height:1.6"><strong>Auffälligkeiten:</strong> Besonders auffällig ist die Note ${o.score} Punkte in <strong>${o.subj}</strong>${o.date?` (${o.date})`:""} — sie weicht deutlich (Z-Score ${o.z.toFixed(2)}) vom sonstigen Niveau in diesem Fach ab (Ø ${fmt(o.fachMean)}).</p>`;
  }

  const kvm=klausurVsMuendlichVergleichFiltered(semesters);
  if(kvm.length&&Math.abs(kvm[0].diff)>=1){
    const k=kvm[0];
    h+=`<p style="font-size:12px;line-height:1.6"><strong>Klausur vs. Mündlich:</strong> In <strong>${k.subj}</strong> gibt es den größten Unterschied zwischen schriftlich (Ø ${fmt(k.kAvg)}) und mündlich (Ø ${fmt(k.mAvg)}) — ${k.diff>0?"die Klausurleistung liegt deutlich über der mündlichen Mitarbeit":"die mündliche Mitarbeit liegt deutlich über der Klausurleistung"}.</p>`;
  }

  if(semesters.length>=3){
    const corrs=subjectCorrelationsFiltered(semesters).filter(c=>Math.abs(c.r)>=0.6);
    if(corrs.length){
      const c=corrs[0];
      h+=`<p style="font-size:12px;line-height:1.6"><strong>Zusammenhänge:</strong> Die Leistungen in <strong>${c.a}</strong> und <strong>${c.b}</strong> hängen erkennbar zusammen (r = ${c.r.toFixed(2)}) — ${c.r>0?"entwickeln sich beide Fächer meist in die gleiche Richtung":"entwickeln sich beide Fächer meist gegenläufig"}.</p>`;
    }
  }

  if(CONFIG&&CONFIG.abiturModuleEnabled){
    if(isFull){
      if(abiSettings.ziel==="abitur"||abiSettings.ziel==="beide"){
        const mc=runMonteCarlo(2000);
        const bestehtWahrscheinlich=mc.p10>=300;
        h+=`<p style="font-size:12px;line-height:1.6"><strong>Prognose (Abitur):</strong> Eine Simulation auf Basis der bisherigen Streuung ergibt für die Gesamtpunktzahl einen wahrscheinlichen Bereich von <strong>${mc.p10}–${mc.p90} Punkten</strong> (Median ${mc.p50}). ${bestehtWahrscheinlich?"Damit liegt die Schätzung auch im ungünstigeren Fall über der Bestehensgrenze von 300 Punkten.":"Im ungünstigeren Fall (unteres Perzentil) besteht noch Abstand zur Bestehensgrenze von 300 Punkten — hier lohnt sich zusätzlicher Fokus."}</p>`;
      }
      const mu=marginalUtility();
      if(mu.rows.length){
        const top=mu.rows[0];
        h+=`<p style="font-size:12px;line-height:1.6"><strong>Empfehlung:</strong> Ein zusätzlicher Punkt in <strong>${top.subj}</strong>${top.isLK?" (LK)":""} würde die Block-I-Punktzahl am stärksten verbessern (+${top.delta} Punkte) — hier lohnt sich Zusatzaufwand rechnerisch am meisten.</p>`;
      }
      const opt=optimizeEinbringung(optimizerMaxExclude);
      if(opt.gain){
        h+=`<p style="font-size:12px;line-height:1.6">Durch eine optimierte Auswahl der einzubringenden Halbjahresleistungen ließe sich die Block-I-Punktzahl rechnerisch um <strong>+${opt.gain} Punkte</strong> steigern.</p>`;
      }
    } else {
      h+=`<p style="font-size:12px;line-height:1.6;color:#555"><strong>Prognose & Empfehlung:</strong> Eine Abitur-Prognose (Monte-Carlo-Simulation, Grenznutzen-Analyse, Einbringungs-Optimierer) wird nur angezeigt, wenn der Bericht alle Halbjahre umfasst.</p>`;
    }
  }

  h+=`<p style="font-size:11px;color:#555">Dieser Bericht wird automatisch aus den eingetragenen Noten und den Statistik-Werkzeugen dieser App erstellt und ersetzt keine persönliche Beratung durch deine Schule.</p>`;
  h+="</div>";
  return h;
}
function exportBuildNotenSection(semesters){
  semesters=(semesters&&semesters.length)?semesters:SEMESTERS;
  const isFull=semesters.length===SEMESTERS.length;
  let h=`<div class="export-section"><h2>Noten${!isFull?` — ${semesters.map(s=>SEM_LABELS[s]).join(", ")}`:""}</h2>`;
  const cats=["klausuren","muendlich","sonstige"];
  let anyData=false;
  semesters.forEach(sem=>{
    cats.forEach(cat=>{
      const entries=entriesForSem(cat,sem).filter(e=>SUBJECTS.includes(e.subj));
      if(!entries.length) return;
      anyData=true;
      h+=`<h3 style="font-size:13px;margin:12px 0 6px 0">${SEM_LABELS[sem]} — ${TAB_TITLES[cat]}</h3>
      <table class="export-table">
        <thead><tr><th>Fach</th><th>Art</th><th>Datum</th><th>Punkte</th><th>Bemerkung</th></tr></thead>
        <tbody>
          ${entries.map(e=>`<tr><td>${e.subj}</td><td>${e.type||""}</td><td>${e.date||""}</td><td>${isEmptyScore(e.score)?"—":e.score}</td><td>${e.note||""}</td></tr>`).join("")}
        </tbody>
      </table>`;
    });
  });
  if(!anyData) h+=`<p style="font-size:12px;color:#555">Für die ausgewählten Halbjahre sind noch keine Noten eingetragen.</p>`;
  h+="</div>";
  return h;
}
function exportBuildVerlaufSection(semesters){
  semesters=(semesters&&semesters.length)?semesters:SEMESTERS;
  const isFull=semesters.length===SEMESTERS.length;
  const showChart=semesters.length>=2;
  let h=`<div class="export-section"><h2>Fächerübersicht & Verlauf${!isFull?` — ${semesters.map(s=>SEM_LABELS[s]).join(", ")}`:""}</h2>`;

  if(showChart){
    const gesamtVals=semesters.map(sem=>{
      const vals=SUBJECTS.map(s=>overallAvgSem(s,sem)).filter(v=>v!==null);
      return vals.length?avg(vals):null;
    });
    h+=`<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
      <div>${sparklineSVG(gesamtVals,140,40)}</div>
      <div style="font-size:11px;color:#555">Verlauf des Gesamtdurchschnitts über ${semesters.map(s=>SEM_LABELS[s]).join(" → ")}</div>
    </div>`;
  }

  h+=`<table class="export-table">
    <thead><tr><th>Fach</th>${semesters.map(sem=>`<th>${SEM_LABELS[sem]}</th>`).join("")}${showChart?"<th>Verlauf</th>":""}</tr></thead>
    <tbody>
      ${SUBJECTS.map(subj=>{
        const vals=semesters.map(sem=>overallAvgSem(subj,sem));
        return `<tr><td>${subj}</td>${vals.map(v=>`<td>${fmt(v)}</td>`).join("")}${showChart?`<td>${sparklineSVG(vals)}</td>`:""}</tr>`;
      }).join("")}
    </tbody>
  </table></div>`;
  return h;
}
function exportBuildAbiSection(semesters){
  let h=`<div class="export-section"><h2>Abi/Fachabi-Übersicht</h2>`;
  h+=`<p style="font-size:12px">Zielabschluss: <strong>${abiSettings.ziel==="abitur"?"Abitur":abiSettings.ziel==="fachabi"?"Fachhochschulreife":"Beide offen gehalten"}</strong></p>`;
  if(abiSettings.lk.length) h+=`<p style="font-size:12px">Leistungskurse: <strong>${abiSettings.lk.join(" & ")}</strong> (doppelte Gewichtung ab ${SEM_LABELS[SEMESTERS[CONFIG.abiturModule.lkDoubleFromIndex]]||"der konfigurierten Periode"})</p>`;
  if(abiSettings.ziel==="abitur"||abiSettings.ziel==="beide"){
    const bi=computeBlockI(overallAvgSem);
    const bii=computeBlockII();
    const gesamt=bi.blockI!==null?bi.blockI+(bii.blockII||0):null;
    const note=punkteToNote(gesamt);
    h+=`<table class="export-table">
      <thead><tr><th>Block I (max. 600)</th><th>Block II (max. 300)</th><th>Gesamt (max. 900)</th><th>Note (ca.)</th></tr></thead>
      <tbody><tr>
        <td>${bi.blockI!==null?bi.blockI:"—"}</td>
        <td>${bii.blockII!==null?bii.blockII:"—"} (${bii.count}/5 eingetragen)</td>
        <td>${gesamt!==null?gesamt:"—"}</td>
        <td>${note!==null?note.toFixed(1):"—"}</td>
      </tr></tbody>
    </table>
    <p style="font-size:11px;color:#555">Bestanden ab 300 Gesamtpunkten (mind. 200 in Block I, 100 in Block II). 1,0 ab 823 Punkten.</p>`;
  }
  if(abiSettings.ziel==="fachabi"||abiSettings.ziel==="beide"){
    const fVals=[]; SUBJECTS.forEach(s=>fachabiPeriods().forEach(sem=>{const v=overallAvgSem(s,sem); if(v!==null) fVals.push(v);}));
    const fAvg=fVals.length?avg(fVals):null;
    const fNote=fAvg!==null?Math.floor(((17-fAvg)/3)*10)/10:null;
    h+=`<table class="export-table">
      <thead><tr><th>Ø Punkte ${fachabiPeriods().map(s=>SEM_LABELS[s]).join("/")}</th><th>Note (ca.)</th></tr></thead>
      <tbody><tr><td>${fmt(fAvg)}</td><td>${fNote!==null?fNote.toFixed(1):"—"}</td></tr></tbody>
    </table>`;
  }
  h+=`<p style="font-size:11px;color:#555">Hochrechnung basiert nur auf den ${SUBJECTS.length} in dieser App erfassten Fächern — unverbindliche Orientierung.</p>`;
  if(semesters&&semesters.length&&semesters.length!==SEMESTERS.length){
    h+=`<p style="font-size:11px;color:#555">Hinweis: Diese Hochrechnung bezieht sich immer auf alle bisher eingetragenen Halbjahre, unabhängig von der oben getroffenen Halbjahres-Auswahl.</p>`;
  }
  h+="</div>";
  return h;
}
function exportBuildStatistikSection(semesters){
  semesters=(semesters&&semesters.length)?semesters:SEMESTERS;
  const isFull=semesters.length===SEMESTERS.length;
  const totalEntries=filteredAllEnteredScores(semesters).length;
  let h=`<div class="export-section"><h2>Statistik & Analyse${!isFull?` — ${semesters.map(s=>SEM_LABELS[s]).join(", ")}`:""}</h2>`;
  if(totalEntries<4){
    h+=`<p style="font-size:12px;color:#555">Noch nicht genug Daten für eine Analyse.</p></div>`;
    return h;
  }
  h+=`<h3 style="font-size:13px;margin:12px 0 6px 0">Mittelwert & Standardabweichung je Fach</h3>
  <table class="export-table">
    <thead><tr><th>Fach</th><th>Ø</th><th>Std.-Abw.</th><th>n</th></tr></thead>
    <tbody>
      ${SUBJECTS.map(s=>{const st=getSubjectStatsFiltered(s,semesters); return `<tr><td>${s}</td><td>${fmt(st.mean)}</td><td>${st.sd!==null?st.sd.toFixed(2):"—"}</td><td>${st.n}</td></tr>`;}).join("")}
    </tbody>
  </table>`;

  const outliers=zScoreOutliersFiltered(semesters);
  h+=`<h3 style="font-size:13px;margin:12px 0 6px 0">Z-Score-Ausreißer</h3>`;
  if(outliers.length){
    h+=`<table class="export-table"><thead><tr><th>Fach</th><th>Datum</th><th>Punkte</th><th>Z-Score</th></tr></thead><tbody>
      ${outliers.slice(0,10).map(o=>`<tr><td>${o.subj}</td><td>${o.date||""}</td><td>${o.score}</td><td>${o.z.toFixed(2)}</td></tr>`).join("")}
    </tbody></table>`;
  } else h+=`<p style="font-size:12px;color:#555">Keine auffälligen Ausreißer gefunden.</p>`;

  const kvm=klausurVsMuendlichVergleichFiltered(semesters);
  h+=`<h3 style="font-size:13px;margin:12px 0 6px 0">Klausur vs. Mündlich</h3>`;
  if(kvm.length){
    h+=`<table class="export-table"><thead><tr><th>Fach</th><th>Ø Klausuren</th><th>Ø Mündlich</th><th>Differenz</th></tr></thead><tbody>
      ${kvm.map(r=>`<tr><td>${r.subj}</td><td>${fmt(r.kAvg)}</td><td>${fmt(r.mAvg)}</td><td>${r.diff>0?"+":""}${r.diff.toFixed(1)}</td></tr>`).join("")}
    </tbody></table>
    <p style="font-size:11px;color:#555">Positive Differenz = Klausuren besser als mündliche Mitarbeit, negative Differenz = umgekehrt.</p>`;
  } else h+=`<p style="font-size:12px;color:#555">Noch nicht genug Daten, um Klausuren und mündliche Noten je Fach zu vergleichen.</p>`;

  h+=`<h3 style="font-size:13px;margin:12px 0 6px 0">Korrelationsanalyse (stärkste Zusammenhänge)</h3>`;
  if(semesters.length>=3){
    const corrs=subjectCorrelationsFiltered(semesters);
    if(corrs.length){
      h+=`<table class="export-table"><thead><tr><th>Fach A</th><th>Fach B</th><th>r</th></tr></thead><tbody>
        ${corrs.slice(0,8).map(c=>`<tr><td>${c.a}</td><td>${c.b}</td><td>${c.r.toFixed(2)}</td></tr>`).join("")}
      </tbody></table>`;
    } else h+=`<p style="font-size:12px;color:#555">Noch nicht genug Daten für eine Korrelationsanalyse.</p>`;
  } else {
    h+=`<p style="font-size:12px;color:#555">Für eine Korrelationsanalyse werden mindestens drei ausgewählte Halbjahre benötigt.</p>`;
  }

  if(CONFIG&&CONFIG.abiturModuleEnabled){
    if(isFull){
      const mu=marginalUtility();
      h+=`<h3 style="font-size:13px;margin:12px 0 6px 0">Grenznutzen-Analyse (+1 Punkt je Fach → Block-I-Zuwachs)</h3>`;
      if(mu.rows.length){
        h+=`<table class="export-table"><thead><tr><th>Fach</th><th>Zuwachs Block I</th></tr></thead><tbody>
          ${mu.rows.map(r=>`<tr><td>${r.subj}${r.isLK?" (LK)":""}</td><td>+${r.delta}</td></tr>`).join("")}
        </tbody></table>`;
      } else h+=`<p style="font-size:12px;color:#555">Noch nicht genug Daten.</p>`;

      const mc=runMonteCarlo(2000);
      h+=`<h3 style="font-size:13px;margin:12px 0 6px 0">Monte-Carlo-Simulation der Gesamtpunktzahl (2000 Durchläufe)</h3>
      <table class="export-table"><thead><tr><th>P10</th><th>P25</th><th>Median</th><th>P75</th><th>P90</th><th>Ø</th></tr></thead>
      <tbody><tr><td>${mc.p10}</td><td>${mc.p25}</td><td>${mc.p50}</td><td>${mc.p75}</td><td>${mc.p90}</td><td>${mc.meanVal.toFixed(0)}</td></tr></tbody></table>
      <p style="font-size:11px;color:#555">Fehlende Noten werden anhand der bisherigen Streuung je Fach stochastisch geschätzt — Momentaufnahme, kein Versprechen.</p>`;

      const bs=runBootstrap(2000);
      h+=`<h3 style="font-size:13px;margin:12px 0 6px 0">Bootstrap-Konfidenzintervall (verteilungsfrei, 2000 Durchläufe)</h3>
      <table class="export-table"><thead><tr><th>P10</th><th>P25</th><th>Median</th><th>P75</th><th>P90</th><th>Ø</th></tr></thead>
      <tbody><tr><td>${bs.p10}</td><td>${bs.p25}</td><td>${bs.p50}</td><td>${bs.p75}</td><td>${bs.p90}</td><td>${bs.meanVal.toFixed(0)}</td></tr></tbody></table>
      <p style="font-size:11px;color:#555">Zieht fehlende Werte aus deinen eigenen bisherigen Noten statt aus einer angenommenen Normalverteilung — robuste Gegenprobe zur Monte-Carlo-Simulation.</p>`;

      const opt=optimizeEinbringung(optimizerMaxExclude);
      h+=`<h3 style="font-size:13px;margin:12px 0 6px 0">Einbringungs-Optimierer</h3>
      <table class="export-table"><thead><tr><th>Block I ohne Ausschluss</th><th>Block I mit optimalem Ausschluss</th><th>Gewinn</th></tr></thead>
      <tbody><tr><td>${opt.withoutExclusion!==null?opt.withoutExclusion:"—"}</td><td>${opt.withExclusion!==null?opt.withExclusion:"—"}</td><td>${opt.gain!==null?"+"+opt.gain:"—"}</td></tr></tbody></table>`;
    } else {
      h+=`<p style="font-size:12px;color:#555">Grenznutzen-Analyse, Monte-Carlo-Simulation und Einbringungs-Optimierer beziehen sich immer auf alle Halbjahre und werden nur angezeigt, wenn alle Halbjahre ausgewählt sind.</p>`;
    }
  }

  h+="</div>";
  return h;
}
function buildExportHTML(selection,semesters){
  semesters=(semesters&&semesters.length)?semesters:selectedExportSemesters();
  const now=new Date();
  const dateStr=now.toLocaleDateString("de-DE")+" "+now.toLocaleTimeString("de-DE",{hour:"2-digit",minute:"2-digit"});
  const semLabel=semesters.length===SEMESTERS.length?"alle Halbjahre ("+semesters.map(s=>SEM_LABELS[s]).join(", ")+")":semesters.map(s=>SEM_LABELS[s]).join(", ");
  let h=`<div class="export-page">
    <h1>Notenkompass — Export</h1>
    <div class="export-meta">Erstellt am ${dateStr} · Enthaltene Halbjahre: ${semLabel}</div>`;
  if(selection.bericht) h+=exportBuildBerichtSection(semesters);
  if(selection.noten) h+=exportBuildNotenSection(semesters);
  if(selection.verlauf) h+=exportBuildVerlaufSection(semesters);
  if(selection.abi&&CONFIG&&CONFIG.abiturModuleEnabled) h+=exportBuildAbiSection(semesters);
  if(selection.statistik) h+=exportBuildStatistikSection(semesters);
  h+="</div>";
  return h;
}
function doExportPrint(selection,semesters){
  semesters=(semesters&&semesters.length)?semesters:selectedExportSemesters();
  if(!Object.values(selection).some(v=>v)||!semesters.length) return;
  closeExportModal();
  const root=document.getElementById("print-export-root");
  root.innerHTML=buildExportHTML(selection,semesters);
  document.body.classList.add("exporting-pdf");
  setTimeout(()=>{
    window.print();
    setTimeout(()=>{
      document.body.classList.remove("exporting-pdf");
      root.innerHTML="";
    },300);
  },100);
}

/* ======================= Einrichtungsassistent (Ersteinrichtung / erneut durchlaufen) ======================= */
function runSetupWizard(isReentry){
  isReentry=!!isReentry && !!(CONFIG&&SUBJECTS&&SUBJECTS.length);
  const prevPeriodLabels=isReentry?SEMESTERS.map(sem=>SEM_LABELS[sem]):["Halbjahr 1","Halbjahr 2"];
  const prevSubjects=isReentry?SUBJECTS:["Mathematik","Deutsch","Englisch"];
  const prevAbiturOn=isReentry?!!CONFIG.abiturModuleEnabled:false;
  const root=document.getElementById("setup-wizard-root");
  root.style.display="flex";
  root.innerHTML=`<div class="setup-overlay">
    <div class="setup-box">
      <h2>${isReentry?"Einrichtung anpassen 🔄":"Willkommen bei Notenkompass 👋"}</h2>
      <p class="setup-sub">${isReentry?"Ändere Halbjahre und Fächer in einem Rutsch. Bereits eingetragene Noten gehen dabei nicht verloren — Fächer/Halbjahre, die du hier entfernst, bleiben in den Rohdaten erhalten und lassen sich später wieder mit demselben Namen sichtbar machen.":"Kurz einrichten, dann kann's losgehen. Fächer und Halbjahre lassen sich jederzeit in den Einstellungen anpassen."}</p>

      <div class="fg">
        <label>Wie viele Halbjahre/Perioden möchtest du erfassen?</label>
        <input type="number" id="setup-period-count" min="1" max="12" value="${prevPeriodLabels.length}" onchange="renderSetupPeriodNames()" oninput="renderSetupPeriodNames()">
      </div>
      <div id="setup-period-names"></div>

      <div class="fg" style="margin-top:18px">
        <label>Deine Fächer (ein Fach pro Zeile)</label>
        <textarea id="setup-subjects" rows="6" placeholder="Mathematik
Deutsch
Englisch
…">${prevSubjects.join("\n")}</textarea>
      </div>

      <label style="display:flex;align-items:center;gap:10px;font-size:13px;cursor:pointer;margin-top:18px">
        <input type="checkbox" id="setup-abitur-module" ${prevAbiturOn?"checked":""}> Abitur/Fachabi-Modul aktivieren — optional, berechnet Block I/II nach dem bundesweiten Gesamtqualifikations-Modell (Bundesland wählst du danach in den Einstellungen)
      </label>

      <div id="setup-error"></div>
      <div class="form-footer" style="margin-top:16px">
        ${isReentry?`<button class="btn" onclick="cancelSetupWizard()">Abbrechen</button>`:""}
        <button class="btn btn-primary" onclick="finishSetupWizard(${isReentry})">${isReentry?"Übernehmen":"Los geht's 🚀"}</button>
      </div>
    </div>
  </div>`;
  renderSetupPeriodNames(prevPeriodLabels);
}
function cancelSetupWizard(){
  const root=document.getElementById("setup-wizard-root");
  root.style.display="none";
  root.innerHTML="";
}
function renderSetupPeriodNames(prefill){
  const countInput=document.getElementById("setup-period-count");
  const count=Math.max(1,Math.min(12,Number(countInput.value)||1));
  const container=document.getElementById("setup-period-names");
  const existing=prefill||[...container.querySelectorAll(".setup-period-name-input")].map(i=>i.value);
  let html="";
  for(let i=0;i<count;i++){
    const val=(existing[i]!==undefined&&existing[i]!=="")?existing[i]:"Halbjahr "+(i+1);
    html+=`<div class="fg" style="margin-top:8px"><label>Name Halbjahr ${i+1}</label><input type="text" class="setup-period-name-input" value="${val}"></div>`;
  }
  container.innerHTML=html;
}
async function finishSetupWizard(isReentry){
  const errEl=document.getElementById("setup-error");
  errEl.textContent="";
  const periodNames=[...document.querySelectorAll(".setup-period-name-input")].map(i=>i.value.trim()).filter(Boolean);
  const subjectsRaw=document.getElementById("setup-subjects").value;
  const subjects=[...new Set(subjectsRaw.split("\n").map(s=>s.trim()).filter(Boolean))];
  const abiturOn=document.getElementById("setup-abitur-module").checked;
  if(!periodNames.length){ errEl.textContent="Bitte mindestens ein Halbjahr benennen."; return; }
  if(!subjects.length){ errEl.textContent="Bitte mindestens ein Fach eingeben."; return; }

  const prevSlots=isReentry?KLAUSUR_SLOTS:{};
  const prevLk=isReentry&&abiSettings?abiSettings.lk:[];

  const cfg=isReentry?Object.assign({},CONFIG):defaultConfig();
  cfg.periods=periodNames.map((label,i)=>({id:"p"+(i+1),label}));
  cfg.abiturModuleEnabled=abiturOn;
  applyConfig(cfg);
  SUBJECTS=subjects;
  const newSlots={};
  subjects.forEach(s=>newSlots[s]=prevSlots[s]!==undefined?prevSlots[s]:2);
  KLAUSUR_SLOTS=newSlots;
  if(isReentry&&abiSettings) abiSettings.lk=prevLk.filter(s=>subjects.includes(s));
  await saveConfig();
  await saveSubjects();
  if(isReentry&&abiSettings) await saveAbiSettings();

  const root=document.getElementById("setup-wizard-root");
  root.style.display="none";
  root.innerHTML="";
  showToast(isReentry?"Einrichtung aktualisiert.":"");
  render();
}

async function init(){
  document.getElementById("content").innerHTML='<div style="padding:60px;text-align:center;color:var(--text-muted)">Lade deine Daten…</div>';
  await loadTheme();
  await loadProfiles();
  const hasConfig=await loadConfig();
  await loadSubjects();
  await Promise.all([loadData(), loadAbiSettings()]);
  if(!hasConfig || !SUBJECTS.length){
    runSetupWizard();
    return;
  }
  if(CONFIG&&CONFIG.abiturModule&&CONFIG.abiturModule.numPruefungsfaecher) resizeBlock2(CONFIG.abiturModule.numPruefungsfaecher);
  render();
}
init();
