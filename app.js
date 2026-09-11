const LEGACY_KEY = "control_movimientos_v1";
const LOCAL_PREFIX = "control_movimientos_v8_";
const LAST_USER_KEY = "control_movimientos_v8_last_user";
const MIGRATION_KEY = "control_movimientos_v8_migrated";

let movimientos = [];
let editId = null;
let deferredPrompt = null;
let currentUser = null;
let sb = null;
let syncBusy = false;
let syncTimer = null;

const AUTH_VALIDATION_PREFIX = "control_movimientos_v11_auth_ok_";
const BLOCKED_USER_PREFIX = "control_movimientos_v11_blocked_";
const OFFLINE_GRACE_MS = 24*60*60*1000;
let authCheckTimer = null;
let authCheckBusy = false;

let personasAbiertas = new Set();
let playerActual = null;
let playerScope = "month";


let mesSeleccionado = new Date();
mesSeleccionado = new Date(mesSeleccionado.getFullYear(), mesSeleccionado.getMonth(), 1);

const $ = (id) => document.getElementById(id);
const numFmt = new Intl.NumberFormat("es-PY", { maximumFractionDigits: 0 });
const fmtGs = (n) => `Gs. ${numFmt.format(Number(n || 0))}`;

function configLista(){
  const c = window.APP_CONFIG || {};
  return c.SUPABASE_URL && c.SUPABASE_PUBLISHABLE_KEY &&
    !c.SUPABASE_URL.includes("PEGA_AQUI") && !c.SUPABASE_PUBLISHABLE_KEY.includes("PEGA_AQUI");
}

