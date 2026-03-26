// ═══════════════════════════════════════════════════════
//  Equipment Checkout v1.1
//  CONSTANTS & STATE
// ═══════════════════════════════════════════════════════

const STORE = 'pennco-v3';
const STORE_SHADOW = 'pennco-v3-shadow';
const STORE_META   = 'pennco-v3-meta';
const BACKUP_INTERVAL_DAYS = 7;

const TYPE = {
  reader:  { label:'Reader',         plural:'Readers',        icon:'🪪', pfx:'RDR' },
  hotspot: { label:'Mobile Hotspot', plural:'Mobile Hotspots',icon:'📶', pfx:'HSP' },
  charger: { label:'Charger Set',    plural:'Charger Sets',   icon:'🔌', pfx:'CHG' },
};

// State:
//  equipment: [{id, type, number, status:'avail'|'out', current:null|{rentalId,event,org,coDate,retDate,coTime}, history:[]}]
//  rentals:   [{id, items:[itemId,...], event, org, coDate, retDate, coTime, actualDate|null, ciTime|null, closed}]
//  seq:       {reader:N, hotspot:N, charger:N}

let S = load();
let byId = new Map();
let rentalById = new Map();
function rebuildIndex() {
  byId = new Map(S.equipment.map(e => [e.id, e]));
  rentalById = new Map(S.rentals.map(r => [r.id, r]));
}
rebuildIndex();
let selected = new Set();   // item ids selected for batch checkout
let ciItemId = null;        // item being checked in
let ciRentalId = null;
let activeFilter = 'all';
let ciMode = 'single';      // 'single' or 'batch' for check-in modal
let ciBatchItems = [];       // items being returned in batch mode
let _pruning = false;        // recursion guard for storage health checks

// ═══════════════════════════════════════════════════════
//  PERSISTENCE
// ═══════════════════════════════════════════════════════

function load() {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) return JSON.parse(raw);
  } catch(e) {}
  return { equipment:[], rentals:[], seq:{reader:1,hotspot:1,charger:1} };
}

function save() {
  rebuildIndex();
  const serialized = JSON.stringify(S);
  try {
    localStorage.setItem(STORE, serialized);
    localStorage.setItem(STORE_SHADOW, serialized);
  } catch (e) {
    // QuotaExceededError — force prune and retry
    pruneOldData(2);
    const pruned = JSON.stringify(S);
    try {
      localStorage.setItem(STORE, pruned);
      localStorage.setItem(STORE_SHADOW, pruned);
    } catch (e2) {
      toast('Storage is full. Please export a backup and clear old data.', 'err');
    }
  }
  if (!_pruning) checkStorageHealth();
}

function loadMeta() {
  try { return JSON.parse(localStorage.getItem(STORE_META)) || {}; } catch(e) { return {}; }
}

function saveMeta(patch) {
  const m = { ...loadMeta(), ...patch };
  localStorage.setItem(STORE_META, JSON.stringify(m));
}

// ═══════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════

function uid() { return crypto.randomUUID(); }

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Full ISO timestamp for recording when actions occur
function nowISO() { return new Date().toISOString(); }

