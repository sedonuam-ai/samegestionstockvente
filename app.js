/* =========================================================
   DONNÉES & PERSISTANCE
========================================================= */
const STORAGE_KEY = 'stockventes_data_v1';
const SETTINGS_KEY = 'stockventes_settings_v1';

let state = { products: [], families: [] };
let settings = { currency:'FCFA', tva:18, seq:0 };
let currentTab = 'dashboard';
let currentProductId = null;
let currentFamilyFilter = 'all';

const DEFAULT_FAMILIES = [
  { code:'F1', name:'Produits alimentaires' },
  { code:'F2', name:'Produits de beauté' },
  { code:'F3', name:'Produits de savon' }
];

function loadData(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw) state = JSON.parse(raw);
  }catch(e){ console.error('load error', e); }
  try{
    const rawS = localStorage.getItem(SETTINGS_KEY);
    if(rawS) settings = Object.assign(settings, JSON.parse(rawS));
  }catch(e){}
  if(!Array.isArray(state.products)) state.products = [];
  if(!Array.isArray(state.families) || state.families.length===0){
    state.families = DEFAULT_FAMILIES.map(f=>({ id:uid(), code:f.code, name:f.name, seq:0 }));
    saveData();
  }
}
function saveData(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }catch(e){ toast("Stockage indisponible sur cet appareil"); }
}
function uid(){ settings.seq = (settings.seq||0)+1; return Date.now().toString(36)+'-'+settings.seq; }