function crearCliente(){
  if(!configLista() || !window.supabase?.createClient) return null;
  return window.supabase.createClient(
    window.APP_CONFIG.SUPABASE_URL,
    window.APP_CONFIG.SUPABASE_PUBLISHABLE_KEY,
    { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
  );
}

function localKey(){ return currentUser ? `${LOCAL_PREFIX}${currentUser.id}` : null; }

function esDelMes(fecha, mes=mesSeleccionado){
  if(!fecha) return false;
  const p = String(fecha).slice(0,10).split("-");
  if(p.length !== 3) return false;
  return Number(p[0]) === mes.getFullYear() && Number(p[1]) === mes.getMonth()+1;
}
function nombreMes(d){ return new Intl.DateTimeFormat("es-PY",{month:"long",year:"numeric"}).format(d); }
function activos(){ return movimientos.filter(m => !m.deleted); }
function movimientosDelMes(){ return activos().filter(m => esDelMes(m.fecha)); }

function claveNombre(s){ return normalizarNombre(s).toLocaleLowerCase("es"); }
function resumenArr(arr){
  return arr.reduce((r,m)=>{
    r.ingreso+=num(m.ingreso); r.egreso+=num(m.egreso); r.movimientos++;
    if(num(m.ingreso)>0) r.cargas++;
    if(num(m.egreso)>0) r.retiros++;
    return r;
  },{ingreso:0,egreso:0,movimientos:0,cargas:0,retiros:0});
}
function inicioSemanaISO(){
  const d=new Date(); d.setHours(0,0,0,0);
  const day=(d.getDay()+6)%7;
  d.setDate(d.getDate()-day);
  const off=d.getTimezoneOffset();
  return new Date(d.getTime()-off*60000).toISOString().slice(0,10);
}
function arrHoy(){ const h=hoyISO(); return activos().filter(m=>String(m.fecha).slice(0,10)===h); }
function arrSemana(){ const ini=inicioSemanaISO(), fin=hoyISO(); return activos().filter(m=>m.fecha>=ini && m.fecha<=fin); }
function movimientosPersona(nombre,scope="month"){
  const key=claveNombre(nombre);
  const base=scope==="all"?activos():movimientosDelMes();
  return base.filter(m=>claveNombre(m.nombre)===key).sort((a,b)=>(b.fecha||"").localeCompare(a.fecha||"")||(b.creado||0)-(a.creado||0));
}
function nombresUnicos(){
  const map=new Map();
  for(const m of activos().sort((a,b)=>(b.creado||0)-(a.creado||0))){
    const k=claveNombre(m.nombre);
    if(k && !map.has(k)) map.set(k,m.nombre);
  }
  return [...map.values()];
}
function fechaPY(iso){
  const p=String(iso||"").slice(0,10).split("-");
  return p.length===3?`${p[2]}/${p[1]}/${p[0]}`:String(iso||"");
}
function elegirNombre(nombre){
  $("nombre").value=nombre;
  actualizarUltimoMovimiento();
  $("ingreso").focus();
}
function renderSugerenciasNombres(){
  const nombres=nombresUnicos();
  $("nombresGuardados").innerHTML=nombres.map(n=>`<option value="${escapeHtml(n)}"></option>`).join("");
  const recientes=nombres.slice(0,6);
  $("recentNames").innerHTML=recientes.map(n=>`<button type="button" class="name-chip" data-name="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join("");
  $("recentNames").querySelectorAll(".name-chip").forEach(btn=>btn.addEventListener("click",()=>elegirNombre(btn.dataset.name)));
}
function actualizarUltimoMovimiento(){
  const nombre=normalizarNombre($("nombre").value);
  const el=$("lastPlayerMove");
  if(!nombre){ el.textContent=""; return; }
  const arr=movimientosPersona(nombre,"all");
  if(!arr.length){ el.textContent="Jugador nuevo."; return; }
  const m=arr[0], tipo=num(m.ingreso)>0?"Carga":"Retiro", valor=num(m.ingreso)>0?m.ingreso:m.egreso;
  el.innerHTML=`Último movimiento: <b>${tipo} ${fmtGs(valor)}</b> · ${fechaPY(m.fecha)}`;
}
function posibleDuplicado(nombre,ingreso,egreso){
  const now=Date.now(), ventana=10*60*1000, key=claveNombre(nombre);
  return activos().find(m =>
    claveNombre(m.nombre)===key &&
    num(m.ingreso)===ingreso &&
    num(m.egreso)===egreso &&
    Math.abs(now-Number(m.creado||0))<=ventana
  );
}
function usarNombreDesdeResumen(encoded){
  const nombre=decodeURIComponent(encoded);
  elegirNombre(nombre);
  document.querySelector('[data-tab="historial"]')?.click();
  window.scrollTo({top:0,behavior:"smooth"});
}
function togglePersona(encoded){
  const nombre=decodeURIComponent(encoded), key=claveNombre(nombre);
  if(personasAbiertas.has(key)) personasAbiertas.delete(key); else personasAbiertas.add(key);
  renderPersonas();
}
function abrirJugador(encoded){
  const nombre=decodeURIComponent(encoded);
  playerActual=nombre; playerScope="month";
  renderJugadorDialog();
  $("playerDialog").showModal();
}
function renderJugadorDialog(){
  if(!playerActual) return;
  $("playerDialogTitle").textContent=playerActual;
  const arr=movimientosPersona(playerActual,playerScope), r=resumenArr(arr);
  $("playerMonthBtn").className="btn-secondary btn-small"+(playerScope==="month"?" active":"");
  $("playerAllBtn").className="btn-secondary btn-small"+(playerScope==="all"?" active":"");
  $("playerStats").innerHTML=`
    <div class="mini-stat"><small>Cargas</small><b class="tag-in">${fmtGs(r.ingreso)}</b></div>
    <div class="mini-stat"><small>Retiros</small><b class="tag-out">${fmtGs(r.egreso)}</b></div>
    <div class="mini-stat"><small>Resultado</small><b>${fmtGs(r.ingreso-r.egreso)}</b></div>
    <div class="mini-stat"><small>N.º de cargas</small><b>${r.cargas}</b></div>
    <div class="mini-stat"><small>N.º de retiros</small><b>${r.retiros}</b></div>
    <div class="mini-stat"><small>Movimientos</small><b>${r.movimientos}</b></div>`;
  $("playerHistory").innerHTML=arr.length?arr.map(m=>`
    <div class="player-history-row">
      <span>${fechaPY(m.fecha)}</span>
      <span class="tag-in">${m.ingreso?fmtGs(m.ingreso):"—"}</span>
      <span class="tag-out">${m.egreso?fmtGs(m.egreso):"—"}</span>
    </div>`).join(""):`<div class="empty">Sin movimientos en este período.</div>`;
}


function hoyISO(){
  const d = new Date(); const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off*60000).toISOString().slice(0,10);
}
function ahoraISO(){ return new Date().toISOString(); }
function esUuid(v){ return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v||"")); }
function nuevoId(){
  if(globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,c=>{ const r=Math.random()*16|0, v=c==="x"?r:(r&0x3|0x8); return v.toString(16); });
}

function cargarLocal(){
  try{
    const raw = localStorage.getItem(localKey());
    const data = raw ? JSON.parse(raw) : [];
    movimientos = Array.isArray(data) ? data : [];
  }catch{ movimientos = []; }
}
function guardarLocal(sinRender=false){
  if(localKey()) localStorage.setItem(localKey(), JSON.stringify(movimientos));
  actualizarEstadoSync();
  if(!sinRender) render();
}
function num(v){
  const limpio = String(v ?? "").replace(/\./g,"").replace(/\s/g,"").replace(/[^0-9-]/g,"");
  const n = Number(limpio || 0); return Number.isFinite(n) ? n : 0;
}
function formatearCampoGs(input){
  let digitos = String(input.value || "").replace(/[^0-9]/g, "");
  digitos = digitos.replace(/^0+(?=\d)/, "");
  if(!digitos){ input.value = ""; return; }
  input.value = digitos.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
function activarFormatoGs(id){ const input=$(id); if(input) input.addEventListener("input",()=>formatearCampoGs(input)); }
function normalizarNombre(s){ return (s || "").trim().replace(/\s+/g," "); }
function normalizarMovimiento(m, pending=false){
  return {
    id: esUuid(m.id) ? m.id : nuevoId(),
    user_id: currentUser?.id || m.user_id || null,
    fecha: m.fecha || hoyISO(),
    nombre: normalizarNombre(m.nombre),
    ingreso: num(m.ingreso),
    egreso: num(m.egreso),
    observacion: String(m.observacion || ""),
    creado: Number(m.creado || Date.now()),
    updated_at: m.updated_at || ahoraISO(),
    deleted: Boolean(m.deleted),
    sync_status: pending ? "pending" : (m.sync_status || "synced")
  };
}

function agregarMovimiento(){
  const nombre=normalizarNombre($("nombre").value), ingreso=num($("ingreso").value), egreso=num($("egreso").value);
  if(!nombre){ alert("Ingrese un nombre."); $("nombre").focus(); return; }
  if(ingreso<=0 && egreso<=0){ alert("Ingrese un importe en Carga o Retiro."); return; }

  const dup=posibleDuplicado(nombre,ingreso,egreso);
  if(dup){
    const tipo=ingreso>0?"carga":"retiro", valor=ingreso>0?ingreso:egreso;
    const ok=confirm(`Hay un movimiento muy parecido registrado hace poco:\n\n${nombre} · ${tipo} ${fmtGs(valor)} · ${fechaPY(dup.fecha)}\n\n¿Guardar igualmente?`);
    if(!ok) return;
  }

  movimientos.push(normalizarMovimiento({
    id:nuevoId(), fecha:$("fecha").value||hoyISO(), nombre, ingreso, egreso,
    observacion:$("obs").value.trim(), creado:Date.now(), updated_at:ahoraISO(), deleted:false
  }, true));

  guardarLocal(true);
  render();
  actualizarEstadoSync();

  $("nombre").value=""; $("ingreso").value=""; $("egreso").value=""; $("obs").value=""; $("fecha").value=hoyISO();
  actualizarUltimoMovimiento();
  $("nombre").focus();
  programarSync();
}
function eliminar(id){
  if(!confirm("¿Eliminar este movimiento?")) return;
  const m=movimientos.find(x=>x.id===id); if(!m) return;
  m.deleted=true; m.updated_at=ahoraISO(); m.sync_status="pending";
  guardarLocal(); programarSync();
}
function editar(id){
  const m=movimientos.find(x=>x.id===id && !x.deleted); if(!m) return;
  editId=id; $("eFecha").value=m.fecha; $("eNombre").value=m.nombre;
  $("eIngreso").value=m.ingreso?numFmt.format(m.ingreso):""; $("eEgreso").value=m.egreso?numFmt.format(m.egreso):"";
  $("eObs").value=m.observacion||""; $("editDialog").showModal();
}
function guardarEdicion(){
  const m=movimientos.find(x=>x.id===editId); if(!m) return;
  const nombre=normalizarNombre($("eNombre").value), ingreso=num($("eIngreso").value), egreso=num($("eEgreso").value);
  if(!nombre){ alert("Ingrese un nombre."); return; }
  if(ingreso<=0 && egreso<=0){ alert("Ingrese un importe en Carga o Retiro."); return; }
  Object.assign(m,{fecha:$("eFecha").value||hoyISO(),nombre,ingreso,egreso,observacion:$("eObs").value.trim(),updated_at:ahoraISO(),sync_status:"pending"});
  $("editDialog").close(); guardarLocal(); programarSync();
}

function resumenGeneral(){
  const delMes=movimientosDelMes(), r=resumenArr(delMes);
  $("monthLabel").textContent=nombreMes(mesSeleccionado);
  $("totalIngresos").textContent=fmtGs(r.ingreso);
  $("totalEgresos").textContent=fmtGs(r.egreso);
  $("saldoGeneral").textContent=fmtGs(r.ingreso-r.egreso);
  $("contador").textContent=`${r.movimientos} movimiento${r.movimientos===1?"":"s"} en este mes`;

  const hoy=resumenArr(arrHoy());
  $("todayCount").textContent=hoy.movimientos;
  $("todayIn").textContent=fmtGs(hoy.ingreso);
  $("todayOut").textContent=fmtGs(hoy.egreso);
  $("todayNet").textContent=fmtGs(hoy.ingreso-hoy.egreso);
}
function renderHistorial(){
  const q=$("buscar").value.toLowerCase().trim(), tipo=$("filtroTipo").value;
  let arr=movimientosDelMes().sort((a,b)=>(b.fecha||"").localeCompare(a.fecha||"")||(b.creado||0)-(a.creado||0));
  arr=arr.filter(m=>{ const texto=`${m.nombre} ${m.observacion||""}`.toLowerCase(); return (!q||texto.includes(q)) && (tipo==="todos"||(tipo==="ingreso"?num(m.ingreso)>0:num(m.egreso)>0)); });
  $("tbody").innerHTML=arr.map(m=>`<tr><td>${fechaPY(m.fecha)}</td><td><strong>${escapeHtml(m.nombre)}</strong></td><td class="money tag-in">${m.ingreso?fmtGs(m.ingreso):""}</td><td class="money tag-out">${m.egreso?fmtGs(m.egreso):""}</td><td class="money"><strong>${fmtGs(num(m.ingreso)-num(m.egreso))}</strong></td><td>${escapeHtml(m.observacion||"")}</td><td><div class="row-actions"><button class="btn-secondary" onclick="editar('${m.id}')">Editar</button><button class="btn-danger" onclick="eliminar('${m.id}')">Eliminar</button></div></td></tr>`).join("");
  $("emptyHist").style.display=arr.length?"none":"block";
}
function renderPersonas(){
  const map=new Map();
  for(const m of movimientosDelMes()){
    const key=claveNombre(m.nombre);
    if(!map.has(key)) map.set(key,{nombre:m.nombre,ingreso:0,egreso:0,movimientos:0,items:[]});
    const x=map.get(key); x.ingreso+=num(m.ingreso); x.egreso+=num(m.egreso); x.movimientos++; x.items.push(m);
  }
  const q=$("buscarPersona").value.toLowerCase().trim();
  const arr=[...map.values()].filter(x=>!q||x.nombre.toLowerCase().includes(q)).sort((a,b)=>a.nombre.localeCompare(b.nombre,"es"));
  $("resumenPersonas").innerHTML=arr.map(x=>{
    const enc=encodeURIComponent(x.nombre), open=personasAbiertas.has(claveNombre(x.nombre));
    const items=x.items.sort((a,b)=>(b.fecha||"").localeCompare(a.fecha||"")||(b.creado||0)-(a.creado||0));
    return `<div class="person ${open?"open":""}">
      <div class="person-head" onclick="togglePersona('${enc}')">
        <div class="person-title-row"><strong>${escapeHtml(x.nombre)}</strong><span class="person-expand">⌄</span></div>
        <small>Cargas: <b class="tag-in">${fmtGs(x.ingreso)}</b></small>
        <small>Retiros: <b class="tag-out">${fmtGs(x.egreso)}</b></small>
        <small>Resultado: <b>${fmtGs(x.ingreso-x.egreso)}</b> · ${x.movimientos} mov.</small>
      </div>
      <div class="person-details">
        ${items.map(m=>`<div class="person-detail-row"><span>${fechaPY(m.fecha)}</span><span class="tag-in">${m.ingreso?fmtGs(m.ingreso):"—"}</span><span class="tag-out">${m.egreso?fmtGs(m.egreso):"—"}</span></div>`).join("")}
        <div class="person-actions">
          <button class="btn-primary" onclick="event.stopPropagation();usarNombreDesdeResumen('${enc}')">Nueva carga / retiro</button>
          <button class="btn-secondary" onclick="event.stopPropagation();abrirJugador('${enc}')">Ver estadísticas</button>
        </div>
      </div>
    </div>`;
  }).join("");
  $("emptyPersonas").style.display=arr.length?"none":"block";
}
function renderEstadisticas(){
  const hoy=resumenArr(arrHoy()), sem=resumenArr(arrSemana()), mes=resumenArr(movimientosDelMes());
  const setPeriodo=(p,r)=>{
    $(`stat${p}In`).textContent=fmtGs(r.ingreso);
    $(`stat${p}Out`).textContent=fmtGs(r.egreso);
    $(`stat${p}Net`).textContent=fmtGs(r.ingreso-r.egreso);
    $(`stat${p}Count`).textContent=r.movimientos;
  };
  setPeriodo("Today",hoy); setPeriodo("Week",sem); setPeriodo("Month",mes);
  $("statMonthTitle").textContent=nombreMes(mesSeleccionado);
  renderRanking();
  requestAnimationFrame(renderGraficoMensual);
}
function rankingData(){
  const map=new Map();
  for(const m of movimientosDelMes()){
    const k=claveNombre(m.nombre);
    if(!map.has(k)) map.set(k,{nombre:m.nombre,ingreso:0,egreso:0});
    const x=map.get(k); x.ingreso+=num(m.ingreso); x.egreso+=num(m.egreso);
  }
  return [...map.values()].map(x=>({...x,resultado:x.ingreso-x.egreso}));
}
function renderRanking(){
  const data=rankingData();
  const bloque=(titulo,key,cls="")=>{
    const arr=[...data].sort((a,b)=>b[key]-a[key]).slice(0,5);
    return `<div class="ranking-block"><h4>${titulo}</h4>${arr.length?arr.map((x,i)=>`<div class="rank-row"><span class="rank-pos">${i+1}.</span><span class="rank-name">${escapeHtml(x.nombre)}</span><span class="rank-value ${cls}">${fmtGs(x[key])}</span></div>`).join(""):`<div class="footer-note">Sin datos.</div>`}</div>`;
  };
  $("rankingMes").innerHTML=bloque("Mayor carga","ingreso","tag-in")+bloque("Mayor retiro","egreso","tag-out")+bloque("Mayor resultado","resultado","");
}
function renderGraficoMensual(){
  const c=$("monthlyChart"); if(!c) return;
  const ctx=c.getContext("2d"), rect=c.getBoundingClientRect(), dpr=Math.max(1,window.devicePixelRatio||1);
  const W=Math.max(300,rect.width), H=300;
  c.width=Math.round(W*dpr); c.height=Math.round(H*dpr); ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,W,H);

  const dias=new Date(mesSeleccionado.getFullYear(),mesSeleccionado.getMonth()+1,0).getDate();
  const rows=Array.from({length:dias},(_,i)=>({dia:i+1,ingreso:0,egreso:0,resultado:0}));
  for(const m of movimientosDelMes()){
    const d=Number(String(m.fecha).slice(8,10));
    if(d>=1&&d<=dias){ rows[d-1].ingreso+=num(m.ingreso); rows[d-1].egreso+=num(m.egreso); rows[d-1].resultado+=num(m.ingreso)-num(m.egreso); }
  }
  const vals=rows.flatMap(r=>[r.ingreso,r.egreso,Math.abs(r.resultado)]);
  const max=Math.max(1,...vals), pad={l:48,r:14,t:16,b:30}, iw=W-pad.l-pad.r, ih=H-pad.t-pad.b;

  const isDark=document.body.classList.contains("dark-mode");
  ctx.strokeStyle=isDark?"#2a3643":"#dfe7ef"; ctx.lineWidth=1; ctx.fillStyle=isDark?"#9aa8b6":"#6b7280"; ctx.font="11px system-ui";
  for(let i=0;i<=4;i++){ const y=pad.t+ih*i/4; ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(W-pad.r,y);ctx.stroke(); const v=max*(1-i/4); ctx.fillText(numFmt.format(Math.round(v)),4,y+4); }
  const xFor=i=>pad.l+(rows.length===1?0:iw*i/(rows.length-1));
  const yFor=v=>pad.t+ih-(Math.max(-max,Math.min(max,v))+max)/(2*max)*ih;
  // línea central de resultado
  ctx.strokeStyle=isDark?"#405063":"#c7d2dc"; ctx.beginPath(); ctx.moveTo(pad.l,pad.t+ih/2); ctx.lineTo(W-pad.r,pad.t+ih/2); ctx.stroke();

  const draw=(key,color,absolute=false)=>{
    ctx.strokeStyle=color; ctx.lineWidth=2; ctx.beginPath();
    rows.forEach((r,i)=>{ const v=absolute?Math.abs(r[key]):r[key]; const y=key==="resultado"?yFor(v):pad.t+ih-(v/max)*ih; const x=xFor(i); if(i===0)ctx.moveTo(x,y); else ctx.lineTo(x,y); });
    ctx.stroke();
  };
  draw("ingreso","#15803d"); draw("egreso","#b91c1c");
  // resultado en escala positiva/negativa centrada
  ctx.strokeStyle="#155b87";ctx.lineWidth=2;ctx.beginPath();
  rows.forEach((r,i)=>{const x=xFor(i),y=yFor(r.resultado);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});ctx.stroke();

  ctx.fillStyle=isDark?"#9aa8b6":"#6b7280"; ctx.font="10px system-ui";
  const step=dias<=16?2:5;
  rows.forEach((r,i)=>{if(r.dia===1||r.dia===dias||r.dia%step===0){ctx.fillText(String(r.dia),xFor(i)-3,H-8);}});
}
function render(){
  resumenGeneral();
  renderHistorial();
  renderPersonas();
  renderSugerenciasNombres();
  actualizarUltimoMovimiento();
  renderEstadisticas();
  actualizarEstadoSync();
}
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }

function download(name,content,type){ const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement("a"); a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),500); }
function exportJson(){ const data=JSON.stringify({version:11,exportado:new Date().toISOString(),usuario:currentUser?.email||null,movimientos:activos()},null,2); download(`backup_movimientos_${hoyISO()}.json`,data,"application/json"); }
function exportCsv(){ const rows=[["Fecha","Nombre","Carga (Gs.)","Retiro (Gs.)","Resultado (Gs.)","Observación"]]; for(const m of activos()) rows.push([m.fecha,m.nombre,m.ingreso||0,m.egreso||0,num(m.ingreso)-num(m.egreso),m.observacion||""]); const csv=rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(";")).join("\r\n"); download(`movimientos_${hoyISO()}.csv`,"\uFEFF"+csv,"text/csv;charset=utf-8"); }
function importarArchivo(file){
  const reader=new FileReader(); reader.onload=()=>{ try{ const obj=JSON.parse(reader.result),arr=Array.isArray(obj)?obj:obj.movimientos; if(!Array.isArray(arr)) throw new Error(); if(!confirm(`Se importarán ${arr.length} movimientos y reemplazarán los actuales. ¿Continuar?`)) return; movimientos=arr.map(m=>normalizarMovimiento({...m,user_id:currentUser.id,updated_at:ahoraISO(),deleted:false},true)); guardarLocal(); programarSync(); alert("Backup importado correctamente. Se sincronizará con tu cuenta."); }catch{alert("No se pudo importar el archivo.");} }; reader.readAsText(file);
}


function generarPdfMensual(){
  const jsPDF=window.jspdf?.jsPDF;
  if(!jsPDF){
    alert("No se pudo cargar el generador de PDF. Conectate a internet e intentá nuevamente.");
    return;
  }
  const arr=movimientosDelMes().sort((a,b)=>(a.fecha||"").localeCompare(b.fecha||"")||(a.creado||0)-(b.creado||0));
  const r=resumenArr(arr), ranking=rankingData().sort((a,b)=>b.resultado-a.resultado);
  const doc=new jsPDF({unit:"mm",format:"a4"});
  const left=14, right=196, width=right-left;
  let y=16;
  const addText=(txt,size=10,bold=false)=>{
    doc.setFont("helvetica",bold?"bold":"normal"); doc.setFontSize(size);
    const lines=doc.splitTextToSize(String(txt),width);
    doc.text(lines,left,y); y+=lines.length*(size*0.42)+2;
  };
  const pageCheck=(need=14)=>{ if(y+need>282){ doc.addPage(); y=16; } };
  addText("Control de Movimientos",18,true);
  addText(`Reporte mensual · ${nombreMes(mesSeleccionado)}`,12,true);
  addText(`Generado: ${new Intl.DateTimeFormat("es-PY",{dateStyle:"medium",timeStyle:"short"}).format(new Date())}`,9,false);
  y+=2;
  addText(`Cargas: ${fmtGs(r.ingreso)}   |   Retiros: ${fmtGs(r.egreso)}   |   Resultado: ${fmtGs(r.ingreso-r.egreso)}   |   Movimientos: ${r.movimientos}`,10,true);
  y+=4;
  addText("Resumen por jugador",12,true);
  const persons=rankingData().sort((a,b)=>a.nombre.localeCompare(b.nombre,"es"));
  if(!persons.length) addText("Sin movimientos en este mes.",10);
  for(const p of persons){
    pageCheck(8);
    addText(`${p.nombre} — Cargas ${fmtGs(p.ingreso)} · Retiros ${fmtGs(p.egreso)} · Resultado ${fmtGs(p.resultado)}`,9,false);
  }
  y+=3;
  pageCheck(20); addText("Ranking del mes",12,true);
  ranking.slice(0,5).forEach((p,i)=>{ pageCheck(7); addText(`${i+1}. ${p.nombre} — ${fmtGs(p.resultado)}`,9,false); });
  y+=3;
  pageCheck(20); addText("Detalle de movimientos",12,true);
  for(const m of arr){
    pageCheck(9);
    const tipo=m.ingreso?`Carga ${fmtGs(m.ingreso)}`:`Retiro ${fmtGs(m.egreso)}`;
    const obs=m.observacion?` · ${m.observacion}`:"";
    addText(`${fechaPY(m.fecha)} · ${m.nombre} · ${tipo}${obs}`,9,false);
  }
  const ym=`${mesSeleccionado.getFullYear()}-${String(mesSeleccionado.getMonth()+1).padStart(2,"0")}`;
  doc.save(`reporte_movimientos_${ym}.pdf`);
}

function setAuthMsg(msg,show=true){ $("authMsg").textContent=msg; $("authMsg").style.display=show?"block":"none"; }
function mostrarAuth(){ $("authScreen").hidden=false; $("mainApp").hidden=true; }
function mostrarApp(){
  $("authScreen").hidden=true;
  $("mainApp").hidden=false;
  const nombreCompleto=[currentUser?.nombre,currentUser?.apellido].filter(Boolean).join(" ").trim();
  $("accountName").textContent=nombreCompleto || "Usuario";
  $("accountEmail").textContent=currentUser?.email || "Modo offline";
}
function cambiarAuthTab(tab){
  const login=tab==="login"; $("tabLogin").classList.toggle("active",login); $("tabRegister").classList.toggle("active",!login); $("panelLogin").classList.toggle("active",login); $("panelRegister").classList.toggle("active",!login); setAuthMsg("",false);
}
function esRetornoRecuperacion(){
  const hash=new URLSearchParams(window.location.hash.replace(/^#/,""));
  const query=new URLSearchParams(window.location.search);
  return hash.get("type")==="recovery" || query.get("type")==="recovery";
}

function abrirRecuperacion(){
  $("forgotEmail").value=$("loginEmail").value.trim();
  $("forgotMsg").textContent="";
  $("forgotDialog").showModal();
}

async function enviarRecuperacion(){
  if(!sb){ $("forgotMsg").textContent="No se pudo conectar con el servicio."; return; }
  if(!navigator.onLine){ $("forgotMsg").textContent="Necesitás internet para recuperar tu contraseña."; return; }
  const email=$("forgotEmail").value.trim();
  if(!email){ $("forgotMsg").textContent="Ingresá tu email."; return; }
  $("forgotMsg").textContent="Enviando…";
  const {error}=await sb.auth.resetPasswordForEmail(email,{
    redirectTo:"https://kiritogood.github.io/Control-movimientos/"
  });
  if(error){ $("forgotMsg").textContent=error.message; return; }
  $("forgotMsg").textContent="Enlace enviado. Revisá tu correo y abrí el mensaje de recuperación.";
}

function abrirNuevaPassword(){
  mostrarAuth();
  $("resetPasswordMsg").textContent="";
  $("newPassword").value="";
  $("newPasswordConfirm").value="";
  if(!$("resetPasswordDialog").open) $("resetPasswordDialog").showModal();
}

async function guardarNuevaPassword(){
  if(!sb) return;
  const password=$("newPassword").value;
  const confirmPassword=$("newPasswordConfirm").value;
  if(password.length<6){ $("resetPasswordMsg").textContent="La contraseña debe tener al menos 6 caracteres."; return; }
  if(password!==confirmPassword){ $("resetPasswordMsg").textContent="Las contraseñas no coinciden."; return; }
  $("resetPasswordMsg").textContent="Guardando…";
  const {error}=await sb.auth.updateUser({password});
  if(error){ $("resetPasswordMsg").textContent=error.message; return; }
  $("resetPasswordMsg").textContent="Contraseña actualizada correctamente.";
  try{ await sb.auth.signOut(); }catch{}
  currentUser=null;
  movimientos=[];
  localStorage.removeItem(LAST_USER_KEY);
  history.replaceState(null,"",window.location.pathname);
  setTimeout(()=>{
    $("resetPasswordDialog").close();
    mostrarAuth();
    cambiarAuthTab("login");
    setAuthMsg("Contraseña actualizada. Ya podés iniciar sesión con la nueva contraseña.");
    $("loginEmail").focus();
  },700);
}

async function login(){
  if(!sb){ setAuthMsg("Primero configurá Supabase en supabase-config.js."); return; }
  if(!navigator.onLine){ setAuthMsg("Para iniciar sesión por primera vez necesitás internet."); return; }
  const email=$("loginEmail").value.trim();
  const password=$("loginPassword").value;
  if(!email||!password){setAuthMsg("Completá email y contraseña.");return;}
  setAuthMsg("Ingresando…");
  const {data,error}=await sb.auth.signInWithPassword({email,password});
  if(error){
    if(errorEsBan(error)){ setAuthMsg("Esta cuenta fue bloqueada por el administrador."); return; }
    setAuthMsg(error.message); return;
  }
  marcarValidacionCorrecta(data.user.id);
  await iniciarUsuario(data.user,true);
  iniciarControlDeAcceso();
}
async function register(){
  if(!sb){ setAuthMsg("Primero configurá Supabase en supabase-config.js."); return; }
  if(!navigator.onLine){ setAuthMsg("Necesitás internet para crear una cuenta."); return; }
  const nombre=normalizarNombre($("registerNombre").value);
  const apellido=normalizarNombre($("registerApellido").value);
  const email=$("registerEmail").value.trim(),password=$("registerPassword").value;
  const confirmPassword=$("registerPasswordConfirm").value;
  if(!nombre||!apellido){setAuthMsg("Completá tu nombre y apellido.");return;}
  if(!email||password.length<6){setAuthMsg("Usá un email válido y una contraseña de al menos 6 caracteres.");return;}
  if(!confirmPassword){setAuthMsg("Confirmá tu contraseña.");return;}
  if(password!==confirmPassword){setAuthMsg("Las contraseñas no coinciden.");return;}
  setAuthMsg("Creando cuenta…"); const {data,error}=await sb.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: "https://kiritogood.github.io/Control-movimientos/",
      data: { nombre, apellido }
    }
  }); if(error){setAuthMsg(error.message);return;}
  if(data.session && data.user){ await iniciarUsuario(data.user,true); } else { setAuthMsg("Cuenta creada. Revisá tu email y confirmá la cuenta antes de iniciar sesión."); cambiarAuthTab("login"); setAuthMsg("Cuenta creada. Revisá tu email y confirmá la cuenta antes de iniciar sesión."); }
}
async function abrirPerfil(){
  if(!currentUser) return;
  $("profileNombre").value=currentUser.nombre||"";
  $("profileApellido").value=currentUser.apellido||"";
  $("profileEmail").value=currentUser.email||"";
  $("profileMsg").textContent="";
  $("profileDialog").showModal();
}
async function guardarPerfil(){
  if(!sb||!currentUser) return;
  if(!navigator.onLine){ $("profileMsg").textContent="Necesitás internet para actualizar tu perfil."; return; }
  const nombre=normalizarNombre($("profileNombre").value);
  const apellido=normalizarNombre($("profileApellido").value);
  if(!nombre||!apellido){ $("profileMsg").textContent="Completá tu nombre y apellido."; return; }
  $("profileMsg").textContent="Guardando…";
  const {data,error}=await sb.auth.updateUser({data:{nombre,apellido}});
  if(error){ $("profileMsg").textContent=error.message; return; }
  const user=data.user;
  currentUser={
    id:user.id,
    email:user.email||currentUser.email||"",
    nombre:user.user_metadata?.nombre||nombre,
    apellido:user.user_metadata?.apellido||apellido
  };
  localStorage.setItem(LAST_USER_KEY,JSON.stringify(currentUser));
  mostrarApp();
  $("profileDialog").close();
}
async function logout(){
  clearInterval(authCheckTimer);
  if(!confirm("¿Cerrar sesión en este dispositivo?")) return;
  if(sb && navigator.onLine){ try{await sb.auth.signOut();}catch{} }
  localStorage.removeItem(LAST_USER_KEY); currentUser=null; movimientos=[]; mostrarAuth(); setAuthMsg("Sesión cerrada.");
}

async function iniciarUsuario(user, sincronizar=true){
  currentUser={
    id:user.id,
    email:user.email||"",
    nombre:user.user_metadata?.nombre||"",
    apellido:user.user_metadata?.apellido||""
  };
  localStorage.setItem(LAST_USER_KEY,JSON.stringify(currentUser)); cargarLocal(); await migrarV7SiCorresponde(); mostrarApp(); render(); if(sincronizar) await sincronizarTodo();
}
async function migrarV7SiCorresponde(){
  try{
    const done=localStorage.getItem(`${MIGRATION_KEY}_${currentUser.id}`); if(done) return;
    const raw=localStorage.getItem(LEGACY_KEY); const legacy=raw?JSON.parse(raw):[];
    if(Array.isArray(legacy)&&legacy.length && movimientos.length===0){
      const ok=confirm(`Encontré ${legacy.length} movimientos de la versión anterior. ¿Querés vincularlos a esta cuenta?`);
      if(ok){ movimientos=legacy.map(m=>normalizarMovimiento({...m,user_id:currentUser.id,updated_at:ahoraISO(),deleted:false},true)); guardarLocal(true); }
    }
    localStorage.setItem(`${MIGRATION_KEY}_${currentUser.id}`,"1");
  }catch{}
}

function estadoPendientes(){ return movimientos.filter(m=>m.sync_status==="pending").length; }
function actualizarEstadoSync(texto=null,tipo=null){
  const el=$("syncStatus"); if(!el) return;
  el.className="sync-pill";
  if(texto){ el.textContent=texto; if(tipo) el.classList.add(tipo); return; }
  const p=estadoPendientes();
  if(!navigator.onLine){ el.textContent=p?`Sin conexión · ${p} pendiente${p===1?"":"s"}`:"Sin conexión"; el.classList.add("offline"); }
  else if(syncBusy){ el.textContent="Sincronizando…"; el.classList.add("pending"); }
  else if(p){ el.textContent=`${p} pendiente${p===1?"":"s"}`; el.classList.add("pending"); }
  else { el.textContent="Sincronizado"; el.classList.add("ok"); }
}
function dbRow(m){ return {id:m.id,user_id:currentUser.id,fecha:m.fecha,nombre:m.nombre,ingreso:num(m.ingreso),egreso:num(m.egreso),observacion:m.observacion||"",creado:Number(m.creado||Date.now()),updated_at:m.updated_at||ahoraISO(),deleted:Boolean(m.deleted)}; }
function fromDb(r){ return normalizarMovimiento({...r,sync_status:"synced"},false); }

async function sincronizarTodo(){
  if(currentUser?.id && navigator.onLine){
    const acceso=await validarCuentaActual({silencioso:true});
    if(!acceso) return;
  }
  if(syncBusy||!currentUser||!sb||!navigator.onLine){ actualizarEstadoSync(); return; }

  syncBusy=true;
  actualizarEstadoSync();

  try{
    // V8.2: confirmar la sesión real antes de leer/escribir en la nube.
    let {data:userData,error:userError}=await sb.auth.getUser();
    if(userError || !userData?.user){
      const {error:refreshError}=await sb.auth.refreshSession();
      if(refreshError) throw refreshError;
      ({data:userData,error:userError}=await sb.auth.getUser());
      if(userError || !userData?.user) throw userError || new Error("No hay una sesión válida.");
    }

    const cloudUser=userData.user;
    currentUser={
      id:cloudUser.id,
      email:cloudUser.email||currentUser.email||"",
      nombre:cloudUser.user_metadata?.nombre||currentUser.nombre||"",
      apellido:cloudUser.user_metadata?.apellido||currentUser.apellido||""
    };
    localStorage.setItem(LAST_USER_KEY,JSON.stringify(currentUser));

    // 1) Descargar primero todo lo que ya existe en la nube para esta cuenta.
    const {data:remote,error:pullError}=await sb
      .from("movimientos")
      .select("*")
      .eq("user_id",currentUser.id);

    if(pullError) throw pullError;

    const remoteMap=new Map((remote||[]).map(r=>[r.id,r]));
    const localMap=new Map(movimientos.map(m=>[m.id,m]));

    // Incorporar movimientos que existen en otro dispositivo y resolver versiones.
    for(const r of (remote||[])){
      const local=localMap.get(r.id);
      if(!local){
        localMap.set(r.id,fromDb(r));
        continue;
      }
      const localT=Date.parse(local.updated_at||0)||0;
      const remoteT=Date.parse(r.updated_at||0)||0;
      if(local.sync_status!=="pending" || remoteT>localT){
        localMap.set(r.id,fromDb(r));
      }
    }
    movimientos=[...localMap.values()];

    // 2) Subir los cambios locales pendientes.
    const pendientes=movimientos.filter(m=>m.sync_status==="pending");
    for(const m of pendientes){
      const r=remoteMap.get(m.id);
      const localT=Date.parse(m.updated_at||0)||0;
      const remoteT=r?(Date.parse(r.updated_at||0)||0):0;

      if(!r || localT>=remoteT){
        const {error}=await sb.from("movimientos").upsert(dbRow(m),{onConflict:"id"});
        if(error) throw error;
      }
    }

    // 3) Volver a descargar: esta respuesta es la verdad final de la nube.
    const {data:finalRows,error:finalError}=await sb
      .from("movimientos")
      .select("*")
      .eq("user_id",currentUser.id);

    if(finalError) throw finalError;

    movimientos=(finalRows||[]).map(fromDb);
    guardarLocal(true);
    render();

  }catch(err){
    console.error("V11 sync:",err);
    actualizarEstadoSync("Error de sincronización","error");
  }finally{
    syncBusy=false;
    actualizarEstadoSync();
  }
}
function programarSync(){ clearTimeout(syncTimer); syncTimer=setTimeout(()=>sincronizarTodo(),50); }


function authValidationKey(userId){ return `${AUTH_VALIDATION_PREFIX}${userId}`; }
function blockedUserKey(userId){ return `${BLOCKED_USER_PREFIX}${userId}`; }

function estaMarcadoBloqueado(userId){
  return !!(userId && localStorage.getItem(blockedUserKey(userId))==="1");
}
function marcarValidacionCorrecta(userId){
  if(!userId) return;
  localStorage.setItem(authValidationKey(userId),String(Date.now()));
  localStorage.removeItem(blockedUserKey(userId));
}
function validacionOfflineVigente(userId){
  if(!userId || estaMarcadoBloqueado(userId)) return false;
  const t=Number(localStorage.getItem(authValidationKey(userId))||0);
  return t>0 && (Date.now()-t)<=OFFLINE_GRACE_MS;
}
function usuarioEstaBaneado(user){
  const raw=user?.banned_until;
  if(!raw) return false;
  const t=Date.parse(raw);
  return Number.isFinite(t) && t>Date.now();
}
function errorEsBan(error){
  const code=String(error?.code||"").toLowerCase();
  const msg=String(error?.message||"").toLowerCase();
  return code==="user_banned" || msg.includes("banned") || msg.includes("ban");
}
async function bloquearCuentaLocal(userId,msg="Esta cuenta fue bloqueada por el administrador."){
  if(userId) localStorage.setItem(blockedUserKey(userId),"1");
  clearInterval(authCheckTimer);
  try{ if(sb) await sb.auth.signOut({scope:"local"}); }catch{}
  localStorage.removeItem(LAST_USER_KEY);
  currentUser=null;
  movimientos=[];
  mostrarAuth();
  cambiarAuthTab("login");
  setAuthMsg(msg);
}
async function validarCuentaActual({silencioso=false}={}){
  if(authCheckBusy || !sb || !currentUser?.id) return true;

  if(!navigator.onLine){
    if(estaMarcadoBloqueado(currentUser.id)){
      await bloquearCuentaLocal(currentUser.id);
      return false;
    }
    if(!validacionOfflineVigente(currentUser.id)){
      mostrarAuth();
      setAuthMsg("Necesitás conexión a internet para validar esta cuenta. El acceso offline dura hasta 24 horas desde la última validación.");
      return false;
    }
    return true;
  }

  authCheckBusy=true;
  try{
    const {data,error}=await sb.auth.getUser();

    if(error){
      if(errorEsBan(error)){
        await bloquearCuentaLocal(currentUser.id);
        return false;
      }
      if(!silencioso) console.warn("V11 validación de cuenta:",error);
      return true;
    }

    const user=data?.user;
    if(!user){
      await bloquearCuentaLocal(currentUser.id,"La sesión ya no es válida. Iniciá sesión nuevamente.");
      return false;
    }

    if(usuarioEstaBaneado(user)){
      await bloquearCuentaLocal(user.id);
      return false;
    }

    marcarValidacionCorrecta(user.id);

    currentUser={
      id:user.id,
      email:user.email||currentUser.email||"",
      nombre:user.user_metadata?.nombre||currentUser.nombre||"",
      apellido:user.user_metadata?.apellido||currentUser.apellido||""
    };
    localStorage.setItem(LAST_USER_KEY,JSON.stringify(currentUser));
    mostrarApp();
    return true;
  }catch(err){
    if(!silencioso) console.warn("V11 validación de cuenta:",err);
    return true;
  }finally{
    authCheckBusy=false;
  }
}
function iniciarControlDeAcceso(){
  clearInterval(authCheckTimer);
  authCheckTimer=setInterval(()=>{
    if(document.visibilityState==="visible" && currentUser?.id){
      validarCuentaActual({silencioso:true});
    }
  },60000);
}

async function iniciarSesionGuardada(){
  sb=crearCliente();
  if(!sb){ mostrarAuth(); setAuthMsg("V11 está lista, pero falta conectar Supabase. Completá SUPABASE_URL y SUPABASE_PUBLISHABLE_KEY en supabase-config.js."); return; }

  let recoveryDetected=esRetornoRecuperacion();

  sb.auth.onAuthStateChange((event)=>{
    if(event==="PASSWORD_RECOVERY"){
      recoveryDetected=true;
      setTimeout(abrirNuevaPassword,0);
    }
  });

  try{
    const {data:sessionData}=await sb.auth.getSession();

    if(recoveryDetected){
      abrirNuevaPassword();
      return;
    }

    if(sessionData?.session?.user){
      const sessionUser=sessionData.session.user;

      if(estaMarcadoBloqueado(sessionUser.id)){
        await bloquearCuentaLocal(sessionUser.id);
        return;
      }

      if(navigator.onLine){
        const {data:userData,error:userError}=await sb.auth.getUser();

        if(userError && errorEsBan(userError)){
          await bloquearCuentaLocal(sessionUser.id);
          return;
        }

        const verifiedUser=userData?.user;
        if(verifiedUser){
          if(usuarioEstaBaneado(verifiedUser)){
            await bloquearCuentaLocal(verifiedUser.id);
            return;
          }
          marcarValidacionCorrecta(verifiedUser.id);
          await iniciarUsuario(verifiedUser,true);
          iniciarControlDeAcceso();
          return;
        }
      }else{
        if(validacionOfflineVigente(sessionUser.id)){
          await iniciarUsuario(sessionUser,false);
          iniciarControlDeAcceso();
          actualizarEstadoSync();
          return;
        }
        mostrarAuth();
        setAuthMsg("Necesitás conexión a internet para validar esta cuenta. El acceso offline dura hasta 24 horas desde la última validación.");
        return;
      }
    }
  }catch(err){
    console.warn("V11 inicio de sesión guardada:",err);
  }

  if(!navigator.onLine){
    try{
      const last=JSON.parse(localStorage.getItem(LAST_USER_KEY)||"null");
      if(last?.id){
        if(estaMarcadoBloqueado(last.id)){
          await bloquearCuentaLocal(last.id);
          return;
        }
        if(validacionOfflineVigente(last.id)){
          await iniciarUsuario(last,false);
          iniciarControlDeAcceso();
          actualizarEstadoSync();
          return;
        }
      }
    }catch{}
    mostrarAuth();
    setAuthMsg("Necesitás conexión a internet para validar esta cuenta. El acceso offline dura hasta 24 horas desde la última validación.");
    return;
  }

  mostrarAuth();
}

document.addEventListener("DOMContentLoaded",()=>{
  $("fecha").value=hoyISO(); ["ingreso","egreso","eIngreso","eEgreso"].forEach(activarFormatoGs);
  $("tabLogin").addEventListener("click",()=>cambiarAuthTab("login")); $("tabRegister").addEventListener("click",()=>cambiarAuthTab("register"));
  $("forgotPasswordBtn").addEventListener("click",abrirRecuperacion);
  $("sendRecoveryBtn").addEventListener("click",enviarRecuperacion);
  $("cancelRecoveryBtn").addEventListener("click",()=>$("forgotDialog").close());
  $("forgotEmail").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();enviarRecuperacion();}});
  $("saveNewPasswordBtn").addEventListener("click",guardarNuevaPassword);
  $("newPasswordConfirm").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();guardarNuevaPassword();}});
  $("profileBtn").addEventListener("click",abrirPerfil);
  $("themeToggle").addEventListener("click",alternarTema);
  cargarTema();
  $("saveProfileBtn").addEventListener("click",guardarPerfil);
  $("cancelProfileBtn").addEventListener("click",()=>$("profileDialog").close());
  $("profileApellido").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();guardarPerfil();}});
  $("loginBtn").addEventListener("click",login); $("registerPasswordConfirm").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();register();}}); $("registerBtn").addEventListener("click",register); $("logoutBtn").addEventListener("click",logout); $("syncNow").addEventListener("click",sincronizarTodo);
  $("loginPassword").addEventListener("keydown",e=>{if(e.key==="Enter")login();}); $("registerPassword").addEventListener("keydown",e=>{if(e.key==="Enter")register();});
  $("prevMonth").addEventListener("click",()=>{mesSeleccionado=new Date(mesSeleccionado.getFullYear(),mesSeleccionado.getMonth()-1,1);render();});
  $("nextMonth").addEventListener("click",()=>{mesSeleccionado=new Date(mesSeleccionado.getFullYear(),mesSeleccionado.getMonth()+1,1);render();});
  $("agregar").addEventListener("click",agregarMovimiento); $("limpiar").addEventListener("click",()=>{$("nombre").value="";$("ingreso").value="";$("egreso").value="";$("obs").value="";$("fecha").value=hoyISO();$("nombre").focus();});
  $("buscar").addEventListener("input",renderHistorial); $("filtroTipo").addEventListener("change",renderHistorial); $("buscarPersona").addEventListener("input",renderPersonas);
  $("nombre").addEventListener("input",actualizarUltimoMovimiento);
  $("nombre").addEventListener("change",actualizarUltimoMovimiento);
  $("exportPdf").addEventListener("click",generarPdfMensual);
  $("playerMonthBtn").addEventListener("click",()=>{playerScope="month";renderJugadorDialog();});
  $("playerAllBtn").addEventListener("click",()=>{playerScope="all";renderJugadorDialog();});
  $("closePlayerBtn").addEventListener("click",()=>$("playerDialog").close());
  $("usePlayerBtn").addEventListener("click",()=>{if(playerActual){$("playerDialog").close();elegirNombre(playerActual);document.querySelector('[data-tab="historial"]')?.click();window.scrollTo({top:0,behavior:"smooth"});}});
  window.addEventListener("resize",()=>{if($("estadisticas")?.classList.contains("active")) requestAnimationFrame(renderGraficoMensual);});
  document.querySelectorAll(".tab").forEach(btn=>btn.addEventListener("click",()=>{document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));document.querySelectorAll(".section").forEach(x=>x.classList.remove("active"));btn.classList.add("active");$(btn.dataset.tab).classList.add("active");if(btn.dataset.tab==="estadisticas")requestAnimationFrame(renderGraficoMensual);}));
  $("exportJson").addEventListener("click",exportJson); $("exportCsv").addEventListener("click",exportCsv); $("importJson").addEventListener("click",()=>$("fileImport").click()); $("fileImport").addEventListener("change",e=>{if(e.target.files[0])importarArchivo(e.target.files[0]);e.target.value="";});
  $("borrarTodo").addEventListener("click",()=>{if(confirm("¿Seguro que querés borrar TODOS los movimientos de esta cuenta?")){for(const m of movimientos){if(!m.deleted){m.deleted=true;m.updated_at=ahoraISO();m.sync_status="pending";}}guardarLocal();programarSync();}});
  $("guardarEdicion").addEventListener("click",guardarEdicion); $("cancelarEdicion").addEventListener("click",()=>$("editDialog").close());
  ["nombre","ingreso","egreso"].forEach(id=>$(id).addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();agregarMovimiento();}}));
  window.addEventListener("online",async()=>{actualizarEstadoSync();if(await validarCuentaActual({silencioso:true})) sincronizarTodo();});
  window.addEventListener("offline",actualizarEstadoSync);
  window.addEventListener("focus",()=>{if(currentUser?.id) validarCuentaActual({silencioso:true});});
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"&&currentUser?.id) validarCuentaActual({silencioso:true});});
  window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();deferredPrompt=e;$("installBanner").style.display="block";});
  $("installBtn").addEventListener("click",async()=>{if(!deferredPrompt)return;deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;$("installBanner").style.display="none";});
  if("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js?v=11.1",{updateViaCache:"none"}).catch(()=>{});
  iniciarSesionGuardada();
});