function fmtDate(s) {
  if (!s) return '—';
  const [y,m,d] = s.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[+m-1]} ${+d}, ${y}`;
}

// Format ISO timestamp to readable time (e.g. "2:35 PM")
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
}

// Format ISO timestamp to date + time (e.g. "Mar 24, 2026 at 2:35 PM")
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return fmtDate(iso); // fallback for plain date strings
  return d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
    + ' at ' + d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
}

function isOverdue(retDate) {
  if (!retDate) return false;
  return retDate < today();
}

function itemLabel(item) {
  return `${TYPE[item.type].pfx}-${item.number}`;
}

function statusOf(item) {
  if (item.status === 'avail') return 'ok';
  return (item.current && isOverdue(item.current.retDate)) ? 'ov' : 'out';
}

function statusLabel(st) {
  return st === 'ok' ? 'Available' : st === 'ov' ? 'Overdue' : 'Checked Out';
}

function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g, '&#39;');
}

const MAX_EVENT_LEN = 120;
const MAX_ORG_LEN = 120;
const MAX_NOTE_LEN = 80;
const VALID_TYPES = new Set(Object.keys(TYPE));

function cleanText(v, maxLen) {
  return String(v ?? '').trim().slice(0, maxLen);
}

function normalizeDate(v) {
  const s = String(v ?? '');
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function normalizeIso(v) {
  const s = String(v ?? '');
  return s && !isNaN(new Date(s)) ? new Date(s).toISOString() : null;
}

function storageUsage() {
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    total += key.length + localStorage.getItem(key).length;
  }
  // UTF-16 = 2 bytes per char; 5MB is the common localStorage limit
  return { used: total * 2, limit: 5 * 1024 * 1024, pct: (total * 2) / (5 * 1024 * 1024) };
}

function pruneOldData(monthsToKeep) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsToKeep);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  // Trim item history entries older than cutoff
  S.equipment.forEach(item => {
    item.history = item.history.filter(h => h.coDate >= cutoffStr || h.actualDate >= cutoffStr);
  });

  // Strip snapshots from old closed rentals (keep the record itself for history)
  S.rentals.forEach(rental => {
    if (rental.closed && rental.coDate < cutoffStr) {
      rental.snapshots = null;
      rental.pruned = true;
    }
  });
}

function checkStorageHealth() {
  const { pct } = storageUsage();
  if (pct >= 0.95) {
    pruneOldData(2);
    _pruning = true; save(); _pruning = false;
    renderStorageBanner();
  } else if (pct >= 0.90) {
    exportJSON();
    pruneOldData(6);
    _pruning = true; save(); _pruning = false;
    renderStorageBanner();
  } else if (pct >= 0.80) {
    renderStorageBanner();
  } else {
    clearStorageBanner();
  }
}

function renderStorageBanner() {
  const el = document.getElementById('storageBanner');
  if (!el) return;
  const { pct } = storageUsage();
  if (pct < 0.80) { el.innerHTML = ''; return; }
  const level = pct >= 0.90 ? 'red' : 'amber';
  const pctDisplay = Math.round(pct * 100);
  const msg = pct >= 0.90
    ? `Storage is <strong>${pctDisplay}% full.</strong> Old data has been pruned automatically.`
    : `Storage is <strong>${pctDisplay}% full.</strong> Consider exporting a backup.`;
  el.innerHTML = `<div class="storage-banner ${level}">
    <div class="bb-left">
      <span class="bb-icon">${level === 'red' ? '🔴' : '🟡'}</span>
      <span class="bb-text">${msg}</span>
    </div>
    <div class="bb-btns">
      <button class="btn btn-sm btn-ghost" data-action="export-backup">Export Backup</button>
    </div>
  </div>`;
}

function clearStorageBanner() {
  const el = document.getElementById('storageBanner');
  if (el) el.innerHTML = '';
}

function saveNote(id, val) {
  const item = byId.get(id);
  if (!item) return;
  item.note = val.trim();
  save();
  // No full render needed — just update sidebar chips tooltip silently
  renderSidebar();
}

// ═══════════════════════════════════════════════════════
//  EQUIPMENT MANAGEMENT
// ═══════════════════════════════════════════════════════

function addUnit(type) {
  // Find lowest positive integer not currently in use for this type
  const used = new Set(S.equipment.filter(e=>e.type===type).map(e=>e.number));
  let num = 1;
  while (used.has(num)) num++;
  S.equipment.push({ id:uid(), type, number:num, note:'', status:'avail', current:null, history:[] });
  save(); render();
}

function removeUnit(id) {
  const item = byId.get(id);
  if (!item) return;
  if (item.status === 'out') { toast('Cannot delete — item is currently checked out.','err'); return; }
  const lbl = itemLabel(item);
  confirm2(`Delete ${lbl}?`, `This will permanently remove ${lbl} from inventory. This cannot be undone.`, ()=>{
    S.equipment = S.equipment.filter(e=>e.id!==id);
    selected.delete(id);
    save(); render();
    toast(`${lbl} removed from inventory.`,'ok');
  });
}

// ═══════════════════════════════════════════════════════
//  SELECTION
// ═══════════════════════════════════════════════════════

function toggleSelect(id) {
  const item = byId.get(id);
  if (!item || item.status !== 'avail') return;
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  renderActionBar(); renderGrids();
}

function clearSelection() { selected.clear(); renderActionBar(); renderGrids(); }

// ═══════════════════════════════════════════════════════
//  CHECKOUT FLOW
// ═══════════════════════════════════════════════════════

function openCheckout() {
  if (selected.size === 0) return;
  // Populate item list in modal
  const items = [...selected].map(id => byId.get(id)).filter(Boolean);
  const listHtml = items.map(it => `
    <div class="co-item-row">
      <span class="tag">${itemLabel(it)}</span>
      <span>${TYPE[it.type].label}</span>
    </div>`).join('');
  document.getElementById('coItemList').innerHTML = listHtml;
  document.getElementById('coSub').textContent = `${items.length} item${items.length>1?'s':''} selected for checkout`;
  // Pre-fill today
  document.getElementById('fCoDate').value = today();
  document.getElementById('fRetDate').value = '';
  document.getElementById('fEvent').value = '';
  document.getElementById('fOrg').value = '';
  clearErrors();
  openModal('oCO');
}

function confirmCheckout() {
  const event   = v('fEvent').trim();
  const org     = v('fOrg').trim();
  const coDate  = v('fCoDate');
  const retDate = v('fRetDate');
  let ok = true;
  if (!event)  { showErr('eEvent'); ok=false; }
  if (!org)    { showErr('eOrg');   ok=false; }
  if (!coDate) { showErr('eCo');    ok=false; }
  if (!retDate){ showErr('eRet');   ok=false; }
  if (retDate && coDate && retDate < coDate) { showErr('eRet',true,'Return date must be after checkout date.'); ok=false; }
  if (!ok) return;

  const rentalId = uid();
  const itemIds = [...selected];
  const coTime = nowISO(); // record exact checkout timestamp
  // Snapshot label and note at moment of checkout — survives device renaming/replacement
  const snapshots = itemIds.map(id => {
    const item = byId.get(id);
    return { id, label: itemLabel(item), note: item.note||'' };
  });
  S.rentals.push({ id:rentalId, items:itemIds, snapshots, event, org, coDate, retDate, coTime, actualDate:null, ciTime:null, closed:false });
  itemIds.forEach(id => {
    const item = byId.get(id);
    item.status = 'out';
    item.current = { rentalId, event, org, coDate, retDate, coTime };
  });
  save();
  selected.clear();
  closeModal('oCO');
  render();
  toast(`${itemIds.length} item${itemIds.length>1?'s':''} checked out for "${event}".`,'ok');
}

// ═══════════════════════════════════════════════════════
//  CHECKIN FLOW
// ═══════════════════════════════════════════════════════

function openCheckin(itemId) {
  const item = byId.get(itemId);
  if (!item || !item.current) return;
  ciMode = 'single';
  ciItemId = itemId;
  ciRentalId = item.current.rentalId;
  const rental = rentalById.get(ciRentalId);

  // Show all items in this rental — use snapshots for historical accuracy
  const sibLines = (rental.snapshots || rental.items.map(id=>{
    const it = byId.get(id);
    return it ? { label:itemLabel(it), note:it.note||'' } : { label:id, note:'' };
  })).map(s=>`<b>${escHtml(s.label)}</b>${s.note ? ' — ' + escHtml(s.note) : ''}`).join('<br>');

  const coTimeStr = rental.coTime ? ` at ${fmtTime(rental.coTime)}` : '';
  document.getElementById('ciSub').textContent = `Returning item from: ${item.current.event}`;
  document.getElementById('ciBox').innerHTML = `
    <div><span class="dl">Event:</span> <span class="dv">${escHtml(rental.event)}</span></div>
    <div><span class="dl">Org:</span> <span class="dv">${escHtml(rental.org)}</span></div>
    <div><span class="dl">Out:</span> <span class="dv">${fmtDate(rental.coDate)}${coTimeStr}</span></div>
    <div><span class="dl">Due:</span> <span class="dv">${fmtDate(rental.retDate)}</span></div>
    <div style="margin-top:6px;font-size:11px;color:var(--s400)">Rental includes: ${sibLines}</div>`;

  document.getElementById('fActual').value = today();
  document.getElementById('eActual').classList.remove('show');
  openModal('oCI');
}

function confirmCheckin() {
  const actual = v('fActual');
  if (!actual) { showErr('eActual'); return; }

  // Batch return (Return All for event)
  if (ciMode === 'batch') {
    let lateCount = 0;
    const ciTime = nowISO(); // record exact check-in timestamp
    ciBatchItems.forEach(item => {
      const rental = rentalById.get(item.current.rentalId);
      if (actual > item.current.retDate) lateCount++;
      item.history.push({ ...item.current, actualDate: actual, ciTime });
      item.status = 'avail';
      item.current = null;
      if (rental) {
        const allReturned = rental.items.every(id => {
          const it = byId.get(id);
          return it && it.status === 'avail';
        });
        if (allReturned) { rental.closed = true; rental.actualDate = actual; rental.ciTime = ciTime; }
      }
    });
    save(); closeModal('oCI'); render();
    const n = ciBatchItems.length;
    toast(`${n} item${n > 1 ? 's' : ''} returned${lateCount ? ` (${lateCount} late)` : ''}.`, lateCount ? 'err' : 'ok');
    ciBatchItems = [];
    ciMode = 'single';
    return;
  }

  // Single item return
  const item = byId.get(ciItemId);
  const rental = rentalById.get(ciRentalId);
  const ciTime = nowISO(); // record exact check-in timestamp

  // Add to item history, clear current
  item.history.push({ ...item.current, actualDate:actual, ciTime });
  item.status = 'avail';
  item.current = null;

  // If all items in this rental are returned, close it
  const allReturned = rental.items.every(id => {
    const it = byId.get(id);
    return it && it.status === 'avail';
  });
  if (allReturned) {
    rental.closed = true;
    rental.actualDate = actual;
    rental.ciTime = ciTime;
  }

  save(); closeModal('oCI'); render();
  const wasLate = actual > rental.retDate;
  toast(`${itemLabel(item)} returned${wasLate?' (late)':''}.`, wasLate?'err':'ok');
}

function returnAllForRental(rentalId) {
  const outItems = S.equipment.filter(e => e.status === 'out' && e.current && e.current.rentalId === rentalId);
  if (!outItems.length) return;
  const rental = rentalById.get(rentalId);
  if (!rental) return;

  ciMode = 'batch';
  ciBatchItems = outItems;

  // Build combined item list
  const itemLines = outItems.map(it =>
    `<b>${escHtml(itemLabel(it))}</b>${it.note ? ' — ' + escHtml(it.note) : ''}`
  ).join('<br>');

  const eventName = rental.event;
  const org = rental.org || '';

  document.getElementById('ciSub').textContent = `Returning all items for: ${eventName}`;
  document.getElementById('ciBox').innerHTML = `
    <div><span class="dl">Event:</span> <span class="dv">${escHtml(eventName)}</span></div>
    ${org ? `<div><span class="dl">Org:</span> <span class="dv">${escHtml(org)}</span></div>` : ''}
    <div style="margin-top:6px;font-size:11px;color:var(--s400)">Items to return (${outItems.length}):<br>${itemLines}</div>`;

  document.getElementById('fActual').value = today();
  document.getElementById('eActual').classList.remove('show');
  openModal('oCI');
}

// ═══════════════════════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════════════════════

function render() {
  renderHeader();
  renderSidebar();
  renderStats();
  renderOverdue();
  renderActionBar();
  renderGrids();
  renderHistory();
}

function renderHeader() {
  const d = new Date();
  document.getElementById('hDate').textContent =
    d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'});
}

function renderSidebar() {
  const html = Object.entries(TYPE).map(([type, meta]) => {
    const items = S.equipment.filter(e=>e.type===type);
    if (items.length === 0) {
      return `<div class="sb-type">
        <div class="sb-type-hd">
          <span class="sb-type-name"><span class="sb-icon">${meta.icon}</span>${meta.plural}</span>
          <button class="sb-add" data-add-unit="${type}" title="Add ${meta.label}">+</button>
        </div>
        <span class="sb-none">No units — add one</span>
      </div>`;
    }
    const chips = items.map(it => {
      const st = statusOf(it);
      return `<span class="chip ${st}" title="${statusLabel(st)}">${itemLabel(it)}</span>`;
    }).join('');
    return `<div class="sb-type">
      <div class="sb-type-hd">
        <span class="sb-type-name"><span class="sb-icon">${meta.icon}</span>${meta.plural}</span>
        <button class="sb-add" data-add-unit="${type}" title="Add ${meta.label}">+</button>
      </div>
      <div class="sb-chips">${chips}</div>
    </div>`;
  }).join('');
  document.getElementById('sidebar').innerHTML =
    `<div class="sb-sect-hd">Inventory</div>${html}`;
}

function renderStats() {
  const eq = S.equipment;
  const avail = eq.filter(e=>e.status==='avail').length;
  const out   = eq.filter(e=>e.status==='out').length;
  const ov    = eq.filter(e=>statusOf(e)==='ov').length;
  document.getElementById('statsRow').innerHTML = `
    <div class="stat"><div class="stat-lbl">Total Units</div><div class="stat-n">${eq.length}</div><div class="stat-sub">${Object.keys(TYPE).map(t=>{const c=eq.filter(e=>e.type===t).length;return c?`${c} ${TYPE[t].plural}`:''}).filter(Boolean).join(', ')||'None added'}</div></div>
    <div class="stat"><div class="stat-lbl">Available</div><div class="stat-n" style="color:var(--ok)">${avail}</div><div class="stat-sub">Ready to check out</div></div>
    <div class="stat"><div class="stat-lbl">Checked Out</div><div class="stat-n" style="color:var(--warn)">${out}</div><div class="stat-sub">${ov > 0 ? `<span style="color:var(--ov);font-weight:700">${ov} overdue</span>` : 'All on time'}</div></div>
    <div class="stat"><div class="stat-lbl">Total Rentals</div><div class="stat-n">${S.rentals.length}</div><div class="stat-sub">${S.rentals.filter(r=>r.closed).length} completed</div></div>`;
}

function renderOverdue() {
  const items = S.equipment.filter(e=>statusOf(e)==='ov');
  document.getElementById('ovBanner').innerHTML = items.length
    ? `<div class="ov-bar">⚠️ <b>${items.length} item${items.length>1?'s':''} overdue:</b> ${items.map(i=>itemLabel(i)).join(', ')}</div>`
    : '';
}

function renderActionBar() {
  const el = document.getElementById('actionBar');
  if (selected.size === 0) { el.innerHTML=''; return; }
  const labels = [...selected].map(id=>{
    const it = byId.get(id);
    return it ? itemLabel(it) : '';
  }).filter(Boolean).join(', ');
  el.innerHTML = `<div class="action-bar">
    <div class="ab-info">${selected.size} item${selected.size>1?'s':''} selected
      <span>${labels}</span>
    </div>
    <div class="ab-btns">
      <button class="btn btn-white btn-sm" data-action="clear-selection">✕ Clear</button>
      <button class="btn btn-blue btn-sm" style="background:#fff;color:var(--blue)" data-action="open-checkout">Check Out Selected →</button>
    </div>
  </div>`;
}

function renderGrids() {
  const fil = activeFilter;
  let avItems = S.equipment.filter(e=>e.status==='avail' && (fil==='all'||e.type===fil));
  let outItems = S.equipment.filter(e=>e.status==='out'  && (fil==='all'||e.type===fil));

  // Sort by type then number
  const sort = arr => arr.sort((a,b)=>a.type.localeCompare(b.type)||a.number-b.number);
  sort(avItems); sort(outItems);

  document.getElementById('gridAvail').innerHTML = avItems.length
    ? avItems.map(cardHtml).join('')
    : '<div class="empty">No available equipment</div>';

  // Group checked-out items by event
  const coSection = document.getElementById('checkedOutSection');
  if (!outItems.length) {
    coSection.innerHTML = `<div class="sec">Checked Out</div>
      <div class="grid"><div class="empty">Nothing currently checked out</div></div>`;
    return;
  }

  const byRental = new Map();
  outItems.forEach(item => {
    const rentalId = item.current ? item.current.rentalId : '';
    if (!rentalId) return;
    if (!byRental.has(rentalId)) byRental.set(rentalId, []);
    byRental.get(rentalId).push(item);
  });

  let html = '';
  for (const [rentalId, items] of byRental) {
    const rental = rentalById.get(rentalId);
    const event = rental?.event || items[0]?.current?.event || 'Unknown';
    const hasOverdue = items.some(it => statusOf(it) === 'ov');
    html += `<div class="event-group">
      <div class="event-group-hd">
        <div class="sec" style="margin-bottom:0;flex:1">
          <span style="display:inline-flex;align-items:center;gap:8px;">
            Checked Out — ${escHtml(event)}
            ${hasOverdue ? '<span class="pill ov" style="margin:0;font-size:7.5px;">Overdue</span>' : ''}
          </span>
        </div>
        <button class="btn btn-ci btn-sm" data-return-rental="${escHtml(rentalId)}">Return All →</button>
      </div>
      <div class="grid">${items.map(cardHtml).join('')}</div>
    </div>`;
  }
  coSection.innerHTML = html;
}

function cardHtml(item) {
  const st = statusOf(item);
  const lbl = itemLabel(item);
  const isSel = selected.has(item.id);
  const canSel = item.status === 'avail';
  const canDel = item.status === 'avail';

  let details = '';
  if (item.status === 'out' && item.current) {
    const cur = item.current;
    const coTimeStr = cur.coTime ? ` at ${fmtTime(cur.coTime)}` : '';
    details = `<div class="detail">
      <div><span class="dl">Event:</span> <span class="dv">${escHtml(cur.event)}</span></div>
      <div><span class="dl">Org:</span> <span class="dv">${escHtml(cur.org)}</span></div>
      <div><span class="dl">Out:</span> <span class="dv">${fmtDate(cur.coDate)}${coTimeStr}</span></div>
      <div><span class="dl">Due:</span> <span class="dv" ${st==='ov'?'style="color:var(--ov);font-weight:600"':''}>${fmtDate(cur.retDate)}</span></div>
    </div>`;
  }

  // Note: editable when available, read-only display when out
  const noteField = canSel
    ? `<input class="card-note" type="text" maxlength="80"
        placeholder="Add device description…"
        value="${escHtml(item.note||'')}"
        data-note-id="${escHtml(item.id)}">`
    : (item.note ? `<div class="note-snap">${escHtml(item.note)}</div>` : '');

  const action = item.status === 'out'
    ? `<button class="btn btn-ci" data-open-checkin="${escHtml(item.id)}">Return →</button>`
    : '';

  const delBtn = canDel
    ? `<button class="card-del" data-remove-unit="${escHtml(item.id)}" title="Delete unit">✕</button>`
    : '';

  const cb = canSel
    ? `<input type="checkbox" class="card-cb" data-select-id="${escHtml(item.id)}" ${isSel?'checked':''}>`
    : '';

  return `<div class="card ${st}${isSel?' selected':''}">
    ${delBtn}${cb}
    <div class="card-id">${lbl}</div>
    <div class="card-type">${TYPE[item.type].label}</div>
    <div class="pill ${st}">${statusLabel(st)}</div>
    ${noteField}
    ${details}
    <div class="card-action">${action}</div>
  </div>`;
}

function renderHistory() {
  const q = (document.getElementById('hsearch')?.value||'').toLowerCase();

  // Build rows from rentals + item histories
  const rows = [];
  S.rentals.forEach(rental => {
    const items = rental.items.map(id=>byId.get(id)).filter(Boolean);
    const isOv = !rental.closed && items.some(it=>statusOf(it)==='ov');
    const status = rental.closed ? 'Returned' : isOv ? 'Overdue' : 'Out';
    const st2 = rental.closed ? 'ok' : isOv ? 'ov' : 'out';
    // Use snapshot labels if present; live labels as fallback; pruned rentals use item IDs
    const snaps = rental.snapshots
      || (rental.pruned
        ? rental.items.map(id => { const it = byId.get(id); return it ? { label: itemLabel(it), note: it.note||'' } : { label: id, note: '' }; })
        : items.map(it=>({ label:itemLabel(it), note:it.note||'' })));
    const itemLabels = snaps.map(s=>s.label).join(', ');
    const itemDetail = snaps.map(s=>s.note ? `${s.label} (${s.note})` : s.label).join(', ');
    rows.push({ rental, items, status, st2, itemLabels, itemDetail, snaps });
  });

  // Filter
  const filt = rows.filter(r => {
    if (!q) return true;
    return r.rental.event.toLowerCase().includes(q)
      || r.rental.org.toLowerCase().includes(q)
      || r.itemLabels.toLowerCase().includes(q);
  });

  // Most recent first
  filt.sort((a,b)=>b.rental.coDate.localeCompare(a.rental.coDate));

  document.getElementById('histCount').textContent = `${filt.length} record${filt.length!==1?'s':''}`;

  if (!filt.length) {
    document.getElementById('histBody').innerHTML = `<div class="hist-none">No records found.</div>`;
    return;
  }

  const rows_html = filt.map(r => {
    const itemCell = r.snaps.map(s =>
      `<div><span class="mono-s">${escHtml(s.label)}</span>${s.note ? `<span style="font-size:10.5px;color:var(--s400);margin-left:5px;">${escHtml(s.note)}</span>` : ''}</div>`
    ).join('');
    const coTimeStr = r.rental.coTime ? `<div class="mono-s" style="font-size:9px;color:var(--s400)">${fmtTime(r.rental.coTime)}</div>` : '';
    const ciTimeStr = r.rental.ciTime ? `<div class="mono-s" style="font-size:9px;color:var(--s400)">${fmtTime(r.rental.ciTime)}</div>` : '';
    return `
    <tr>
      <td>${itemCell}</td>
      <td>${escHtml(r.rental.event)}</td>
      <td>${escHtml(r.rental.org)}</td>
      <td><span class="mono-s">${fmtDate(r.rental.coDate)}</span>${coTimeStr}</td>
      <td><span class="mono-s" ${r.st2==='ov'?'style="color:var(--ov)"':''}>${fmtDate(r.rental.retDate)}</span></td>
      <td><span class="mono-s">${r.rental.actualDate?fmtDate(r.rental.actualDate):'—'}</span>${ciTimeStr}</td>
      <td><span class="pill ${r.st2}" style="font-size:8px">${r.status}</span></td>
    </tr>`;
  }).join('');

  document.getElementById('histBody').innerHTML = `
    <table>
      <thead><tr>
        <th>Item(s)</th><th>Event</th><th>Organization</th>
        <th>Checked Out</th><th>Due</th><th>Returned</th><th>Status</th>
      </tr></thead>
      <tbody>${rows_html}</tbody>
    </table>`;
}

// ═══════════════════════════════════════════════════════
//  UI HELPERS
// ═══════════════════════════════════════════════════════

function bindUIEvents() {
  document.getElementById('btnExportBackup')?.addEventListener('click', exportJSON);
  document.getElementById('btnRestoreBackup')?.addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile')?.addEventListener('change', (e) => importJSON(e.target));
  document.getElementById('btnExportHistory')?.addEventListener('click', exportHistoryCSV);
  document.getElementById('btnExportInventory')?.addEventListener('click', exportInventoryCSV);
  document.getElementById('hsearch')?.addEventListener('input', renderHistory);
  document.getElementById('btnConfirmCheckout')?.addEventListener('click', confirmCheckout);
  document.getElementById('btnConfirmCheckin')?.addEventListener('click', confirmCheckin);
  document.getElementById('btnCalPrev')?.addEventListener('click', () => calNav(-1));
  document.getElementById('btnCalNext')?.addEventListener('click', () => calNav(1));
  document.getElementById('btnCalToday')?.addEventListener('click', calToday);

  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
  });
  document.querySelectorAll('.tab[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => tab(btn.dataset.tab, btn));
  });
  document.querySelectorAll('.fil[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => setFil(btn.dataset.filter, btn));
  });
  document.querySelectorAll('.cal-view[data-cal-view]').forEach(btn => {
    btn.addEventListener('click', () => setCalView(btn.dataset.calView, btn));
  });

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;

    const addType = t.closest('[data-add-unit]')?.getAttribute('data-add-unit');
    if (addType) { addUnit(addType); return; }

    const removeId = t.closest('[data-remove-unit]')?.getAttribute('data-remove-unit');
    if (removeId) { removeUnit(removeId); return; }

    const checkinId = t.closest('[data-open-checkin]')?.getAttribute('data-open-checkin');
    if (checkinId) { openCheckin(checkinId); return; }

    const rentalId = t.closest('[data-return-rental]')?.getAttribute('data-return-rental');
    if (rentalId) { returnAllForRental(rentalId); return; }

    const action = t.closest('[data-action]')?.getAttribute('data-action');
    if (action === 'clear-selection') clearSelection();
    else if (action === 'open-checkout') openCheckout();
    else if (action === 'dismiss-backup-banner') dismissBanner();
    else if (action === 'export-backup') exportJSON();

    const calBar = t.closest('[data-cal-rental]');
    if (calBar) calBarClick(calBar.getAttribute('data-cal-rental'), calBar.getAttribute('data-cal-item'));
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.matches('.card-cb[data-select-id]')) toggleSelect(t.getAttribute('data-select-id'));
  });

  document.addEventListener('focusout', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t instanceof HTMLInputElement && t.matches('.card-note[data-note-id]')) {
      saveNote(t.getAttribute('data-note-id'), t.value);
    }
  });
}

function tab(id, btn) {
  document.querySelectorAll('.tab').forEach(b=>b.classList.remove('on'));
  document.querySelectorAll('.pane').forEach(p=>p.classList.remove('on'));
  btn.classList.add('on');
  document.getElementById('pane-'+id).classList.add('on');
  if (id==='history') renderHistory();
  if (id==='calendar') renderCalendar();
}

function setFil(type, btn) {
  activeFilter = type;
  document.querySelectorAll('.fil').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
  renderGrids();
}

function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function v(id) { return document.getElementById(id).value; }

function clearErrors() {
  document.querySelectorAll('.ferr').forEach(e=>{ e.classList.remove('show'); e.textContent=e.dataset.orig||e.textContent; });
  document.querySelectorAll('.finput').forEach(e=>e.classList.remove('err'));
}

function showErr(id, useCustom, msg) {
  const el = document.getElementById(id);
  el.classList.add('show');
  if (useCustom && msg) el.textContent = msg;
  // Highlight the input above it (previous sibling)
  const inp = el.previousElementSibling;
  if (inp && inp.classList.contains('finput')) inp.classList.add('err');
}

function toast(msg, type='ok') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  document.getElementById('toasts').appendChild(t);
  t.addEventListener('animationend', e => { if (e.animationName === 'tOut') t.remove(); });
}

function confirm2(title, body, cb) {
  document.getElementById('cfmTitle').textContent = title;
  document.getElementById('cfmBody').textContent = body;
  const btn = document.getElementById('cfmOk');
  btn.onclick = () => { closeModal('oCFM'); cb(); };
  openModal('oCFM');
}

// Close modals on overlay click
['oCO','oCI','oCFM'].forEach(id=>{
  document.getElementById(id).addEventListener('click', function(e){
    if (e.target===this) closeModal(id);
  });
});

// Close topmost open modal on Escape key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    for (const id of ['oCFM','oCI','oCO']) {
      if (document.getElementById(id).classList.contains('open')) {
        closeModal(id);
        break;
      }
    }
  }
});

// Clear validation errors as user types
document.querySelectorAll('.finput').forEach(inp=>{
  inp.addEventListener('input',()=>{
    inp.classList.remove('err');
    const next = inp.nextElementSibling;
    if (next && next.classList.contains('ferr')) next.classList.remove('show');
  });
});


// ═══════════════════════════════════════════════════════
//  EXPORT / IMPORT
// ═══════════════════════════════════════════════════════

function csvEscape(val) {
  const s = String(val ?? '');
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadFile(filename, content, mime) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  a.href = url;
  a.download = filename;
  a.click();
  // Delay revocation so the browser can consume the blob
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function datestamp() { return today().replace(/-/g, ''); }

function exportHistoryCSV() {
  if (!S.rentals.length) { toast('No rental history to export.', 'err'); return; }
  const header = ['Rental ID','Item(s)','Event','Organization','Checkout Date','Checkout Time','Expected Return','Actual Return','Return Time','Status','Late Return'];
  const rows = S.rentals.map(rental => {
    const snaps = rental.snapshots || rental.items.map(id => {
      const it = byId.get(id);
      return it ? { label: itemLabel(it), note: it.note||'' } : { label: id, note: '' };
    });
    const items = snaps.map(s => s.note ? `${s.label} (${s.note})` : s.label);
    const anyOv = !rental.closed && rental.items.some(id => {
      const it = byId.get(id);
      return it && statusOf(it) === 'ov';
    });
    const status = rental.closed ? 'Returned' : anyOv ? 'Overdue' : 'Out';
    const late = rental.closed && rental.actualDate && rental.actualDate > rental.retDate ? 'Yes' : rental.closed ? 'No' : '';
    return [
      rental.id,
      items.join('; '),
      rental.event,
      rental.org,
      rental.coDate,
      rental.coTime ? fmtTime(rental.coTime) : '',
      rental.retDate,
      rental.actualDate || '',
      rental.ciTime ? fmtTime(rental.ciTime) : '',
      status,
      late
    ].map(csvEscape).join(',');
  });
  const csv = [header.map(csvEscape).join(','), ...rows].join('\r\n');
  downloadFile(`penncard-rentals-${datestamp()}.csv`, csv, 'text/csv');
  toast('Rental history exported.', 'ok');
}

function exportInventoryCSV() {
  if (!S.equipment.length) { toast('No inventory to export.', 'err'); return; }
  const header = ['Item ID','Type','Number','Status','Current Event','Current Org','Checkout Date','Checkout Time','Due Date'];
  const rows = [...S.equipment]
    .sort((a,b) => a.type.localeCompare(b.type) || a.number - b.number)
    .map(it => {
      const st = statusOf(it);
      const c = it.current;
      return [
        itemLabel(it), TYPE[it.type].label, it.number, statusLabel(st),
        c ? c.event : '', c ? c.org : '', c ? c.coDate : '',
        c && c.coTime ? fmtTime(c.coTime) : '',
        c ? c.retDate : ''
      ].map(csvEscape).join(',');
    });
  const csv = [header.map(csvEscape).join(','), ...rows].join('\r\n');
  downloadFile(`penncard-inventory-${datestamp()}.csv`, csv, 'text/csv');
  toast('Inventory snapshot exported.', 'ok');
}

function exportJSON() {
  downloadFile(`penncard-backup-${datestamp()}.json`, JSON.stringify(S, null, 2), 'application/json');
  saveMeta({ lastBackup: Date.now() });
  toast('Backup exported.', 'ok');
  renderBackupBanner();
  renderSbLastBackup();
}

function sanitizeBackupData(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Backup payload must be an object');
  if (!Array.isArray(raw.equipment) || !Array.isArray(raw.rentals) || typeof raw.seq !== 'object' || raw.seq === null) {
    throw new Error('Backup payload missing required collections');
  }
  if (raw.equipment.length > 1000 || raw.rentals.length > 10000) throw new Error('Backup payload too large');

  const seq = {
    reader: Math.max(1, Number.parseInt(raw.seq.reader, 10) || 1),
    hotspot: Math.max(1, Number.parseInt(raw.seq.hotspot, 10) || 1),
    charger: Math.max(1, Number.parseInt(raw.seq.charger, 10) || 1)
  };

  const equipment = raw.equipment.map((it, idx) => {
    if (!it || typeof it !== 'object') throw new Error(`Invalid equipment row at index ${idx}`);
    if (!VALID_TYPES.has(it.type)) throw new Error(`Invalid equipment type at index ${idx}`);
    const id = String(it.id || uid());
    const number = Math.max(1, Number.parseInt(it.number, 10) || 1);
    const status = it.status === 'out' ? 'out' : 'avail';
    const note = cleanText(it.note, MAX_NOTE_LEN);
    const history = Array.isArray(it.history) ? it.history.map(h => ({
      rentalId: String(h?.rentalId ?? ''),
      event: cleanText(h?.event, MAX_EVENT_LEN),
      org: cleanText(h?.org, MAX_ORG_LEN),
      coDate: normalizeDate(h?.coDate),
      retDate: normalizeDate(h?.retDate),
      coTime: normalizeIso(h?.coTime),
      actualDate: normalizeDate(h?.actualDate),
      ciTime: normalizeIso(h?.ciTime),
    })) : [];
    const current = status === 'out' && it.current && typeof it.current === 'object'
      ? {
        rentalId: String(it.current.rentalId ?? ''),
        event: cleanText(it.current.event, MAX_EVENT_LEN),
        org: cleanText(it.current.org, MAX_ORG_LEN),
        coDate: normalizeDate(it.current.coDate),
        retDate: normalizeDate(it.current.retDate),
        coTime: normalizeIso(it.current.coTime),
      }
      : null;
    return { id, type: it.type, number, status, note, current, history };
  });
  const equipmentIdSet = new Set();
  equipment.forEach(it => {
    if (equipmentIdSet.has(it.id)) it.id = uid();
    equipmentIdSet.add(it.id);
  });

  const rentals = raw.rentals.map((r, idx) => {
    if (!r || typeof r !== 'object') throw new Error(`Invalid rental row at index ${idx}`);
    const items = Array.isArray(r.items)
      ? [...new Set(r.items.map(String).filter(id => equipmentIdSet.has(id)))]
      : [];
    if (items.length > 100) throw new Error(`Invalid rental item count at index ${idx}`);
    const snapshots = Array.isArray(r.snapshots)
      ? r.snapshots
          .slice(0, 100)
          .map(s => ({ id: String(s?.id ?? ''), label: cleanText(s?.label, 40), note: cleanText(s?.note, MAX_NOTE_LEN) }))
      : [];
    return {
      id: String(r.id || uid()),
      items,
      snapshots,
      event: cleanText(r.event, MAX_EVENT_LEN),
      org: cleanText(r.org, MAX_ORG_LEN),
      coDate: normalizeDate(r.coDate),
      retDate: normalizeDate(r.retDate),
      coTime: normalizeIso(r.coTime),
      actualDate: normalizeDate(r.actualDate),
      ciTime: normalizeIso(r.ciTime),
      closed: Boolean(r.closed),
      pruned: Boolean(r.pruned),
    };
  });

  const rentalIdSet = new Set();
  rentals.forEach(r => {
    if (rentalIdSet.has(r.id)) r.id = uid();
    rentalIdSet.add(r.id);
  });

  // Ensure equipment current rental references remain valid.
  equipment.forEach(item => {
    if (!item.current?.rentalId || !rentalIdSet.has(item.current.rentalId)) {
      item.status = 'avail';
      item.current = null;
    }
  });

  return { equipment, rentals, seq };
}

function importJSON(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    toast('Backup file is too large (10MB max).', 'err');
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const parsed = JSON.parse(e.target.result);
      const data = sanitizeBackupData(parsed);
      confirm2('Restore from backup?',
        `This will replace all current data with "${file.name}". This cannot be undone.`,
        () => { S = data; save(); render(); toast('Data restored from backup.', 'ok'); });
    } catch(err) {
      toast('Could not read backup file — may be corrupted.', 'err');
    }
    input.value = '';
  };
  reader.readAsText(file);
}


// ═══════════════════════════════════════════════════════
//  BACKUP REMINDER
// ═══════════════════════════════════════════════════════

function daysSinceBackup() {
  const m = loadMeta();
  if (!m.lastBackup) return Infinity;
  return (Date.now() - m.lastBackup) / (1000 * 60 * 60 * 24);
}

function fmtLastBackup() {
  const m = loadMeta();
  if (!m.lastBackup) return 'Never';
  return new Date(m.lastBackup).toLocaleDateString('en-US',
    { month:'short', day:'numeric', year:'numeric' });
}

function renderBackupBanner() {
  const el = document.getElementById('backupBanner');
  if (!el) return;
  const days = daysSinceBackup();
  const urgent = days > 14;
  const warn   = days >= BACKUP_INTERVAL_DAYS;
  if (!warn) { el.innerHTML = ''; return; }

  const msg = days === Infinity
    ? 'No backup has ever been made of this system\'s data.'
    : urgent
      ? `Last backup was <strong>${Math.floor(days)} days ago.</strong> Data may be at risk.`
      : `Last backup was <strong>${Math.floor(days)} days ago.</strong> A weekly backup is recommended.`;

  el.innerHTML = `<div class="backup-banner${urgent?' urgent':''}">
    <div class="bb-left">
      <span class="bb-icon">${urgent ? '🔴' : '🟡'}</span>
      <span class="bb-text">${msg}</span>
    </div>
    <div class="bb-btns">
      <button class="btn btn-ghost btn-sm" data-action="dismiss-backup-banner">Remind me later</button>
      <button class="btn btn-sm ${urgent?'btn-danger':'btn-blue'}" data-action="export-backup">Export Backup Now</button>
    </div>
  </div>`;
}

function dismissBanner() {
  // Snooze for 24 hours by faking the last backup as 6 days ago
  // (keeps the weekly cadence without permanently silencing the reminder)
  const snoozeUntil = Date.now() - ((BACKUP_INTERVAL_DAYS - 1) * 24 * 60 * 60 * 1000);
  saveMeta({ lastBackup: snoozeUntil });
  document.getElementById('backupBanner').innerHTML = '';
}

function renderSbLastBackup() {
  const el = document.getElementById('sbLastBackup');
  if (el) el.textContent = `Last backup: ${fmtLastBackup()}`;
}

// ═══════════════════════════════════════════════════════
//  CALENDAR
// ═══════════════════════════════════════════════════════

// Event color palette — auto-assigned per unique event name
const EVENT_COLORS = [
  { bg:'#E3F2FD', fg:'#1565C0', bar:'#42A5F5' },
  { bg:'#F3E5F5', fg:'#7B1FA2', bar:'#AB47BC' },
  { bg:'#E8F5E9', fg:'#2E7D32', bar:'#66BB6A' },
  { bg:'#FFF3E0', fg:'#E65100', bar:'#FFA726' },
  { bg:'#FCE4EC', fg:'#C62828', bar:'#EF5350' },
  { bg:'#E0F7FA', fg:'#00695C', bar:'#26A69A' },
  { bg:'#FFF9C4', fg:'#F57F17', bar:'#FFEE58' },
  { bg:'#E8EAF6', fg:'#283593', bar:'#5C6BC0' },
  { bg:'#EFEBE9', fg:'#4E342E', bar:'#8D6E63' },
  { bg:'#F1F8E9', fg:'#558B2F', bar:'#9CCC65' },
];
const eventColorMap = new Map();

function getEventColor(eventName) {
  if (eventColorMap.has(eventName)) return eventColorMap.get(eventName);
  const idx = eventColorMap.size % EVENT_COLORS.length;
  const c = EVENT_COLORS[idx];
  eventColorMap.set(eventName, c);
  return c;
}

// Rebuild color map from current rentals (preserves assignment across renders)
function rebuildEventColors() {
  const seen = new Set(eventColorMap.keys());
  S.rentals.forEach(r => {
    if (!seen.has(r.event)) getEventColor(r.event);
  });
}

// Calendar state
let calView = 'month';    // 'month' | 'timeline' | 'event'
let calDate = new Date();  // anchor date for navigation

// Gather all rental intervals (active + closed) for calendar display
function calRentals() {
  return S.rentals.map(rental => {
    const start = rental.coDate;
    const end = rental.actualDate || rental.retDate;
    const items = rental.items.map(id => byId.get(id)).filter(Boolean);
    const snaps = rental.snapshots || items.map(it => ({ label: itemLabel(it), note: it.note || '' }));
    const isActive = !rental.closed;
    const isOverdueRental = isActive && isOverdue(rental.retDate);
    return { rental, start, end, items, snaps, isActive, isOverdueRental };
  }).filter(r => r.start); // must have a start date
}

// ── Month View ──────────────────────────────────

function renderCalMonth() {
  const year = calDate.getFullYear();
  const month = calDate.getMonth();
  document.getElementById('calLabel').textContent =
    calDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = today();
  const rentals = calRentals();

  // Build day cells
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let html = '<div class="cal-month-grid">';
  html += dayNames.map(d => `<div class="cal-dow">${d}</div>`).join('');

  const visibleEvents = new Set();
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const isToday = dateStr === todayStr;

    // Find rentals active on this day
    const active = rentals.filter(r => r.start <= dateStr && r.end >= dateStr);
    active.forEach(r => visibleEvents.add(r.rental.event));
    const pills = active.slice(0, 3).map(r => {
      const c = getEventColor(r.rental.event);
      const overdueClass = r.isOverdueRental ? ' cal-pill-ov' : '';
      const closedClass = !r.isActive ? ' cal-pill-closed' : '';
      return `<div class="cal-pill${overdueClass}${closedClass}" style="background:${c.bar};color:#fff" title="${escHtml(r.rental.event)}: ${r.snaps.map(s=>s.label).join(', ')}">${escHtml(r.rental.event).slice(0, 12)}</div>`;
    }).join('');
    const more = active.length > 3 ? `<div class="cal-more">+${active.length - 3} more</div>` : '';

    // Position day 1 on the correct column (skip leading empties)
    const colStart = d === 1 && firstDay > 0 ? ` style="grid-column-start:${firstDay + 1}"` : '';
    html += `<div class="cal-day${isToday ? ' cal-today' : ''}"${colStart}>
      <div class="cal-day-num">${d}</div>
      ${pills}${more}
    </div>`;
  }
  html += '</div>';
  document.getElementById('calBody').innerHTML = html;
  renderCalLegend(visibleEvents);
}

// ── Gantt helpers ───────────────────────────────

function ganttRange() {
  // 4-week window centered on calDate's week
  const d = new Date(calDate);
  const dow = d.getDay();
  d.setDate(d.getDate() - dow); // start of week
  const start = new Date(d);
  const end = new Date(d);
  end.setDate(end.getDate() + 27); // 4 weeks
  return { start, end, days: 28 };
}

function dateToStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

function ganttHeader(range) {
  let html = '<div class="gantt-header">';
  html += '<div class="gantt-label-col"></div>';
  const d = new Date(range.start);
  const todayStr = today();
  for (let i = 0; i < range.days; i++) {
    const ds = dateToStr(d);
    const isToday = ds === todayStr;
    const isSun = d.getDay() === 0;
    const dayLabel = d.getDate();
    const showMonth = i === 0 || dayLabel === 1;
    html += `<div class="gantt-day-hd${isToday ? ' gantt-today-hd' : ''}${isSun ? ' gantt-week-start' : ''}">
      ${showMonth ? `<div class="gantt-month-lbl">${d.toLocaleDateString('en-US',{month:'short'})}</div>` : ''}
      <div class="gantt-day-num">${dayLabel}</div>
    </div>`;
    d.setDate(d.getDate() + 1);
  }
  html += '</div>';
  return html;
}

function ganttBar(rental, range, rowHeight) {
  const startStr = dateToStr(range.start);
  const endStr = dateToStr(range.end);
  const rStart = rental.start < startStr ? startStr : rental.start;
  const rEnd = rental.end > endStr ? endStr : rental.end;

  if (rStart > endStr || rEnd < startStr) return '';

  const left = daysBetween(startStr, rStart);
  const width = daysBetween(rStart, rEnd) + 1;
  const c = getEventColor(rental.rental.event);
  const overdueStyle = rental.isOverdueRental ? 'background-image:repeating-linear-gradient(-45deg,transparent,transparent 3px,rgba(153,0,0,.2) 3px,rgba(153,0,0,.2) 6px);' : '';
  const closedOpacity = !rental.isActive ? 'opacity:.45;' : '';
  const pct = (n) => (n / range.days * 100).toFixed(2);
  const itemId = rental.items[0]?.id || '';

  return `<div class="gantt-bar" style="left:${pct(left)}%;width:${pct(width)}%;background:${c.bar};${overdueStyle}${closedOpacity}" title="${escHtml(rental.rental.event)}: ${rental.snaps.map(s=>s.label).join(', ')} (${rental.start} → ${rental.end})" data-cal-rental="${escHtml(rental.rental.id)}" data-cal-item="${escHtml(itemId)}">${escHtml(rental.rental.event).slice(0, 18)}</div>`;
}

// Today line for gantt views
function ganttTodayLine(range) {
  const todayStr = today();
  const startStr = dateToStr(range.start);
  const endStr = dateToStr(range.end);
  if (todayStr < startStr || todayStr > endStr) return '';
  const offset = daysBetween(startStr, todayStr);
  const pct = ((offset + 0.5) / range.days * 100).toFixed(2);
  return `<div class="gantt-today-line" style="left:${pct}%"></div>`;
}

// ── Timeline View (by device) ──────────────────

function renderCalTimeline() {
  const range = ganttRange();
  document.getElementById('calLabel').textContent =
    `${dateToStr(range.start).slice(5)} — ${dateToStr(range.end).slice(5)}`;

  const rentals = calRentals();
  const startStr = dateToStr(range.start);
  const endStr = dateToStr(range.end);

  // Build rows per device that has any rental in range
  const deviceMap = new Map();
  [...S.equipment].sort((a,b) => a.type.localeCompare(b.type) || a.number - b.number).forEach(item => {
    deviceMap.set(item.id, { item, rentals: [] });
  });
  rentals.forEach(r => {
    if (r.start > endStr || r.end < startStr) return;
    r.items.forEach(item => {
      if (deviceMap.has(item.id)) {
        deviceMap.get(item.id).rentals.push(r);
      }
    });
  });

  // Filter to devices with rentals in range
  const rows = [...deviceMap.values()].filter(d => d.rentals.length > 0);

  if (!rows.length) {
    document.getElementById('calBody').innerHTML =
      '<div class="cal-empty">No rentals in this date range.</div>';
    renderCalLegend(new Set());
    return;
  }

  const visibleEvents = new Set();
  let html = '<div class="gantt-wrap">';
  html += ganttHeader(range);

  rows.forEach(row => {
    row.rentals.forEach(r => visibleEvents.add(r.rental.event));
    html += `<div class="gantt-row">
      <div class="gantt-label-col">
        <div class="gantt-device-lbl">${itemLabel(row.item)}</div>
        <div class="gantt-device-type">${TYPE[row.item.type].label}</div>
      </div>
      <div class="gantt-track">
        ${ganttTodayLine(range)}
        ${row.rentals.map(r => ganttBar(r, range)).join('')}
      </div>
    </div>`;
  });

  html += '</div>';
  document.getElementById('calBody').innerHTML = html;
  renderCalLegend(visibleEvents);
}

// ── Event View (grouped by event) ──────────────

function renderCalEvent() {
  const range = ganttRange();
  document.getElementById('calLabel').textContent =
    `${dateToStr(range.start).slice(5)} — ${dateToStr(range.end).slice(5)}`;

  const rentals = calRentals();
  const startStr = dateToStr(range.start);
  const endStr = dateToStr(range.end);

  // Group by event
  const eventMap = new Map();
  rentals.forEach(r => {
    if (r.start > endStr || r.end < startStr) return;
    if (!eventMap.has(r.rental.event)) eventMap.set(r.rental.event, []);
    eventMap.get(r.rental.event).push(r);
  });

  if (!eventMap.size) {
    document.getElementById('calBody').innerHTML =
      '<div class="cal-empty">No rentals in this date range.</div>';
    renderCalLegend(new Set());
    return;
  }

  const visibleEvents = new Set(eventMap.keys());
  let html = '<div class="gantt-wrap">';
  html += ganttHeader(range);

  for (const [event, eventRentals] of eventMap) {
    const c = getEventColor(event);
    // Show each rental as a separate row under the event header
    html += `<div class="gantt-event-group">
      <div class="gantt-event-hd" style="border-left:3px solid ${c.bar}">
        <div class="gantt-event-name">${escHtml(event)}</div>
        <div class="gantt-event-count">${eventRentals.reduce((n, r) => n + r.snaps.length, 0)} items</div>
      </div>`;

    eventRentals.forEach(r => {
      const itemLabels = r.snaps.map(s => s.label).join(', ');
      html += `<div class="gantt-row gantt-row-sm">
        <div class="gantt-label-col">
          <div class="gantt-device-lbl" style="font-size:10px">${escHtml(itemLabels)}</div>
        </div>
        <div class="gantt-track">
          ${ganttTodayLine(range)}
          ${ganttBar(r, range)}
        </div>
      </div>`;
    });

    html += '</div>';
  }

  html += '</div>';
  document.getElementById('calBody').innerHTML = html;
  renderCalLegend(visibleEvents);
}

// ── Calendar controls ──────────────────────────

function setCalView(view, btn) {
  calView = view;
  document.querySelectorAll('.cal-view').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  renderCalendar();
}

function calNav(dir) {
  if (calView === 'month') {
    // Pin to 1st of month to avoid day-overflow wrapping (e.g. Jan 31 + 1 month → Mar 3)
    calDate.setDate(1);
    calDate.setMonth(calDate.getMonth() + dir);
  } else {
    calDate.setDate(calDate.getDate() + (dir * 7));
  }
  renderCalendar();
}

function calToday() {
  calDate = new Date();
  renderCalendar();
}

function calBarClick(rentalId, itemId) {
  const rental = rentalById.get(rentalId);
  if (!rental || rental.closed) return;

  // If item is still checked out, open check-in for it
  const item = byId.get(itemId);
  if (item && item.status === 'out') {
    openCheckin(itemId);
  }
}

function renderCalLegend(visibleEvents) {
  const el = document.getElementById('calLegend');
  if (!visibleEvents || !visibleEvents.size) { el.innerHTML = ''; return; }

  const chips = [...visibleEvents].map(name => {
    const c = getEventColor(name);
    return `<span class="cal-legend-chip" style="background:${c.bg};color:${c.fg};border-color:${c.bar}">${escHtml(name)}</span>`;
  }).join('');
  el.innerHTML = chips;
}

function renderCalendar() {
  rebuildEventColors();
  if (calView === 'month') renderCalMonth();
  else if (calView === 'timeline') renderCalTimeline();
  else renderCalEvent();
}

// ═══════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════

bindUIEvents();
render();
renderBackupBanner();
renderSbLastBackup();
checkStorageHealth();
setInterval(renderHeader, 60000); // refresh clock label
