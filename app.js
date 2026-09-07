const KEY = "control_movimientos_v1";
let movimientos = cargar();
let editId = null;
let deferredPrompt = null;

const $ = (id) => document.getElementById(id);
const numFmt = new Intl.NumberFormat("es-PY", { maximumFractionDigits: 0 });
const fmtGs = (n) => `Gs. ${numFmt.format(Number(n || 0))}`;

function hoyISO(){
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off*60000);
  return local.toISOString().slice(0,10);
}

function cargar(){
  try{
    const raw = localStorage.getItem(KEY);
    const data = raw ? JSON.parse(raw) : [];
    return Array.isArray(data) ? data : [];
  }catch{ return []; }
}

function guardar(){
  localStorage.setItem(KEY, JSON.stringify(movimientos));
  render();
}

function num(v){
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}

function normalizarNombre(s){
  return (s || "").trim().replace(/\s+/g," ");
}

function agregarMovimiento(){
  const nombre = normalizarNombre($("nombre").value);
  const ingreso = num($("ingreso").value);
  const egreso = num($("egreso").value);
  if(!nombre){ alert("Ingrese un nombre."); $("nombre").focus(); return; }
  if(ingreso <= 0 && egreso <= 0){ alert("Ingrese un importe en Ingreso o Retiro."); return; }

  movimientos.push({
    id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())+Math.random()),
    fecha: $("fecha").value || hoyISO(),
    nombre,
    ingreso,
    egreso,
    observacion: $("obs").value.trim(),
    creado: Date.now()
  });

  guardar();
  $("nombre").value = "";
  $("ingreso").value = "";
  $("egreso").value = "";
  $("obs").value = "";
  $("fecha").value = hoyISO();
  $("nombre").focus();
}

function eliminar(id){
  if(!confirm("¿Eliminar este movimiento?")) return;
  movimientos = movimientos.filter(m => m.id !== id);
  guardar();
}

function editar(id){
  const m = movimientos.find(x => x.id === id);
  if(!m) return;
  editId = id;
  $("eFecha").value = m.fecha;
  $("eNombre").value = m.nombre;
  $("eIngreso").value = m.ingreso || "";
  $("eEgreso").value = m.egreso || "";
  $("eObs").value = m.observacion || "";
  $("editDialog").showModal();
}

function guardarEdicion(){
  const m = movimientos.find(x => x.id === editId);
  if(!m) return;
  const nombre = normalizarNombre($("eNombre").value);
  const ingreso = num($("eIngreso").value);
  const egreso = num($("eEgreso").value);
  if(!nombre){ alert("Ingrese un nombre."); return; }
  if(ingreso <= 0 && egreso <= 0){ alert("Ingrese un importe en Ingreso o Retiro."); return; }
  m.fecha = $("eFecha").value || hoyISO();
  m.nombre = nombre;
  m.ingreso = ingreso;
  m.egreso = egreso;
  m.observacion = $("eObs").value.trim();
  $("editDialog").close();
  guardar();
}

function resumenGeneral(){
  const ing = movimientos.reduce((a,m)=>a+num(m.ingreso),0);
  const egr = movimientos.reduce((a,m)=>a+num(m.egreso),0);
  $("totalIngresos").textContent = fmtGs(ing);
  $("totalEgresos").textContent = fmtGs(egr);
  $("saldoGeneral").textContent = fmtGs(ing-egr);
  $("contador").textContent = `${movimientos.length} movimiento${movimientos.length===1?"":"s"}`;
}

function renderHistorial(){
  const q = $("buscar").value.toLowerCase().trim();
  const tipo = $("filtroTipo").value;
  let arr = [...movimientos].sort((a,b) => (b.fecha||"").localeCompare(a.fecha||"") || (b.creado||0)-(a.creado||0));

  arr = arr.filter(m => {
    const texto = `${m.nombre} ${m.observacion||""}`.toLowerCase();
    const okQ = !q || texto.includes(q);
    const okTipo = tipo==="todos" || (tipo==="ingreso" ? num(m.ingreso)>0 : num(m.egreso)>0);
    return okQ && okTipo;
  });

  $("tbody").innerHTML = arr.map(m => `
    <tr>
      <td>${escapeHtml(m.fecha||"")}</td>
      <td><strong>${escapeHtml(m.nombre)}</strong></td>
      <td class="money tag-in">${m.ingreso ? fmtGs(m.ingreso) : ""}</td>
      <td class="money tag-out">${m.egreso ? fmtGs(m.egreso) : ""}</td>
      <td class="money"><strong>${fmtGs(num(m.ingreso)-num(m.egreso))}</strong></td>
      <td>${escapeHtml(m.observacion||"")}</td>
      <td>
        <div class="row-actions">
          <button class="btn-secondary" onclick="editar('${m.id}')">Editar</button>
          <button class="btn-danger" onclick="eliminar('${m.id}')">Eliminar</button>
        </div>
      </td>
    </tr>
  `).join("");

  $("emptyHist").style.display = arr.length ? "none" : "block";
}