/* =========================================================
   FAMILLES DE PRODUITS & RÉFÉRENCES
========================================================= */
function getFamily(id){ return state.families.find(f=>f.id===id); }
function familyLabel(id){ const f = getFamily(id); return f ? `${f.code} — ${f.name}` : 'Sans famille'; }
function nextFamilyCode(){
  const nums = state.families.map(f => parseInt((f.code.match(/\d+/)||['0'])[0], 10)).filter(n=>!isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return 'F' + next;
}
function addFamily(name, code){
  const finalCode = (code && code.trim()) ? code.trim().toUpperCase() : nextFamilyCode();
  const family = { id:uid(), code:finalCode, name:name.trim(), seq:0 };
  state.families.push(family);
  saveData();
  return family;
}
function deleteFamily(id){
  const inUse = state.products.some(p=>p.familyId===id);
  if(inUse){ toast('Impossible : des produits appartiennent encore à cette famille'); return false; }
  state.families = state.families.filter(f=>f.id!==id);
  saveData(); return true;
}
function nextReference(familyId){
  const f = getFamily(familyId);
  if(!f) return '—';
  f.seq = (f.seq||0) + 1;
  return `${f.code}-${String(f.seq).padStart(3,'0')}`;
}

/* =========================================================
   MOTEUR DE CALCUL (PMP / CUMP, marges, TVA)
========================================================= */
function recomputeProduct(p){
  const moves = [];
  p.entries.forEach(e => moves.push({kind:'entry', ref:e, date:e.date, seq:e.seq}));
  p.exits.forEach(x => moves.push({kind:'exit', ref:x, date:x.date, seq:x.seq}));
  moves.sort((a,b)=> (a.date||'').localeCompare(b.date||'') || a.seq-b.seq);

  let soldeQty = 0, soldeVal = 0;
  moves.forEach(m=>{
    if(m.kind==='entry'){
      const e = m.ref;
      soldeVal += e.qty * e.pau;
      soldeQty += e.qty;
      e.pat = e.qty * e.pau;
      e.soldeQty = soldeQty;
      e.pmp = soldeQty>0 ? soldeVal/soldeQty : 0;
    } else {
      const x = m.ref;
      const pmpAvant = soldeQty>0 ? soldeVal/soldeQty : 0;
      x.pau = pmpAvant;
      x.pat = x.qty * pmpAvant;
      soldeVal -= x.pat;
      soldeQty -= x.qty;
      if(soldeQty < 0){ soldeQty = 0; }
      x.soldeQty = soldeQty;
      x.pmp = soldeQty>0 ? soldeVal/soldeQty : pmpAvant;
    }
  });

  p.sales.forEach(s=>{
    const linkedExit = p.exits.find(x=>x.id===s.exitId);
    if(!linkedExit) return;
    const pmp = linkedExit.pau;
    s.pmp = pmp;
    s.puv = pmp * (1 + (s.margeB/100));
    s.pum = s.puv * s.qty;
    s.tvaMontant = s.pum * (s.tva/100);
    s.pvt = s.pum + s.tvaMontant;
    s.resultat = s.pvt - linkedExit.pat;
  });

  p._stock = { qty: soldeQty, value: soldeVal, pmp: soldeQty>0 ? soldeVal/soldeQty : 0 };
}
function recomputeAll(){ state.products.forEach(recomputeProduct); }

/* =========================================================
   ACTIONS PRODUITS / MOUVEMENTS
========================================================= */
function addProduct(name, unit, familyId){
  const reference = nextReference(familyId);
  state.products.push({ id:uid(), name:name.trim(), unit:unit.trim()||'u', familyId, reference, entries:[], exits:[], sales:[], _stock:{qty:0,value:0,pmp:0} });
  saveData(); render();
}
function deleteProduct(id){
  state.products = state.products.filter(p=>p.id!==id);
  saveData(); render();
}
function addEntry(productId, {date, label, qty, pau}){
  const p = state.products.find(p=>p.id===productId);
  p.entries.push({ id:uid(), seq: settings.seq, date, label: label||'Entrée stock', qty:+qty, pau:+pau });
  recomputeProduct(p); saveData(); render();
}
function addExit(productId, {date, label, qty}){
  const p = state.products.find(p=>p.id===productId);
  if(qty > p._stock.qty + 1e-9){ toast('Quantité supérieure au stock disponible'); return false; }
  p.exits.push({ id:uid(), seq: settings.seq, date, label: label||'Sortie stock', qty:+qty });
  recomputeProduct(p); saveData(); render(); return true;
}
function addSale(productId, {date, designation, qty, margeB, tva}){
  const p = state.products.find(p=>p.id===productId);
  if(qty > p._stock.qty + 1e-9){ toast('Stock insuffisant pour cette vente'); return false; }
  const exitId = uid();
  p.exits.push({ id:exitId, seq: settings.seq, date, label:'Vente : '+(designation||''), qty:+qty });
  p.sales.push({ id:uid(), seq: settings.seq, date, designation: designation||p.name, qty:+qty, margeB:+margeB, tva:+tva, exitId });
  recomputeProduct(p); saveData(); render(); return true;
}
function deleteMove(productId, kind, id){
  const p = state.products.find(p=>p.id===productId);
  if(kind==='entry') p.entries = p.entries.filter(e=>e.id!==id);
  if(kind==='exit'){ p.exits = p.exits.filter(e=>e.id!==id); p.sales = p.sales.filter(s=>s.exitId!==id); }
  if(kind==='sale'){ const s = p.sales.find(s=>s.id===id); if(s){ p.exits = p.exits.filter(e=>e.id!==s.exitId); } p.sales = p.sales.filter(s=>s.id!==id); }
  recomputeProduct(p); saveData(); render();
}

/* =========================================================
   HELPERS AFFICHAGE
========================================================= */
function money(n){ return (isFinite(n)?n:0).toLocaleString('fr-FR',{minimumFractionDigits:0, maximumFractionDigits:0}) + ' ' + settings.currency; }
function num(n, d=2){ return (isFinite(n)?n:0).toLocaleString('fr-FR',{minimumFractionDigits:d, maximumFractionDigits:d}); }
function fdate(iso){ if(!iso) return '—'; const d = new Date(iso); return d.toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit',year:'2-digit'}); }
function today(){ return new Date().toISOString().slice(0,10); }
function toast(msg){
  const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(window._toastTimer); window._toastTimer = setTimeout(()=>t.classList.remove('show'), 2200);
}
function esc(s){ return (s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* =========================================================
   NAVIGATION
========================================================= */
function setTab(tab, productId){
  currentTab = tab;
  if(productId !== undefined) currentProductId = productId;
  document.querySelectorAll('.tab').forEach(b=> b.classList.toggle('active', b.dataset.tab===tab));
  render();
}

/* =========================================================
   RENDU DES VUES
========================================================= */
function render(){
  const titles = {
    dashboard:['Tableau de bord',"Vue d'ensemble de l'activité"],
    products:['Produits','Catalogue et stocks courants'],
    stock:['Stock','Entrées, sorties &amp; PMP'],
    sales:['Ventes','Facturation &amp; marges']
  };
  document.getElementById('page-title').innerHTML = titles[currentTab][0];
  document.getElementById('page-sub').innerHTML = titles[currentTab][1];
  document.getElementById('eyebrow-date').textContent = new Date().toLocaleDateString('fr-FR',{weekday:'long', day:'numeric', month:'long'});

  const view = document.getElementById('view');
  if(currentTab==='dashboard') view.innerHTML = renderDashboard();
  else if(currentTab==='products') view.innerHTML = renderProducts();
  else if(currentTab==='stock') view.innerHTML = renderStock();
  else if(currentTab==='sales') view.innerHTML = renderSales();

  document.querySelectorAll('.fab').forEach(f=>f.remove());
  if(currentTab==='products'){
    const fab = document.createElement('button');
    fab.className='fab'; fab.innerHTML='+'; fab.onclick=()=>openProductModal();
    document.getElementById('app').appendChild(fab);
  }
}

function renderDashboard(){
  let totalValue=0, totalCA=0, totalResultat=0, totalMouvements=0;
  state.products.forEach(p=>{
    totalValue += p._stock.value;
    p.sales.forEach(s=>{ totalCA += s.pvt; totalResultat += s.resultat; });
    totalMouvements += p.entries.length + p.exits.length;
  });

  const recent = [];
  state.products.forEach(p=>{
    const tag = p.reference ? `${p.reference} — ` : '';
    p.entries.forEach(e=> recent.push({type:'in', date:e.date, seq:e.seq, prod:tag+p.name, label:e.label, qty:e.qty, amount:e.pat}));
    p.exits.forEach(x=>{ if(!p.sales.find(s=>s.exitId===x.id)) recent.push({type:'out', date:x.date, seq:x.seq, prod:tag+p.name, label:x.label, qty:x.qty, amount:x.pat}); });
    p.sales.forEach(s=> recent.push({type:'sale', date:s.date, seq:s.seq, prod:tag+p.name, label:'Vente : '+s.designation, qty:s.qty, amount:s.pvt}));
  });
  recent.sort((a,b)=> (b.date||'').localeCompare(a.date||'') || b.seq-a.seq);
  const top = recent.slice(0,8);

  if(state.products.length===0){
    return emptyState('📊',"Aucune donnée pour l'instant","Ajoute un premier produit dans l'onglet « Produits » pour démarrer le suivi de stock et de ventes.",'products');
  }

  return `
    <div class="kpi-grid">
      <div class="kpi gold"><div class="label">Valeur du stock</div><div class="value">${money(totalValue)}</div></div>
      <div class="kpi green"><div class="label">Chiffre d'affaires</div><div class="value">${money(totalCA)}</div></div>
      <div class="kpi ${totalResultat>=0?'green':'rust'}"><div class="label">Résultat net</div><div class="value">${money(totalResultat)}</div></div>
      <div class="kpi"><div class="label">Produits suivis</div><div class="value">${state.products.length}</div></div>
    </div>
    <h2 class="section-title">Activité récente</h2>
    ${top.length? top.map(r=>`
      <div class="ticket">
        <div class="row">
          <div>
            <span class="pill ${r.type==='in'?'in':r.type==='out'?'out':'sale'}">${r.type==='in'?'ENTRÉE':r.type==='out'?'SORTIE':'VENTE'}</span>
            <div style="margin-top:8px; font-weight:600; font-size:14px;">${esc(r.prod)}</div>
            <div class="prod-meta">${esc(r.label)} · ${fdate(r.date)}</div>
          </div>
          <div style="text-align:right;">
            <div class="prod-pmp"><span class="qty">${r.type==='out'?'-':'+'}${num(r.qty,0)}</span></div>
            <div class="prod-meta">${money(r.amount)}</div>
          </div>
        </div>
      </div>`).join('') : '<div class="empty"><p>Aucun mouvement enregistré.</p></div>'}
  `;
}

function renderProducts(){
  if(state.products.length===0){
    return emptyState('📦','Aucun produit','Crée ton premier article : choisis sa famille, sa référence est générée automatiquement.', null, true);
  }
  const filtered = currentFamilyFilter==='all' ? state.products : state.products.filter(p=>p.familyId===currentFamilyFilter);
  const filterBar = `
    <div class="scroll-x" style="margin-bottom:14px;">
      <div class="segmented" style="display:inline-flex; width:auto;">
        <button class="${currentFamilyFilter==='all'?'active':''}" onclick="currentFamilyFilter='all'; render();">Toutes</button>
        ${state.families.map(f=>`<button class="${currentFamilyFilter===f.id?'active':''}" onclick="currentFamilyFilter='${f.id}'; render();">${esc(f.code)}</button>`).join('')}
      </div>
    </div>
    <div class="row" style="margin-bottom:14px;">
      <a class="link-btn" onclick="openFamiliesModal()">⚙️ Gérer les familles de produits</a>
    </div>`;
  const list = filtered.length ? filtered.map(p=>`
    <div class="prod-item" onclick="openProduct('${p.id}')">
      <div>
        <div class="prod-name">${esc(p.name)}</div>
        <div class="prod-meta"><span class="pill" style="background:var(--surface-3); color:var(--gold);">${esc(p.reference||'—')}</span> · ${esc(familyLabel(p.familyId))}</div>
        <div class="prod-meta">${p.entries.length} entrée(s) · ${p.exits.length} sortie(s) · ${p.sales.length} vente(s)</div>
      </div>
      <div class="prod-pmp">
        <div class="qty">${num(p._stock.qty,0)} ${esc(p.unit)}</div>
        <div class="lbl">PMP ${money(p._stock.pmp)}</div>
      </div>
    </div>
  `).join('') : '<div class="empty"><p>Aucun produit dans cette famille.</p></div>';
  return filterBar + list;
}

function openProduct(id){ currentProductId = id; setTab('stock', id); }

function productPicker(actionLabel){
  if(state.products.length===0) return '';
  return `
    <div class="field">
      <label>Produit</label>
      <select id="picker-product" onchange="currentProductId=this.value; render();">
        ${state.products.map(p=>`<option value="${p.id}" ${p.id===currentProductId?'selected':''}>${esc(p.reference||'—')} — ${esc(p.name)}</option>`).join('')}
      </select>
    </div>`;
}

function renderStock(){
  if(state.products.length===0) return emptyState('📦','Aucun produit',"Ajoute d'abord un produit dans l'onglet « Produits ».", null, true);
  if(!currentProductId || !state.products.find(p=>p.id===currentProductId)) currentProductId = state.products[0].id;
  const p = state.products.find(p=>p.id===currentProductId);

  const moves = [];
  p.entries.forEach(e=> moves.push({...e, kind:'entry'}));
  p.exits.forEach(x=> moves.push({...x, kind:'exit'}));
  moves.sort((a,b)=> (b.date||'').localeCompare(a.date||'') || b.seq-a.seq);

  return `
    ${productPicker()}
    <div class="row" style="margin:-4px 0 14px;">
      <span class="pill" style="background:var(--surface-3); color:var(--gold);">${esc(p.reference||'—')}</span>
      <span class="prod-meta">${esc(familyLabel(p.familyId))}</span>
    </div>
    <div class="kpi-grid">
      <div class="kpi"><div class="label">Stock actuel</div><div class="value">${num(p._stock.qty,0)} ${esc(p.unit)}</div></div>
      <div class="kpi gold"><div class="label">PMP</div><div class="value">${money(p._stock.pmp)}</div></div>
    </div>
    <div class="btn-row" style="margin-bottom:18px;">
      <button class="btn btn-gold" onclick="openEntryModal('${p.id}')">+ Entrée</button>
      <button class="btn btn-ghost" onclick="openExitModal('${p.id}')">− Sortie</button>
    </div>
    <h2 class="section-title">Historique des mouvements</h2>
    ${moves.length ? moves.map(m=>`
      <div class="ticket">
        <div class="row">
          <div>
            <span class="pill ${m.kind==='entry'?'in':'out'}">${m.kind==='entry'?'ENTRÉE':'SORTIE'}</span>
            <div style="margin-top:8px; font-weight:600; font-size:14px;">${esc(m.label)}</div>
            <div class="prod-meta">${fdate(m.date)} · PAU ${money(m.pau)} · Solde après : ${num(m.soldeQty,0)} ${esc(p.unit)}</div>
          </div>
          <div style="text-align:right;">
            <div class="prod-pmp"><span class="qty">${m.kind==='exit'?'-':'+'}${num(m.qty,0)}</span></div>
            <div class="prod-meta">${money(m.pat)}</div>
            <button class="btn btn-sm btn-danger" style="margin-top:8px;" onclick="event.stopPropagation(); if(confirm('Supprimer ce mouvement ?')) deleteMove('${p.id}','${m.kind}','${m.id}')">Suppr.</button>
          </div>
        </div>
      </div>`).join('') : '<div class="empty"><p>Aucun mouvement pour ce produit.</p></div>'}
  `;
}

function renderSales(){
  if(state.products.length===0) return emptyState('🧾','Aucun produit',"Ajoute d'abord un produit dans l'onglet « Produits ».", null, true);
  if(!currentProductId || !state.products.find(p=>p.id===currentProductId)) currentProductId = state.products[0].id;
  const p = state.products.find(p=>p.id===currentProductId);
  const sales = [...p.sales].sort((a,b)=> (b.date||'').localeCompare(a.date||'') || b.seq-a.seq);

  let ca=0, resultat=0;
  p.sales.forEach(s=>{ ca+=s.pvt; resultat+=s.resultat; });

  return `
    ${productPicker()}
    <div class="row" style="margin:-4px 0 14px;">
      <span class="pill" style="background:var(--surface-3); color:var(--gold);">${esc(p.reference||'—')}</span>
      <span class="prod-meta">${esc(familyLabel(p.familyId))}</span>
    </div>
    <div class="kpi-grid">
      <div class="kpi green"><div class="label">CA produit</div><div class="value">${money(ca)}</div></div>
      <div class="kpi ${resultat>=0?'green':'rust'}"><div class="label">Résultat</div><div class="value">${money(resultat)}</div></div>
    </div>
    <button class="btn btn-gold" style="margin-bottom:18px;" onclick="openSaleModal('${p.id}')">+ Nouvelle vente</button>
    <h2 class="section-title">Historique des ventes</h2>
    ${sales.length ? sales.map(s=>`
      <div class="ticket">
        <div class="row">
          <div>
            <span class="pill sale">VENTE</span>
            <div style="margin-top:8px; font-weight:600; font-size:14px;">${esc(s.designation)}</div>
            <div class="prod-meta">${fdate(s.date)} · ${num(s.qty,0)} ${esc(p.unit)} · PMP ${money(s.pmp)} · marge ${s.margeB}% · TVA ${s.tva}%</div>
          </div>
          <div style="text-align:right;">
            <div class="prod-pmp"><span class="qty" style="color:var(--green)">${money(s.pvt)}</span></div>
            <div class="prod-meta">Résultat ${money(s.resultat)}</div>
            <button class="btn btn-sm btn-danger" style="margin-top:8px;" onclick="event.stopPropagation(); if(confirm('Supprimer cette vente ?')) deleteMove('${p.id}','sale','${s.id}')">Suppr.</button>
          </div>
        </div>
      </div>`).join('') : '<div class="empty"><p>Aucune vente enregistrée pour ce produit.</p></div>'}
  `;
}

function emptyState(icon,title,text,goTab,showAddBtn){
  return `
    <div class="empty">
      <div class="icon">${icon}</div>
      <h3 style="color:var(--text); margin:0 0 8px;">${title}</h3>
      <p>${text}</p>
      ${showAddBtn? '<button class="btn btn-gold" style="width:auto; padding:12px 22px;" onclick="openProductModal()">+ Ajouter un produit</button>' : (goTab? `<button class="btn btn-gold" style="width:auto; padding:12px 22px;" onclick="setTab('${goTab}')">Aller à ${goTab}</button>` : '')}
    </div>`;
}

/* =========================================================
   MODALES (sheets)
========================================================= */
function closeModal(){ document.getElementById('modal-root').innerHTML=''; }

function openProductModal(){
  if(state.families.length===0){
    toast("Crée d'abord une famille de produits");
    openFamiliesModal();
    return;
  }
  document.getElementById('modal-root').innerHTML = `
    <div class="overlay" onclick="if(event.target===this) closeModal()">
      <div class="sheet">
        <button class="close-x" onclick="closeModal()">✕</button>
        <h3>Nouveau produit</h3>
        <p class="sheet-sub">Crée un article à suivre en stock et en vente. Sa référence est générée automatiquement à partir de la famille choisie.</p>
        <div class="field">
          <label>Famille de produits</label>
          <select id="f-family">
            ${state.families.map(f=>`<option value="${f.id}">${esc(f.code)} — ${esc(f.name)}</option>`).join('')}
          </select>
          <div class="helper" id="f-ref-preview">Référence : ${esc(state.families[0].code)}-${String((state.families[0].seq||0)+1).padStart(3,'0')}</div>
        </div>
        <div class="field"><label>Nom de l'article</label><input id="f-name" type="text" placeholder="Ex : Sac de riz 25kg" autofocus></div>
        <div class="field"><label>Unité</label><input id="f-unit" type="text" placeholder="Ex : pièce, kg, carton" value="pièce"></div>
        <button class="btn btn-gold" onclick="submitProduct()">Ajouter le produit</button>
      </div>
    </div>`;
  document.getElementById('f-family').addEventListener('change', updateRefPreview);
}
function updateRefPreview(){
  const f = getFamily(document.getElementById('f-family').value);
  if(!f) return;
  document.getElementById('f-ref-preview').textContent = `Référence : ${f.code}-${String((f.seq||0)+1).padStart(3,'0')}`;
}
function submitProduct(){
  const name = document.getElementById('f-name').value.trim();
  if(!name){ toast("Indique un nom d'article"); return; }
  const unit = document.getElementById('f-unit').value;
  const familyId = document.getElementById('f-family').value;
  addProduct(name, unit, familyId);
  closeModal();
  toast('Produit ajouté');
}

/* ---- Gestion des familles de produits ---- */
function openFamiliesModal(){
  document.getElementById('modal-root').innerHTML = `
    <div class="overlay" onclick="if(event.target===this) closeModal()">
      <div class="sheet">
        <button class="close-x" onclick="closeModal()">✕</button>
        <h3>Familles de produits</h3>
        <p class="sheet-sub">Chaque famille possède un code (ex. F1) qui préfixe la référence de ses produits.</p>
        <div id="families-list">
          ${state.families.map(f=>`
            <div class="row" style="padding:10px 0; border-bottom:1px solid var(--border);">
              <div>
                <div style="font-weight:600; font-family:var(--mono); color:var(--gold);">${esc(f.code)}</div>
                <div class="prod-meta">${esc(f.name)}</div>
              </div>
              <button class="btn btn-sm btn-danger" onclick="if(confirm('Supprimer cette famille ?')) { deleteFamily('${f.id}'); openFamiliesModal(); }">Suppr.</button>
            </div>`).join('')}
        </div>
        <h3 style="margin-top:20px; font-size:14px;">Ajouter une famille</h3>
        <div class="field-row">
          <div class="field" style="flex:0 0 90px;"><label>Code</label><input id="nf-code" type="text" placeholder="${esc(nextFamilyCode())}"></div>
          <div class="field"><label>Nom</label><input id="nf-name" type="text" placeholder="Ex : Produits d'entretien"></div>
        </div>
        <button class="btn btn-ghost" onclick="submitFamily()">+ Ajouter la famille</button>
      </div>
    </div>`;
}
function submitFamily(){
  const name = document.getElementById('nf-name').value.trim();
  if(!name){ toast('Indique un nom de famille'); return; }
  const code = document.getElementById('nf-code').value.trim();
  addFamily(name, code);
  openFamiliesModal();
  toast('Famille ajoutée');
}

function openEntryModal(productId){
  document.getElementById('modal-root').innerHTML = `
    <div class="overlay" onclick="if(event.target===this) closeModal()">
      <div class="sheet">
        <button class="close-x" onclick="closeModal()">✕</button>
        <h3>Entrée de stock</h3>
        <p class="sheet-sub">Réception de marchandise (achat, réappro...).</p>
        <div class="field-row">
          <div class="field"><label>Date</label><input id="f-date" type="date" value="${today()}"></div>
          <div class="field"><label>Quantité</label><input id="f-qty" type="number" min="0" step="any" placeholder="0"></div>
        </div>
        <div class="field"><label>Libellé</label><input id="f-label" type="text" placeholder="Ex : Facture N°12"></div>
        <div class="field"><label>Prix d'achat unitaire (P.A.U.)</label><input id="f-pau" type="number" min="0" step="any" placeholder="0.00"></div>
        <button class="btn btn-gold" onclick="submitEntry('${productId}')">Enregistrer l'entrée</button>
      </div>
    </div>`;
}
function submitEntry(productId){
  const qty = parseFloat(document.getElementById('f-qty').value);
  const pau = parseFloat(document.getElementById('f-pau').value);
  if(!qty || qty<=0){ toast('Quantité invalide'); return; }
  if(isNaN(pau) || pau<0){ toast("Prix d'achat invalide"); return; }
  addEntry(productId, { date:document.getElementById('f-date').value, label:document.getElementById('f-label').value, qty, pau });
  closeModal(); toast('Entrée enregistrée');
}

function openExitModal(productId){
  document.getElementById('modal-root').innerHTML = `
    <div class="overlay" onclick="if(event.target===this) closeModal()">
      <div class="sheet">
        <button class="close-x" onclick="closeModal()">✕</button>
        <h3>Sortie de stock</h3>
        <p class="sheet-sub">Sortie hors vente (perte, casse, usage interne...). Pour une vente, utilise l'onglet Ventes.</p>
        <div class="field-row">
          <div class="field"><label>Date</label><input id="f-date" type="date" value="${today()}"></div>
          <div class="field"><label>Quantité</label><input id="f-qty" type="number" min="0" step="any" placeholder="0"></div>
        </div>
        <div class="field"><label>Libellé</label><input id="f-label" type="text" placeholder="Ex : Casse, don, usage interne"></div>
        <button class="btn btn-gold" onclick="submitExit('${productId}')">Enregistrer la sortie</button>
      </div>
    </div>`;
}
function submitExit(productId){
  const qty = parseFloat(document.getElementById('f-qty').value);
  if(!qty || qty<=0){ toast('Quantité invalide'); return; }
  const ok = addExit(productId, { date:document.getElementById('f-date').value, label:document.getElementById('f-label').value, qty });
  if(ok!==false){ closeModal(); toast('Sortie enregistrée'); }
}

function openSaleModal(productId){
  const p = state.products.find(p=>p.id===productId);
  document.getElementById('modal-root').innerHTML = `
    <div class="overlay" onclick="if(event.target===this) closeModal()">
      <div class="sheet">
        <button class="close-x" onclick="closeModal()">✕</button>
        <h3>Nouvelle vente</h3>
        <p class="sheet-sub">Stock disponible : ${num(p._stock.qty,0)} ${esc(p.unit)} · PMP ${money(p._stock.pmp)}</p>
        <div class="field-row">
          <div class="field"><label>Date</label><input id="f-date" type="date" value="${today()}"></div>
          <div class="field"><label>Quantité</label><input id="f-qty" type="number" min="0" step="any" placeholder="0"></div>
        </div>
        <div class="field"><label>Désignation (n° facture...)</label><input id="f-desig" type="text" placeholder="Ex : Facture n°3" value="${esc(p.name)}"></div>
        <div class="field-row">
          <div class="field"><label>Marge brute (%)</label><input id="f-marge" type="number" min="0" step="any" value="80"></div>
          <div class="field"><label>TVA (%)</label><input id="f-tva" type="number" min="0" step="any" value="${settings.tva}"></div>
        </div>
        <div class="helper">Prix de vente = PMP × (1 + marge). Résultat = PVT − coût de sortie stock.</div>
        <button class="btn btn-gold" style="margin-top:16px;" onclick="submitSale('${productId}')">Enregistrer la vente</button>
      </div>
    </div>`;
}
function submitSale(productId){
  const qty = parseFloat(document.getElementById('f-qty').value);
  if(!qty || qty<=0){ toast('Quantité invalide'); return; }
  const margeB = parseFloat(document.getElementById('f-marge').value) || 0;
  const tva = parseFloat(document.getElementById('f-tva').value) || 0;
  const ok = addSale(productId, { date:document.getElementById('f-date').value, designation:document.getElementById('f-desig').value, qty, margeB, tva });
  if(ok!==false){ closeModal(); toast('Vente enregistrée'); }
}

/* =========================================================
   INIT
========================================================= */

loadData();
recomputeAll();
document.querySelector('.tab[data-tab="dashboard"]').classList.add('active');
render();