function renderPersonas(){
  const map = new Map();
  for(const m of movimientos){
    const key = m.nombre.trim().toLocaleLowerCase("es");
    if(!map.has(key)) map.set(key,{nombre:m.nombre, ingreso:0, egreso:0, movimientos:0});
    const x = map.get(key);
    x.ingreso += num(m.ingreso); x.egreso += num(m.egreso); x.movimientos++;
  }
  const q = $("buscarPersona").value.toLowerCase().trim();
  const arr = [...map.values()]
    .filter(x => !q || x.nombre.toLowerCase().includes(q))
    .sort((a,b)=>a.nombre.localeCompare(b.nombre,"es"));

  $("resumenPersonas").innerHTML = arr.map(x=>`
    <div class="person">
      <strong>${escapeHtml(x.nombre)}</strong>
      <small>Ingresos: <b class="tag-in">${fmtGs(x.ingreso)}</b></small>
      <small>Egresos: <b class="tag-out">${fmtGs(x.egreso)}</b></small>
      <small>Saldo: <b>${fmtGs(x.ingreso-x.egreso)}</b></small>
      <small>Movimientos: ${x.movimientos}</small>
    </div>
  `).join("");
  $("emptyPersonas").style.display = arr.length ? "none" : "block";
}

function render(){
  resumenGeneral();
  renderHistorial();
  renderPersonas();
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

function download(name, content, type){
  const blob = new Blob([content], {type});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),500);
}

function exportJson(){
  const data = JSON.stringify({version:1, exportado:new Date().toISOString(), movimientos}, null, 2);
  download(`backup_movimientos_${hoyISO()}.json`, data, "application/json");
}

function exportCsv(){
  const rows = [["Fecha","Nombre","Ingreso (Gs.)","Retiro (Gs.)","Saldo (Gs.)","Observación"]];
  for(const m of movimientos){
    rows.push([m.fecha,m.nombre,m.ingreso||0,m.egreso||0,num(m.ingreso)-num(m.egreso),m.observacion||""]);
  }
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(";")).join("\r\n");
  download(`movimientos_${hoyISO()}.csv`, "\uFEFF"+csv, "text/csv;charset=utf-8");
}

function importarArchivo(file){
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const obj = JSON.parse(reader.result);
      const arr = Array.isArray(obj) ? obj : obj.movimientos;
      if(!Array.isArray(arr)) throw new Error("Formato inválido");
      if(!confirm(`Se importarán ${arr.length} movimientos y reemplazarán los actuales. ¿Continuar?`)) return;
      movimientos = arr;
      guardar();
      alert("Backup importado correctamente.");
    }catch{
      alert("No se pudo importar el archivo.");
    }
  };
  reader.readAsText(file);
}

document.addEventListener("DOMContentLoaded", ()=>{
  $("fecha").value = hoyISO();
  render();

  $("agregar").addEventListener("click", agregarMovimiento);
  $("limpiar").addEventListener("click", ()=>{
    $("nombre").value=""; $("ingreso").value=""; $("egreso").value=""; $("obs").value=""; $("fecha").value=hoyISO(); $("nombre").focus();
  });
  $("buscar").addEventListener("input", renderHistorial);
  $("filtroTipo").addEventListener("change", renderHistorial);
  $("buscarPersona").addEventListener("input", renderPersonas);

  document.querySelectorAll(".tab").forEach(btn => btn.addEventListener("click", ()=>{
    document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
    document.querySelectorAll(".section").forEach(x=>x.classList.remove("active"));
    btn.classList.add("active");
    $(btn.dataset.tab).classList.add("active");
  }));

  $("exportJson").addEventListener("click", exportJson);
  $("exportCsv").addEventListener("click", exportCsv);
  $("importJson").addEventListener("click", ()=>$("fileImport").click());
  $("fileImport").addEventListener("change", e => {
    if(e.target.files[0]) importarArchivo(e.target.files[0]);
    e.target.value = "";
  });
  $("borrarTodo").addEventListener("click", ()=>{
    if(confirm("¿Seguro que querés borrar TODOS los movimientos? Esta acción no se puede deshacer.")){
      movimientos=[]; guardar();
    }
  });

  $("guardarEdicion").addEventListener("click", guardarEdicion);
  $("cancelarEdicion").addEventListener("click", ()=>$("editDialog").close());

  // Enter rápido desde campos
  ["nombre","ingreso","egreso"].forEach(id => $(id).addEventListener("keydown", e=>{
    if(e.key==="Enter"){ e.preventDefault(); agregarMovimiento(); }
  }));

  // PWA
  window.addEventListener("beforeinstallprompt", (e)=>{
    e.preventDefault();
    deferredPrompt = e;
    $("installBanner").style.display = "block";
  });
  $("installBtn").addEventListener("click", async ()=>{
    if(!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $("installBanner").style.display = "none";
  });

  if("serviceWorker" in navigator){
    navigator.serviceWorker.register("sw.js").catch(()=>{});
  }
});
