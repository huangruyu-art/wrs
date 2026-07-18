const STORAGE_KEY = 'work-record-prototype-v9-records';
const MASTER_STORAGE_KEY = 'work-record-prototype-v9-masters';
const SCHEDULE_STORAGE_KEY = 'work-record-prototype-v9-project-schedules';
const today = new Date().toISOString().slice(0, 10);
const STATUSES = ['進行中','待處理','等待回覆','已完成','暫停','突然結案','已結案'];
const DEFAULT_PROJECT_INFO = window.WORK_RECORD_PROJECT_INFO_TEMPLATE || `中文品名：
英文品名：
規格：
包材：
需求量：
下單方式：
指定檢驗：
上市日/到貨日：
出貨方式：國內貨運、國外疊櫃、國外板出
料號：
國條：`;
const $ = (id) => document.getElementById(id);
let state = {
  records: [],
  masters: { customers: [], productSpecs: [], scheduleNodes: [] },
  projectSchedules: {},
  expandedProjects: new Set(),
  expandedProjectInfo: new Set(),
  scheduleEditorProject: '',
  currentFollowMode: 'overdue',
  activeView: 'dashboard',
  calendarStartOffset: 0,
  calendarEndOffset: 0
};
let remoteApplying = false;
let autoSyncTimer = null;
let autoSyncBusy = false;
let lastAutoSyncAt = '';

function uid() { return crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()); }
function readStore() {
  state.records = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  state.masters = JSON.parse(localStorage.getItem(MASTER_STORAGE_KEY) || '{"customers":[],"productSpecs":[],"scheduleNodes":[]}');
  state.projectSchedules = JSON.parse(localStorage.getItem(SCHEDULE_STORAGE_KEY) || '{}');
  normalizeMasters();
}
function writeStore() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.records));
  localStorage.setItem(MASTER_STORAGE_KEY, JSON.stringify(state.masters));
  localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(state.projectSchedules));
  if (!remoteApplying) scheduleAutoSync();
}
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'), 1800); }
function dateValue(v) { return v || ''; }
function daysBetween(a, b=today) { return Math.floor((new Date(b) - new Date(a)) / 86400000); }
function isoDate(d) { return d.toISOString().slice(0,10); }
function addWorkDays(dateStr, days) {
  const d = new Date(dateStr);
  let left = Number(days || 0);
  if (Number.isNaN(d.getTime())) return '';
  if (left === 0) return isoDate(d);
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) left--;
  }
  return isoDate(d);
}
function subtractWorkDays(dateStr, days) {
  const d = new Date(dateStr);
  let left = Number(days || 0);
  if (Number.isNaN(d.getTime())) return '';
  if (left === 0) return isoDate(d);
  while (left > 0) {
    d.setDate(d.getDate() - 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) left--;
  }
  return isoDate(d);
}
function isOpen(r) { return !['已完成','已結案','突然結案'].includes(r.status); }
function projectKey(r) { return [r.customer||'未填客戶', r.product_name||'未填產品', r.spec||''].join('｜'); }
function productSpecKey(p) { return [p.customer || '未填客戶', p.product_name || '未填產品', p.spec || ''].join('｜'); }
function cloneTemplateScheduleNodes() {
  const source = (state.masters.scheduleNodes && state.masters.scheduleNodes.length ? state.masters.scheduleNodes : (window.defaultScheduleNodes || []));
  return source
    .slice()
    .sort((a,b)=>Number(a.sort_order || 0)-Number(b.sort_order || 0))
    .map((n, i) => ({
      id: uid(),
      template_node_id: n.id || '',
      sort_order: i + 1,
      node_name: String(n.node_name || '').trim(),
      department: String(n.department || '').trim(),
      work_days: Number(n.work_days || 0)
    }))
    .filter(n => n.node_name);
}
function ensureProjectScheduleCopy(key, shouldPersist = true) {
  if (!key) return null;
  const existing = state.projectSchedules[key] || {};
  if (Array.isArray(existing.scheduleNodes) && existing.scheduleNodes.length) {
    const normalizedNodes = existing.scheduleNodes
      .slice()
      .sort((a,b)=>Number(a.sort_order || 0)-Number(b.sort_order || 0))
      .map((n, i) => ({
        id: n.id || uid(),
        template_node_id: n.template_node_id || '',
        sort_order: i + 1,
        node_name: String(n.node_name || '').trim(),
        department: String(n.department || '').trim(),
        work_days: Number(n.work_days || 0)
      }))
      .filter(n => n.node_name);
    const normalized = {...existing, scheduleNodes: normalizedNodes, nodeDates: existing.nodeDates || {}, projectInfo: existing.projectInfo || DEFAULT_PROJECT_INFO};
    if (shouldPersist) state.projectSchedules[key] = normalized;
    return normalized;
  }
  const clonedNodes = cloneTemplateScheduleNodes();
  const oldDates = existing.nodeDates || {};
  const migratedDates = {};
  clonedNodes.forEach(n => {
    const oldByTemplate = n.template_node_id && oldDates[n.template_node_id] ? oldDates[n.template_node_id] : null;
    const oldByName = Object.values(oldDates).find(d => d && d.node_name === n.node_name) || null;
    if (oldByTemplate || oldByName) migratedDates[n.id] = {...(oldByTemplate || oldByName)};
  });
  const created = {
    mode: existing.mode || 'forward',
    baseDate: existing.baseDate || '',
    targetDate: existing.targetDate || '',
    nodeDates: Object.keys(migratedDates).length ? migratedDates : {},
    projectInfo: existing.projectInfo || DEFAULT_PROJECT_INFO,
    scheduleNodes: clonedNodes,
    copiedFromTemplateAt: existing.copiedFromTemplateAt || new Date().toISOString()
  };
  if (shouldPersist) state.projectSchedules[key] = created;
  return created;
}
function ensureProjectScheduleCopiesForAllProjects() {
  (state.masters.productSpecs || []).forEach(p => ensureProjectScheduleCopy(productSpecKey(p), true));
}
function comboValue(product, spec) { return `${product || ''}${spec ? '｜' + spec : ''}`; }
function splitCombo(value) {
  const parts = String(value || '').split('｜');
  return { product_name: (parts[0] || '').trim(), spec: parts.slice(1).join('｜').trim() };
}
function normalizeRecord(r) {
  return {
    id: r.id || uid(),
    record_date: dateValue(r.record_date) || today,
    customer: r.customer || '',
    product_name: r.product_name || '',
    spec: r.spec || '',
    work_type: r.work_type || '一般記事',
    stage: r.stage || inferStage(r),
    status: r.status || '進行中',
    title: r.title || (r.notes || '').split('\n')[0] || '未命名記事',
    notes: r.notes || '',
    next_action: r.next_action || '',
    waiting_for: r.waiting_for || '',
    follow_up_date: r.follow_up_date || '',
    milestone_type: r.milestone_type || '',
    milestone_date: r.milestone_date || '',
    priority: r.priority || '普通',
    sample_version: r.sample_version || '',
    photo_path: r.photo_path || '',
    close_reason: r.close_reason || '',
    source_sheet: r.source_sheet || '',
    created_at: r.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}
function inferStage(r) {
  const s = `${r.work_type||''} ${r.notes||''} ${r.title||''}`;
  if (s.includes('樣')) return '樣品階段';
  if (s.includes('報告') || s.includes('送驗')) return '檢驗/報告';
  if (s.includes('審查')) return '包裝審查';
  if (s.includes('設計') || s.includes('版')) return '包裝設計';
  if (s.includes('料號') || s.includes('條碼') || s.includes('國條')) return '料號/條碼';
  if (s.includes('發包') || s.includes('請購')) return '請購/發包';
  if (s.includes('出貨') || s.includes('上市')) return '出貨/上市';
  return '需求確認';
}
function escapeHtml(s) { return String(s || '').replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }

function normalizeMasters() {
  const customers = new Set((state.masters.customers || []).filter(Boolean));
  const productMap = new Map();
  (state.masters.productSpecs || []).forEach(p => {
    if (!p.customer || !p.product_name) return;
    const item = { id: p.id || uid(), customer: p.customer.trim(), product_name: p.product_name.trim(), spec: (p.spec || '').trim(), status: p.status || '進行中', latestDate: p.latestDate || '' };
    customers.add(item.customer);
    productMap.set(`${item.customer}||${item.product_name}||${item.spec}`, item);
  });
  state.records.forEach(r => {
    if (r.customer) customers.add(r.customer.trim());
    if (r.customer && r.product_name) {
      const key = `${r.customer.trim()}||${r.product_name.trim()}||${(r.spec || '').trim()}`;
      const existing = productMap.get(key);
      const recordDate = r.record_date || '';
      if (!existing) {
        productMap.set(key, { id: uid(), customer: r.customer.trim(), product_name: r.product_name.trim(), spec: (r.spec || '').trim(), status: r.status || '進行中', latestDate: recordDate });
      } else if (recordDate >= (existing.latestDate || '')) {
        existing.status = r.status || existing.status || '進行中';
        existing.latestDate = recordDate;
      }
    }
  });
  const scheduleNodes = (state.masters.scheduleNodes && state.masters.scheduleNodes.length ? state.masters.scheduleNodes : (window.defaultScheduleNodes || [])).map((n, i) => ({
    id: n.id || uid(),
    sort_order: Number(n.sort_order || i + 1),
    node_name: String(n.node_name || '').trim(),
    department: String(n.department || '').trim(),
    work_days: Number(n.work_days || 0)
  })).filter(n => n.node_name);
  state.masters.customers = [...customers].sort();
  state.masters.productSpecs = [...productMap.values()].map(({latestDate, ...item}) => item).sort((a,b)=>(a.customer+a.product_name+a.spec).localeCompare(b.customer+b.product_name+b.spec,'zh-Hant'));
  state.masters.scheduleNodes = scheduleNodes.sort((a,b)=>a.sort_order-b.sort_order).map((n,i)=>({...n, sort_order:i+1}));
  ensureProjectScheduleCopiesForAllProjects();
}
function addCustomer() {
  const name = $('newCustomerName').value.trim();
  if (!name) return toast('請輸入客戶名稱');
  if (!state.masters.customers.includes(name)) state.masters.customers.push(name);
  state.masters.customers.sort();
  $('newCustomerName').value = '';
  writeStore(); renderAll(); toast('已新增客戶');
}
function addProductSpec() {
  const customer = $('masterCustomerSelect').value;
  const product = $('newProductName').value.trim();
  const spec = $('newProductSpec').value.trim();
  const status = $('newProductStatus')?.value || '進行中';
  if (!customer) return toast('請先選客戶');
  if (!product) return toast('請輸入產品口味');
  const exists = state.masters.productSpecs.some(p => p.customer === customer && p.product_name === product && (p.spec || '') === spec);
  if (!exists) state.masters.productSpecs.push({ id: uid(), customer, product_name: product, spec, status });
  $('newProductName').value = '';
  $('newProductSpec').value = '';
  normalizeMasters(); writeStore(); renderAll(); toast('已新增產品口味＋規格');
}
async function removeCustomer(name) {
  if (!confirm(`確定移除「${name}」？既有工作記錄不會刪除，只會從設定主檔移除。`)) return;
  if (supabaseAuthenticated()) {
    try {
      await supabaseService().softDeleteByColumn('customers', 'name', name);
      await supabaseService().softDeleteByColumn('product_specs', 'customer', name);
    } catch (err) { showSupabaseError('移除客戶失敗', err); return; }
  }
  state.masters.customers = state.masters.customers.filter(c => c !== name);
  state.masters.productSpecs = state.masters.productSpecs.filter(p => p.customer !== name);
  writeStore(); renderAll(); toast('已移除客戶主檔');
}
async function removeProductSpec(id) {
  const item = state.masters.productSpecs.find(p => p.id === id);
  const key = item ? productSpecKey(item) : '';
  if (supabaseAuthenticated()) {
    try {
      await supabaseService().softDeleteByColumn('product_specs', 'id', id);
      if (key) await supabaseService().softDeleteByColumn('project_schedules', 'project_key', key);
    } catch (err) { showSupabaseError('移除產品規格失敗', err); return; }
  }
  state.masters.productSpecs = state.masters.productSpecs.filter(p => p.id !== id);
  if (key) delete state.projectSchedules[key];
  writeStore(); renderAll(); toast('已移除產品口味＋規格');
}

function addScheduleNode() {
  const node_name = $('newScheduleNodeName').value.trim();
  const department = $('newScheduleDepartment')?.value.trim() || '';
  const work_days = Number($('newScheduleWorkDays').value || 0);
  if (!node_name) return toast('請輸入節點名稱');
  if (work_days < 0) return toast('工作日數不可小於 0');
  state.masters.scheduleNodes.push({ id: uid(), sort_order: state.masters.scheduleNodes.length + 1, node_name, department, work_days });
  $('newScheduleNodeName').value = '';
  if ($('newScheduleDepartment')) $('newScheduleDepartment').value = '';
  $('newScheduleWorkDays').value = '';
  normalizeMasters(); writeStore(); renderAll(); toast('已新增時程節點');
}
async function removeScheduleNode(id) {
  if (supabaseAuthenticated()) { try { await supabaseService().softDeleteByColumn('schedule_nodes', 'id', id); } catch (err) { showSupabaseError('移除時程節點失敗', err); return; } }
  state.masters.scheduleNodes = state.masters.scheduleNodes.filter(n => n.id !== id);
  normalizeMasters(); writeStore(); renderAll(); toast('已移除時程節點');
}
function moveScheduleNode(id, direction) {
  const list = [...state.masters.scheduleNodes].sort((a,b)=>a.sort_order-b.sort_order);
  const i = list.findIndex(n => n.id === id);
  const j = i + direction;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  state.masters.scheduleNodes = list.map((n, idx) => ({...n, sort_order: idx + 1}));
  writeStore(); renderAll();
}
function resetScheduleNodes() {
  if (!confirm('恢復預設上市時程節點？目前自訂節點會被取代。')) return;
  state.masters.scheduleNodes = (window.defaultScheduleNodes || []).map((n, i) => ({ id: uid(), sort_order: i + 1, ...n }));
  writeStore(); renderAll(); toast('已恢復預設時程節點');
}
function renderSettings() {
  const customerOptions = state.masters.customers.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  const mcs = $('masterCustomerSelect');
  const keep = mcs?.value;
  if (mcs) mcs.innerHTML = customerOptions || '<option value="">請先新增客戶</option>';
  if (keep && state.masters.customers.includes(keep)) mcs.value = keep;

  $('customerMasterList').innerHTML = state.masters.customers.map(c => `
    <div class="master-item"><span>${escapeHtml(c)}</span><button class="mini danger" data-remove-customer="${escapeHtml(c)}">移除</button></div>
  `).join('') || '<p class="empty">尚未設定客戶。可先匯入 Excel 或手動新增。</p>';

  const selected = $('masterCustomerSelect')?.value || state.masters.customers[0] || '';
  const list = state.masters.productSpecs.filter(p => !selected || p.customer === selected);
  $('productSpecMasterList').innerHTML = list.map(p => {
    const key = productSpecKey(p);
    const showSchedule = state.scheduleEditorProject === key;
    const showProjectInfo = state.expandedProjectInfo.has(key);
    return `<div class="product-master-block">
      <div class="master-item product-status-item">
        <span><b>${escapeHtml(p.product_name)}</b>${p.spec ? '｜' + escapeHtml(p.spec) : ''}</span>
        <select class="mini-select" data-product-status="${p.id}">${STATUSES.map(st=>`<option value="${st}" ${st===(p.status || '進行中')?'selected':''}>${st}</option>`).join('')}</select>
        <button class="mini" data-toggle-schedule="${escapeHtml(key)}">${showSchedule ? '收合上市時程' : '設定上市時程'}</button>
        <button class="mini" data-toggle-project-info="${escapeHtml(key)}">${showProjectInfo ? '收合專案資料' : '專案資料'}</button>
        <button class="mini danger" data-remove-product="${p.id}">移除</button>
      </div>
      ${showProjectInfo ? renderProjectInfoEditor(key) : ''}
      ${showSchedule ? renderProjectScheduleEditor(key) : ''}
    </div>`;
  }).join('') || '<p class="empty">這個客戶尚未設定產品口味＋規格。</p>';

  const nodes = state.masters.scheduleNodes || [];
  $('scheduleNodeMasterList').innerHTML = nodes.map((n, i) => `
    <div class="master-item schedule-node-item">
      <span><b>${i+1}. ${escapeHtml(n.node_name)}</b><small>${Number(n.work_days || 0)} 個工作日</small></span>
      <span class="node-actions"><button class="mini" data-node-up="${n.id}">上移</button><button class="mini" data-node-down="${n.id}">下移</button><button class="mini danger" data-remove-node="${n.id}">移除</button></span>
    </div>
  `).join('') || '<p class="empty">尚未設定時程節點。</p>';
}

function updateProductSpecOptions() {
  const customer = $('customer')?.value || '';
  const list = state.masters.productSpecs.filter(p => p.customer === customer && (p.status || '進行中') === '進行中');
  $('productSpecList').innerHTML = list.map(p => `<option value="${escapeHtml(comboValue(p.product_name, p.spec))}"></option>`).join('');
}
function applyComboToHiddenFields() {
  const { product_name, spec } = splitCombo($('productSpecCombo').value);
  $('productName').value = product_name;
  $('spec').value = spec;
}
function findProductSpecMaster(customer, product, spec) {
  return state.masters.productSpecs.find(p => p.customer === customer && p.product_name === product && (p.spec || '') === (spec || ''));
}
function updateProductMasterStatus(id, status) {
  const item = state.masters.productSpecs.find(p => p.id === id);
  if (!item) return;
  item.status = status;
  writeStore(); renderAll(); toast('已更新產品狀態');
}
function switchSettingsTab(tab) {
  document.querySelectorAll('.settings-tab').forEach(b => b.classList.toggle('active', b.dataset.settingsTab === tab));
  document.querySelectorAll('.settings-panel').forEach(p => p.classList.toggle('active', p.dataset.settingsPanel === tab));
}

function groupProjects() {
  const map = new Map();
  state.records.forEach(r => {
    const key = projectKey(r);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  });
  return [...map.entries()].map(([key, records]) => {
    records.sort((a,b)=>(b.record_date||'').localeCompare(a.record_date||''));
    const latest = records[0];
    const open = records.filter(isOpen);
    const milestones = records.filter(r => r.milestone_type || r.milestone_date);
    return { key, records, latest, openCount: open.length, count: records.length, milestones };
  }).sort((a,b)=>(b.latest.record_date||'').localeCompare(a.latest.record_date||''));
}
function switchView(view) {
  state.activeView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === view));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  renderAll();
}
function getFormRecord() {
  applyComboToHiddenFields();
  return normalizeRecord({
    id: $('recordId').value || undefined,
    record_date: $('recordDate').value,
    customer: $('customer').value.trim(),
    product_name: $('productName').value.trim(),
    spec: $('spec').value.trim(),
    work_type: $('workType').value,
    stage: inferStage({work_type: $('workType').value, notes: $('notes').value, title: $('notes').value}),
    status: (findProductSpecMaster($('customer').value.trim(), $('productName').value.trim(), $('spec').value.trim())?.status || '進行中'),
    title: $('notes').value.trim().split('\n')[0] || '未命名記事',
    notes: $('notes').value.trim(),
    next_action: '',
    waiting_for: '',
    follow_up_date: '',
    milestone_type: '',
    milestone_date: '',
    priority: '普通',
    sample_version: $('sampleVersion').value.trim(),
    photo_path: $('photoPath').value.trim(),
    close_reason: ''
  });
}
function ensureSelectOption(select, value, label = value) {
  if (!select || !value) return;
  const exists = [...select.options].some(option => option.value === value);
  if (!exists) select.add(new Option(label, value));
}
function fillForm(r) {
  const customerSelect = $('customer');
  const customerValue = r?.customer || state.masters.customers[0] || '';

  // 編輯既有記錄時，即使該客戶或產品目前不是「進行中」，仍必須能顯示原資料。
  ensureSelectOption(customerSelect, customerValue);
  $('recordId').value = r?.id || '';
  $('recordDate').value = r?.record_date || today;
  customerSelect.value = customerValue;
  updateProductSpecOptions();

  $('productSpecCombo').value = r ? comboValue(r.product_name, r.spec) : '';
  $('productName').value = r?.product_name || '';
  $('spec').value = r?.spec || '';
  $('workType').value = r?.work_type || '一般記事';
  $('notes').value = r?.notes || r?.title || '';
  $('sampleVersion').value = r?.sample_version || '';
  $('photoPath').value = r?.photo_path || '';
  $('formTitle').textContent = r ? '編輯工作記錄' : '新增 / 編輯工作記錄';
  resizeAllTextareas($('recordForm'));
}
function saveForm(e) {
  e.preventDefault();
  const r = getFormRecord();
  const idx = state.records.findIndex(x => String(x.id) === String(r.id));
  if (idx >= 0) state.records[idx] = r; else state.records.unshift(r);
  normalizeMasters(); writeStore(); fillForm(null); renderAll(); toast('已儲存記錄');
}
function editRecord(id) {
  const r = state.records.find(x => String(x.id) === String(id));
  if (!r) return toast('找不到要編輯的工作記錄，請重新整理後再試');
  if (!canEditRecord(r)) return editOnlyHint();

  // 不呼叫 switchView()，避免它先 renderAll() 重建下拉選單與表單，造成待編輯資料被清空。
  state.activeView = 'log';
  document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === 'log'));
  document.querySelectorAll('.nav-btn').forEach(button => button.classList.toggle('active', button.dataset.view === 'log'));
  fillForm(r);

  requestAnimationFrame(() => {
    const form = $('recordForm');
    if (form) form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('notes')?.focus({ preventScroll: true });
  });
}
async function removeRecord(id) {
  const target = state.records.find(r => r.id === id);
  if (!canEditRecord(target)) return editOnlyHint();
  if (!confirm('確定刪除這筆記錄？v24 會使用軟刪除，資料庫會保留刪除紀錄。')) return;
  if (supabaseAuthenticated()) {
    try { await supabaseService().softDeleteByColumn('work_records', 'id', id); } catch (err) { showSupabaseError('刪除工作記錄失敗', err); return; }
  }
  state.records = state.records.filter(r => r.id !== id);
  normalizeMasters(); writeStore(); renderAll(); toast('已刪除');
}
function closeRecord(id) { const r = state.records.find(x => x.id === id); if (!r) return; if (!canEditRecord(r)) return editOnlyHint(); r.status = '已結案'; r.stage = '結案'; r.updated_at = new Date().toISOString(); writeStore(); renderAll(); toast('已標示結案'); }
function duplicateRecord() {
  const r = getFormRecord();
  r.id = uid();
  r.created_at = new Date().toISOString();
  r.updated_at = new Date().toISOString();
  // v35：複製成新記錄時保留表單目前選擇的日期，不再強制改成今天。
  state.records.unshift(r);
  normalizeMasters();
  writeStore();
  renderAll();
  toast(`已複製成 ${r.record_date || '未設定日期'} 的新記錄`);
}

function filteredRecords() {
  const keyword = ($('keyword')?.value || '').trim().toLowerCase();
  const customer = $('customerFilter')?.value || '';
  const status = $('statusFilter')?.value || '';
  const type = $('typeFilter')?.value || '';
  return state.records.filter(r => {
    const text = `${r.customer} ${r.product_name} ${r.spec} ${r.title} ${r.notes}`.toLowerCase();
    return (!keyword || text.includes(keyword)) && (!customer || r.customer === customer) && (!status || r.status === status) && (!type || r.work_type === type);
  }).sort((a,b)=>(b.record_date||'').localeCompare(a.record_date||''));
}
function recordCard(r, compact=false) {
  const overdue = r.follow_up_date && isOpen(r) && r.follow_up_date < today;
  const note = (r.notes || r.title || '未填記事內容').trim();
  return `<article class="record-card ${overdue ? 'overdue' : ''}">
    <div class="record-top"><strong>${escapeHtml(r.customer || '未填客戶')}｜${escapeHtml(r.product_name || '未填產品')}</strong><span class="badge status-${r.status}">${r.status}</span></div>
    <div class="record-meta">${r.record_date || '-'}　${escapeHtml(r.spec || '')}　${escapeHtml(r.work_type || '')}</div>
    ${compact ? '' : `<p class="record-note">${escapeHtml(note).slice(0, 220)}</p>`}
    <div class="card-actions"><button class="mini" data-view-record="${r.id}">查</button>${canEditRecord(r) ? `<button class="mini" data-edit="${r.id}">改</button><button class="mini" data-close="${r.id}">結案</button><button class="mini danger" data-delete="${r.id}">刪除</button>` : '<span class="pill">他人記錄｜僅可查閱</span>'}</div>
  </article>`;
}
function renderStats() {
  const projects = groupProjects();
  const open = state.records.filter(isOpen);
  const scheduledProjects = Object.values(state.projectSchedules || {}).filter(hasProjectScheduleDates).length;
  $('statsGrid').innerHTML = [
    ['客戶主檔', state.masters.customers.length, '設定好的客戶'], ['產品規格', state.masters.productSpecs.length, '產品口味＋規格'], ['時程節點', state.masters.scheduleNodes.length, '上市流程範本'], ['工作記錄', state.records.length, '全部記事筆數'], ['專案數', projects.length, '客戶 × 產品 × 規格'], ['已填日期時程', scheduledProjects, '已有日期設定的專案']
  ].map(([a,b,c])=>`<div class="stat"><span>${a}</span><strong>${b}</strong><em>${c}</em></div>`).join('');
  $('todayFollowups').innerHTML = projects.filter(p => hasProjectScheduleDates(state.projectSchedules[p.key])).slice(0,8).map(p => `<button class="mini-line" data-open-schedule="${escapeHtml(p.key)}"><b>${escapeHtml(p.key.split('｜')[0])}</b> ${escapeHtml(p.key.split('｜')[1] || '')}<span>已設上市時程</span></button>`).join('') || '<p class="empty">目前尚未在【設定 → 產品口味＋規格＋狀態】設定上市時程。</p>';
  $('recentRecords').innerHTML = [...state.records].sort((a,b)=>(b.record_date||'').localeCompare(a.record_date||'')).slice(0,8).map(r => miniLine(r)).join('') || '<p class="empty">尚無資料。</p>';
}
function miniLine(r) { return `<button class="mini-line" data-edit="${r.id}"><b>${escapeHtml(r.customer)}</b> ${escapeHtml(r.product_name)}<span>${r.follow_up_date || r.record_date || ''}</span></button>`; }
function renderFilters() {
  const customers = state.masters.customers;
  const activeCustomers = [...new Set(state.masters.productSpecs.filter(p => (p.status || '進行中') === '進行中').map(p => p.customer))].sort();
  const statuses = STATUSES;
  const types = ['一般記事','樣品','送驗/報告','包裝審查','設計/版面','料號/條碼','成分營養標','請購/發包','試俥/生產','出貨/上市','會議/討論','其他'];

  const customerSelect = $('customer');
  const keepQuick = customerSelect.value;
  customerSelect.innerHTML = '<option value="">請選擇客戶</option>' + activeCustomers.map(v=>`<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  if (keepQuick && activeCustomers.includes(keepQuick)) customerSelect.value = keepQuick;
  updateProductSpecOptions();

  const cf = $('customerFilter'); const keepC = cf.value; cf.innerHTML = '<option value="">全部客戶</option>' + customers.map(v=>`<option ${v===keepC?'selected':''}>${escapeHtml(v)}</option>`).join('');
  const sf = $('statusFilter'); const keepS = sf.value; sf.innerHTML = '<option value="">全部狀態</option>' + statuses.map(v=>`<option ${v===keepS?'selected':''}>${v}</option>`).join('');
  const tf = $('typeFilter'); const keepT = tf.value; tf.innerHTML = '<option value="">全部類型</option>' + types.map(v=>`<option ${v===keepT?'selected':''}>${v}</option>`).join('');
}
function renderRecords() {
  const list = filteredRecords();
  $('recordCount').textContent = `${list.length} 筆`;
  $('recordsList').innerHTML = list.map(r => recordCard(r)).join('') || '<p class="empty">沒有符合條件的資料。</p>';
}
function getScheduleForProject(key) {
  const existing = state.projectSchedules[key];
  if (existing) return ensureProjectScheduleCopy(key, true);
  return { mode: 'forward', baseDate: '', targetDate: '', nodeDates: {}, projectInfo: DEFAULT_PROJECT_INFO, scheduleNodes: [] };
}
function getProjectInfo(key) {
  const config = getScheduleForProject(key);
  return (typeof config.projectInfo === 'string' && config.projectInfo.trim()) ? config.projectInfo : DEFAULT_PROJECT_INFO;
}
function getProductSpecByProjectKey(key) {
  const [customer, product_name, spec = ''] = String(key || '').split('｜');
  return state.masters.productSpecs.find(p =>
    (p.customer || '') === (customer || '') &&
    (p.product_name || '') === (product_name || '') &&
    (p.spec || '') === (spec || '')
  );
}
function projectStatusByKey(key) {
  return getProductSpecByProjectKey(key)?.status || '進行中';
}
function hasProjectScheduleDates(config) {
  if (!config) return false;
  if (config.baseDate || config.targetDate) return true;
  return Object.values(config.nodeDates || {}).some(d => d && (d.start_date || d.planned_date || d.actual_date));
}
function renderProjectInfoEditor(key) {
  return `<section class="project-info-box open settings-project-info">
    <div class="project-info-header"><strong>專案資料</strong></div>
    <textarea data-project-info="${escapeHtml(key)}" rows="11" placeholder="請輸入專案資料">${escapeHtml(getProjectInfo(key))}</textarea>
  </section>`;
}
function hasOwn(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj || {}, prop);
}
function renderScheduleDateControl(projectKey, nodeId, field, value, title) {
  const attr = field === 'planned_date' ? 'data-schedule-planned' : (field === 'start_date' ? 'data-schedule-start' : 'data-schedule-actual');
  const safeTitle = title ? ` title="${escapeHtml(title)}"` : '';
  return `<div class="schedule-date-control"><input class="table-date-input" ${attr}="${escapeHtml(projectKey)}" data-node-id="${escapeHtml(nodeId)}" type="date" value="${escapeHtml(value || '')}"${safeTitle} /></div>`;
}
function calculateProjectSchedule(key) {
  const config = getScheduleForProject(key);
  const nodes = Array.isArray(config.scheduleNodes) ? config.scheduleNodes : [];
  const saved = config.nodeDates || {};
  if (!nodes.length) return [];
  let rows = [];
  if (config.mode === 'backward') {
    if (!config.targetDate) return [];
    rows = nodes.map(n => ({...n, planned_date: ''}));
    let current = config.targetDate;
    for (let i = rows.length - 1; i >= 0; i--) {
      rows[i].planned_date = current;
      if (i > 0) current = subtractWorkDays(current, Number(rows[i].work_days || 0));
    }
  } else {
    if (!config.baseDate) return [];
    let current = config.baseDate;
    rows = nodes.map((n, i) => {
      current = i === 0 ? config.baseDate : addWorkDays(current, Number(n.work_days || 0));
      return {...n, planned_date: current};
    });
  }
  let previousPlanned = '';
  return rows.map((n, i) => {
    const item = saved[n.id] || {};
    const planned = hasOwn(item, 'planned_date') ? (item.planned_date || '') : (n.planned_date || '');
    const calculatedStart = config.mode === 'backward'
      ? subtractWorkDays(planned, Number(n.work_days || 0))
      : (i === 0 ? (config.baseDate || '') : previousPlanned);
    previousPlanned = planned;
    return {
      ...n,
      start_date: hasOwn(item, 'start_date') ? (item.start_date || '') : '',
      planned_date: planned,
      calculated_date: n.planned_date || '',
      actual_date: hasOwn(item, 'actual_date') ? (item.actual_date || '') : ''
    };
  });
}
function renderProjectScheduleEditor(projectKey) {
  const config = ensureProjectScheduleCopy(projectKey, true) || getScheduleForProject(projectKey);
  const calculatedRows = calculateProjectSchedule(projectKey);
  const saved = config.nodeDates || {};
  const rows = calculatedRows.length ? calculatedRows : (config.scheduleNodes || []).slice().sort((a,b)=>Number(a.sort_order || 0)-Number(b.sort_order || 0)).map(n => ({
    ...n,
    start_date: saved[n.id]?.start_date || '',
    planned_date: saved[n.id]?.planned_date || '',
    calculated_date: '',
    actual_date: saved[n.id]?.actual_date || ''
  }));
  return `<div class="schedule-editor">
    <h4>上市時程設定</h4>
    <div class="schedule-header-row">
      <label class="schedule-mode-field">推算方式
        <select data-schedule-mode="${escapeHtml(projectKey)}">
          <option value="forward" ${config.mode !== 'backward' ? 'selected' : ''}>由第一個節點往後推</option>
          <option value="backward" ${config.mode === 'backward' ? 'selected' : ''}>由目標上市 / 可出貨日往前推</option>
        </select>
      </label>
      <label>第一節點起算日<input data-schedule-base="${escapeHtml(projectKey)}" type="date" value="${escapeHtml(config.baseDate || '')}" /></label>
      <label>目標上市 / 可出貨日<input data-schedule-target="${escapeHtml(projectKey)}" type="date" value="${escapeHtml(config.targetDate || '')}" /></label>
    </div>
    <div class="schedule-node-add-row schedule-node-add-row-no-dept">
      <input data-project-node-new-name="${escapeHtml(projectKey)}" type="text" placeholder="新增工作項目" />
      <input data-project-node-new-days="${escapeHtml(projectKey)}" type="number" min="0" step="1" value="0" placeholder="天數" aria-label="天數" />
      <button type="button" class="mini" data-project-node-add="${escapeHtml(projectKey)}">新增專案時程節點</button>
    </div>
    <div class="schedule-table-wrap no-inner-scroll">
      <table class="field-table compact-table editable-schedule-table"><thead><tr><th>#</th><th>工作項目</th><th>工作日</th><th>推估完成日</th><th>開始執行日</th><th>實際完成日</th><th>操作</th></tr></thead>
      <tbody>${rows.map((n,i)=>`<tr>
        <td>${i+1}</td>
        <td><input class="table-text-input" data-project-node-name="${escapeHtml(projectKey)}" data-node-id="${escapeHtml(n.id)}" type="text" value="${escapeHtml(n.node_name)}" /></td>
        <td><input class="table-number-input" data-project-node-days="${escapeHtml(projectKey)}" data-node-id="${escapeHtml(n.id)}" type="number" min="0" step="1" value="${Number(n.work_days || 0)}" /></td>
        <td>${renderScheduleDateControl(projectKey, n.id, 'planned_date', n.planned_date, `原推算：${n.calculated_date || '未設定'}`)}</td>
        <td>${renderScheduleDateControl(projectKey, n.id, 'start_date', n.start_date, '')}</td>
        <td>${renderScheduleDateControl(projectKey, n.id, 'actual_date', n.actual_date, '')}</td>
        <td><span class="node-actions"><button class="mini" data-project-node-up="${escapeHtml(projectKey)}" data-node-id="${escapeHtml(n.id)}">上移</button><button class="mini" data-project-node-down="${escapeHtml(projectKey)}" data-node-id="${escapeHtml(n.id)}">下移</button><button class="mini danger" data-project-node-remove="${escapeHtml(projectKey)}" data-node-id="${escapeHtml(n.id)}">移除</button></span></td>
      </tr>`).join('') || '<tr><td colspan="7">此專案尚無時程節點。可按上方「新增專案時程節點」。</td></tr>'}</tbody></table>
    </div>
  </div>`;
}

function renderProjects() {
  const q = ($('projectSearch')?.value || '').trim().toLowerCase();
  const projects = groupProjects().filter(p => !q || p.key.toLowerCase().includes(q));
  $('projectBoard').innerHTML = projects.map(p => {
    const parts = p.key.split('｜');
    const age = p.latest.record_date ? daysBetween(p.latest.record_date) : '';
    const expanded = state.expandedProjects.has(p.key);
    const recordsToShow = expanded ? p.records : p.records.slice(0, 3);
    const scheduleRows = calculateProjectSchedule(p.key);
    const config = getScheduleForProject(p.key);
    const projectStatus = projectStatusByKey(p.key);
    const scheduleSummary = scheduleRows.length ? `${scheduleRows[0].planned_date || '-'} → ${scheduleRows[scheduleRows.length-1].planned_date || '-'}` : '尚未設定';
    return `<article class="project-card project-card-wide">
      <div class="record-top"><strong>${escapeHtml(parts[0])}</strong><span class="pill">${p.count} 筆歷程</span></div>
      <h3>${escapeHtml(parts[1])}</h3>
      <p class="record-meta">規格：${escapeHtml(parts[2] || '未填')}｜最後更新：${p.latest.record_date || '-'} ${age!=='' ? `｜${age} 天前` : ''}｜狀態：${escapeHtml(projectStatus)}</p>
      <div class="project-schedule-summary"><b>上市時程：</b>${escapeHtml(scheduleSummary)} ${config.mode === 'backward' ? '<span class="pill">倒推</span>' : '<span class="pill">順推</span>'}</div>
      <div class="card-actions"><button class="mini" data-project="${escapeHtml(p.key)}">看時間軸</button><button class="mini" data-open-schedule="${escapeHtml(p.key)}">到設定修改上市時程</button><button class="mini" data-toggle-project="${escapeHtml(p.key)}">${expanded ? '收合記錄' : '展開全部記錄'}</button>${canEditRecord(p.latest) ? `<button class="mini" data-edit="${p.latest.id}">編輯最新</button>` : ''}</div>
      <div class="project-records"><h4>${expanded ? '全部記錄' : '最新 3 筆'}</h4>${recordsToShow.map(r => `<div class="project-record-line"><b>${r.record_date || '-'}</b><span>${escapeHtml(r.work_type || '')}</span><p>${escapeHtml(r.notes || r.title || '').slice(0,160)}</p>${canEditRecord(r) ? `<button class="mini" data-edit="${r.id}">編輯</button>` : '<span class="pill">他人記錄</span>'}</div>`).join('')}</div>
    </article>`;
  }).join('') || '<p class="empty">尚無專案資料。</p>';
}
function renderTimeline(selectedKey) {
  const select = $('timelineProjectSelect');
  const projects = groupProjects();
  const prev = selectedKey || select.value || projects[0]?.key || '';
  select.innerHTML = projects.map(p=>`<option value="${escapeHtml(p.key)}" ${p.key===prev?'selected':''}>${escapeHtml(p.key)}（${p.count}筆）</option>`).join('');
  const key = select.value;
  const records = projects.find(p=>p.key===key)?.records || [];
  const projectStatus = projectStatusByKey(key);
  const timelineItems = records.sort((a,b)=>(a.record_date||'').localeCompare(b.record_date||'')).map(r=>`<div class="time-item"><div class="time-date">${r.record_date}</div><div class="time-body"><b>${escapeHtml(r.work_type)}｜${escapeHtml((r.notes || r.title || '').split('\n')[0])}</b><p>${escapeHtml(r.notes)}</p></div></div>`).join('');
  $('timelineList').innerHTML = key ? `<div class="timeline-project-status"><b>產品規格狀態：</b><span class="badge status-${escapeHtml(projectStatus)}">${escapeHtml(projectStatus)}</span></div>${timelineItems || '<p class="empty">請先建立資料。</p>'}` : '<p class="empty">請先建立資料。</p>';
}
function followupRecords() {
  const open = state.records.filter(isOpen);
  const weekLimit = new Date(); weekLimit.setDate(weekLimit.getDate()+7); const week = weekLimit.toISOString().slice(0,10);
  if (state.currentFollowMode === 'overdue') return open.filter(r => r.follow_up_date && r.follow_up_date < today);
  if (state.currentFollowMode === 'today') return open.filter(r => r.follow_up_date === today);
  if (state.currentFollowMode === 'week') return open.filter(r => r.follow_up_date && r.follow_up_date <= week);
  if (state.currentFollowMode === 'waiting') return open.filter(r => r.waiting_for);
  return open;
}
function renderFollowups() { $('followupList').innerHTML = followupRecords().sort((a,b)=>(a.follow_up_date||'9999').localeCompare(b.follow_up_date||'9999')).map(r => recordCard(r)).join('') || '<p class="empty">這個分類目前沒有資料。</p>'; }
function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${y}年${m}月`;
}
function getCalendarEvents(months) {
  return state.records.flatMap(r => {
    const arr = [];
    if (r.record_date) arr.push({date:r.record_date, label:r.work_type || '記事', r});
    return arr;
  }).filter(e => e.date && months.some(mm => e.date.startsWith(mm)));
}
function monthRange() {
  const input = $('calendarMonth');
  if (!input.value) input.value = today.slice(0,7);
  const months = [];
  for (let i = state.calendarStartOffset; i <= state.calendarEndOffset; i++) months.push(shiftMonth(input.value, i));
  return months;
}
function monthCellDate(ym, day) {
  return `${ym}-${String(day).padStart(2,'0')}`;
}
function renderCalendarEvent(e) {
  const note = (e.r.notes || e.r.title || '').split('\n')[0] || e.label;
  const text = `${e.label}｜${e.r.customer || ''}｜${e.r.product_name || ''}${e.r.spec ? '｜' + e.r.spec : ''}`;
  return `<div class="cal-event-row two-line-event">
    <div class="cal-event-text"><b>${escapeHtml(text)}</b><span>${escapeHtml(note).slice(0,70)}</span></div>
    <div class="cal-event-actions"><button class="cal-mini" data-view-record="${e.r.id}">查</button>${canEditRecord(e.r) ? `<button class="cal-mini" data-edit="${e.r.id}">改</button>` : ''}</div>
  </div>`;
}
function renderOneMonth(ym, events, position) {
  const [y,m] = ym.split('-').map(Number);
  const first = new Date(y, m-1, 1);
  const startPad = first.getDay();
  const days = new Date(y, m, 0).getDate();
  const prevDays = new Date(y, m-1, 0).getDate();
  const lastDay = new Date(y, m-1, days).getDay();
  const trailCount = 6 - lastDay;
  let html = `<section class="calendar-month-card"><h3>${monthLabel(ym)}</h3><div class="calendar-grid">`;
  html += ['日','一','二','三','四','五','六'].map(d=>`<div class="cal-head">${d}</div>`).join('');

  // v14：上一月按鈕固定放在「本月第一天前一格」。若本月 1 號剛好是星期日，
  // 就額外插入一格控制格，避免一開始進入月曆時找不到按鈕。
  if ((position === 'first' || position === 'only') && startPad === 0) {
    html += `<div class="cal-cell calendar-control-cell"><button class="month-cell-btn" data-calendar-more="prev" type="button">再上月</button></div>`;
  }
  for (let i=0;i<startPad;i++) {
    const day = prevDays - startPad + i + 1;
    const isControl = (position === 'first' || position === 'only') && i === startPad - 1;
    html += `<div class="cal-cell outside-month"><b>${day}</b>${isControl ? '<button class="month-cell-btn" data-calendar-more="prev" type="button">再上月</button>' : ''}</div>`;
  }

  for (let d=1; d<=days; d++) {
    const date = monthCellDate(ym, d);
    const dayEvents = events.filter(e=>e.date===date);
    html += `<div class="cal-cell"><b>${d}</b>${dayEvents.map(renderCalendarEvent).join('')}</div>`;
  }

  // v14：下一月按鈕固定放在「本月最後一天後一格」。不再只依賴補空白日期，
  // 所以第一次點進【月曆/日期清單】時一定看得到「再下月」。
  if (position === 'last' || position === 'only') {
    html += `<div class="cal-cell calendar-control-cell"><button class="month-cell-btn" data-calendar-more="next" type="button">再下月</button></div>`;
    for (let i=2;i<=trailCount;i++) {
      html += `<div class="cal-cell outside-month"><b>${i}</b></div>`;
    }
  } else {
    for (let i=1;i<=trailCount;i++) {
      html += `<div class="cal-cell outside-month"><b>${i}</b></div>`;
    }
  }
  html += '</div></section>';
  return html;
}
function renderCalendar() {
  const input = $('calendarMonth'); if (!input.value) input.value = today.slice(0,7);
  const months = monthRange();
  const events = getCalendarEvents(months);
  $('calendarGrid').innerHTML = months.map((mm, idx) => {
    const position = months.length === 1 ? 'only' : (idx === 0 ? 'first' : (idx === months.length - 1 ? 'last' : 'middle'));
    return renderOneMonth(mm, events, position);
  }).join('');
  $('dateAgenda').innerHTML = events.sort((a,b)=>a.date.localeCompare(b.date)).map(e=>`<div class="mini-line agenda-line two-line-agenda"><div><b>${e.date}</b><span>${escapeHtml(e.label)}｜${escapeHtml(e.r.customer)}｜${escapeHtml(e.r.product_name)}${e.r.spec ? '｜' + escapeHtml(e.r.spec) : ''}</span></div><span><button class="cal-mini" data-view-record="${e.r.id}">查</button>${canEditRecord(e.r) ? `<button class="cal-mini" data-edit="${e.r.id}">改</button>` : ''}</span></div>`).join('') || '<p class="empty">目前顯示的月份沒有日期資料。</p>';
}
function viewRecord(id) {
  const r = state.records.find(x => x.id === id);
  if (!r) return;
  $('recordModalTitle').textContent = `${r.customer || '未填客戶'}｜${r.product_name || '未填產品'}${r.spec ? '｜' + r.spec : ''}`;
  $('recordModalBody').innerHTML = `<p class="record-meta">${r.record_date || '-'}　${escapeHtml(r.work_type || '')}　<span class="badge status-${r.status}">${escapeHtml(r.status || '')}</span></p><div class="modal-note">${escapeHtml(r.notes || r.title || '未填記事內容').replace(/\n/g, '<br>')}</div>${r.sample_version ? `<p><b>樣品版本：</b>${escapeHtml(r.sample_version)}</p>` : ''}${r.photo_path ? `<p><b>照片 / 附件：</b><code>${escapeHtml(r.photo_path)}</code></p>` : ''}<div class="card-actions">${canEditRecord(r) ? `<button class="btn primary" data-edit="${r.id}">改這筆</button>` : '<span class="pill">他人建立的工作記錄，僅可查閱</span>'}</div>`;
  $('recordModal').classList.add('show');
  $('recordModal').setAttribute('aria-hidden', 'false');
  bindDynamicActions();
}
function closeRecordModal() {
  $('recordModal').classList.remove('show');
  $('recordModal').setAttribute('aria-hidden', 'true');
}
function renderSamples() {
  const list = state.records.filter(r => r.sample_version || r.work_type === '樣品');
  $('sampleList').innerHTML = list.map(r => `<article class="sample-card"><strong>${escapeHtml(r.customer)}｜${escapeHtml(r.product_name)}</strong><span class="pill">${escapeHtml(r.sample_version || '未填版本')}</span><p>${r.record_date}｜${escapeHtml((r.notes || r.title || '').slice(0,80))}</p><p>${escapeHtml(r.notes).slice(0,120)}</p>${canEditRecord(r) ? `<button class="mini" data-edit="${r.id}">編輯</button>` : '<span class="pill">他人記錄</span>'}</article>`).join('') || '<p class="empty">尚無樣品紀錄。可在快速記錄填「樣品版本」。</p>';
}
function renderAttachments() {
  const list = state.records.filter(r => r.photo_path);
  $('attachmentList').innerHTML = list.map(r => `<article class="attachment-card"><strong>${escapeHtml(r.customer)}｜${escapeHtml(r.product_name)}</strong><p>${escapeHtml((r.notes || r.title || '').slice(0,120))}</p><code>${escapeHtml(r.photo_path)}</code>${canEditRecord(r) ? `<button class="mini" data-edit="${r.id}">編輯</button>` : '<span class="pill">他人記錄</span>'}</article>`).join('') || '<p class="empty">尚無照片/附件位置。第一版先填路徑或雲端連結。</p>';
}
function renderFields() {
  const body = $('fieldTableBody');
  if (!body) return;
  const rows = [
    ['設定主檔','客戶名稱','建立常用客戶清單','新增：這次已加入'],
    ['設定主檔','客戶的產品口味＋規格','快速記錄時依客戶帶出選項','新增：這次已加入'],
    ['快速記錄','產品口味＋規格合併選單','避免產品和規格拆開選錯','新增：這次已加入'],
    ['基本必填','日期、客戶、產品口味＋規格、記事','快速留下工作歷程','保留'],
    ['狀態管理','狀態、目前階段','取代 Excel 多分頁結案方式','保留'],
    ['快速記錄精簡','下一步、等待對象、預計追蹤日、重要節點、節點日期、優先度','這些已從快速記錄移除，避免太忙時填太多','已移除'],
    ['上市時程','設定頁節點範本＋產品專案時程','在【設定→產品口味＋規格＋狀態】中設定，可填開始執行日、推估完成日、實際完成日','已調整'],
    ['樣品','樣品版本','追蹤 V1/V2、提供時間','依使用量決定是否獨立成頁'],
    ['附件','照片/附件位置','先記外部路徑，未來再做上傳','保留'],
    ['結案','結案原因','不再獨立填寫，直接寫在記事內容中','已移除']
  ];
  body.innerHTML = rows.map(r=>`<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td></tr>`).join('');
}
function autoResizeTextarea(textarea) {
  if (!textarea || textarea.tagName !== 'TEXTAREA') return;
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.max(textarea.scrollHeight, 42)}px`;
}
function resizeAllTextareas(scope = document) {
  scope.querySelectorAll('textarea').forEach(autoResizeTextarea);
}
function renderAll() {
  renderFilters(); renderSettings(); renderStats(); renderRecords(); renderProjects(); renderTimeline(); renderFollowups(); renderCalendar(); renderSamples(); renderAttachments(); renderFields(); bindDynamicActions();
  requestAnimationFrame(() => resizeAllTextareas());
}
function bindDynamicActions() {
  document.querySelectorAll('[data-edit]').forEach(btn => btn.onclick = () => { $('recordModal')?.classList.remove('show'); editRecord(btn.dataset.edit); });
  document.querySelectorAll('[data-view-record]').forEach(btn => btn.onclick = () => viewRecord(btn.dataset.viewRecord));
  document.querySelectorAll('[data-calendar-more]').forEach(btn => btn.onclick = () => { if (btn.dataset.calendarMore === 'prev') state.calendarStartOffset -= 1; else state.calendarEndOffset += 1; renderCalendar(); bindDynamicActions(); });
  document.querySelectorAll('[data-delete]').forEach(btn => btn.onclick = () => removeRecord(btn.dataset.delete));
  document.querySelectorAll('[data-close]').forEach(btn => btn.onclick = () => closeRecord(btn.dataset.close));
  document.querySelectorAll('[data-project]').forEach(btn => btn.onclick = () => { switchView('timeline'); renderTimeline(btn.dataset.project); });
  document.querySelectorAll('[data-remove-customer]').forEach(btn => btn.onclick = () => removeCustomer(btn.dataset.removeCustomer));
  document.querySelectorAll('[data-remove-product]').forEach(btn => btn.onclick = () => removeProductSpec(btn.dataset.removeProduct));
  document.querySelectorAll('[data-product-status]').forEach(sel => sel.onchange = () => updateProductMasterStatus(sel.dataset.productStatus, sel.value));
  document.querySelectorAll('[data-remove-node]').forEach(btn => btn.onclick = () => removeScheduleNode(btn.dataset.removeNode));
  document.querySelectorAll('[data-node-up]').forEach(btn => btn.onclick = () => moveScheduleNode(btn.dataset.nodeUp, -1));
  document.querySelectorAll('[data-node-down]').forEach(btn => btn.onclick = () => moveScheduleNode(btn.dataset.nodeDown, 1));
  document.querySelectorAll('[data-toggle-project]').forEach(btn => btn.onclick = () => { const k = btn.dataset.toggleProject; state.expandedProjects.has(k) ? state.expandedProjects.delete(k) : state.expandedProjects.add(k); renderProjects(); bindDynamicActions(); });
  document.querySelectorAll('[data-toggle-project-info]').forEach(btn => btn.onclick = () => { const k = btn.dataset.toggleProjectInfo; state.expandedProjectInfo.has(k) ? state.expandedProjectInfo.delete(k) : state.expandedProjectInfo.add(k); renderSettings(); bindDynamicActions(); });
  document.querySelectorAll('[data-project-info]').forEach(el => el.onchange = () => updateProjectInfo(el.dataset.projectInfo, el.value));
  document.querySelectorAll('[data-toggle-schedule]').forEach(btn => btn.onclick = () => { const k = btn.dataset.toggleSchedule; if (state.scheduleEditorProject !== k) ensureProjectScheduleCopy(k, true); state.scheduleEditorProject = state.scheduleEditorProject === k ? '' : k; writeStore(); renderSettings(); bindDynamicActions(); });
  document.querySelectorAll('[data-open-schedule]').forEach(btn => btn.onclick = () => {
    const key = btn.dataset.openSchedule;
    const customer = key.split('｜')[0] || '';
    switchView('settings');
    switchSettingsTab('products');
    ensureProjectScheduleCopy(key, true);
    state.scheduleEditorProject = key;
    const sel = $('masterCustomerSelect');
    if (sel && customer) sel.value = customer;
    renderSettings(); bindDynamicActions(); window.scrollTo({top: 0, behavior: 'smooth'});
  });
  document.querySelectorAll('[data-schedule-mode]').forEach(el => el.onchange = () => updateProjectSchedule(el.dataset.scheduleMode, 'mode', el.value));
  document.querySelectorAll('[data-schedule-base]').forEach(el => el.onchange = () => updateProjectSchedule(el.dataset.scheduleBase, 'baseDate', el.value));
  document.querySelectorAll('[data-schedule-target]').forEach(el => el.onchange = () => updateProjectSchedule(el.dataset.scheduleTarget, 'targetDate', el.value));
  document.querySelectorAll('[data-schedule-start]').forEach(el => { el.onchange = () => updateProjectScheduleNodeDate(el.dataset.scheduleStart, el.dataset.nodeId, 'start_date', el.value); el.oninput = () => { if (!el.value) updateProjectScheduleNodeDate(el.dataset.scheduleStart, el.dataset.nodeId, 'start_date', ''); }; });
  document.querySelectorAll('[data-schedule-planned]').forEach(el => { el.onchange = () => updateProjectScheduleNodeDate(el.dataset.schedulePlanned, el.dataset.nodeId, 'planned_date', el.value); el.oninput = () => { if (!el.value) updateProjectScheduleNodeDate(el.dataset.schedulePlanned, el.dataset.nodeId, 'planned_date', ''); }; });
  document.querySelectorAll('[data-schedule-actual]').forEach(el => { el.onchange = () => updateProjectScheduleNodeDate(el.dataset.scheduleActual, el.dataset.nodeId, 'actual_date', el.value); el.oninput = () => { if (!el.value) updateProjectScheduleNodeDate(el.dataset.scheduleActual, el.dataset.nodeId, 'actual_date', ''); }; });
  document.querySelectorAll('[data-project-node-name]').forEach(el => el.onchange = () => updateProjectScheduleNode(el.dataset.projectNodeName, el.dataset.nodeId, 'node_name', el.value));
  document.querySelectorAll('[data-project-node-dept]').forEach(el => el.onchange = () => updateProjectScheduleNode(el.dataset.projectNodeDept, el.dataset.nodeId, 'department', el.value));
  document.querySelectorAll('[data-project-node-days]').forEach(el => el.onchange = () => updateProjectScheduleNode(el.dataset.projectNodeDays, el.dataset.nodeId, 'work_days', el.value));
  document.querySelectorAll('[data-project-node-add]').forEach(btn => btn.onclick = () => addProjectScheduleNode(btn.dataset.projectNodeAdd));
  document.querySelectorAll('[data-project-node-remove]').forEach(btn => btn.onclick = () => removeProjectScheduleNode(btn.dataset.projectNodeRemove, btn.dataset.nodeId));
  document.querySelectorAll('[data-project-node-up]').forEach(btn => btn.onclick = () => moveProjectScheduleNode(btn.dataset.projectNodeUp, btn.dataset.nodeId, -1));
  document.querySelectorAll('[data-project-node-down]').forEach(btn => btn.onclick = () => moveProjectScheduleNode(btn.dataset.projectNodeDown, btn.dataset.nodeId, 1));
}
function updateProjectInfo(key, value) {
  const config = ensureProjectScheduleCopy(key, true) || getScheduleForProject(key);
  state.projectSchedules[key] = {...config, nodeDates: config.nodeDates || {}, projectInfo: value || DEFAULT_PROJECT_INFO};
  writeStore();
  toast('已更新專案資料');
}
function updateProjectSchedule(key, field, value) {
  const config = ensureProjectScheduleCopy(key, true) || getScheduleForProject(key);
  state.projectSchedules[key] = {...config, nodeDates: config.nodeDates || {}, [field]: value};
  writeStore(); renderAll(); toast('已更新上市時程');
}
function normalizeProjectScheduleNodeOrder(config) {
  const nodes = (config.scheduleNodes || [])
    .filter(n => String(n.node_name || '').trim())
    .sort((a,b)=>Number(a.sort_order || 0)-Number(b.sort_order || 0))
    .map((n, idx) => ({...n, sort_order: idx + 1, work_days: Number(n.work_days || 0)}));
  return {...config, scheduleNodes: nodes};
}
function updateProjectScheduleNode(key, nodeId, field, value) {
  let config = ensureProjectScheduleCopy(key, true) || getScheduleForProject(key);
  const nodes = (config.scheduleNodes || []).map(n => {
    if (n.id !== nodeId) return n;
    if (field === 'work_days') return {...n, work_days: Math.max(0, Number(value || 0))};
    return {...n, [field]: String(value || '').trim()};
  });
  config = normalizeProjectScheduleNodeOrder({...config, scheduleNodes: nodes});
  state.projectSchedules[key] = config;
  writeStore();
  renderAll();
  toast('已更新專案時程節點');
}
function addProjectScheduleNode(key) {
  let config = ensureProjectScheduleCopy(key, true) || getScheduleForProject(key);
  const allNewNameEls = Array.from(document.querySelectorAll('[data-project-node-new-name]'));
  const nameEl = allNewNameEls.find(el => el.dataset.projectNodeNewName === key);
  const deptEl = Array.from(document.querySelectorAll('[data-project-node-new-dept]')).find(el => el.dataset.projectNodeNewDept === key);
  const daysEl = Array.from(document.querySelectorAll('[data-project-node-new-days]')).find(el => el.dataset.projectNodeNewDays === key);
  const node_name = (nameEl?.value || '').trim();
  const department = (deptEl?.value || '').trim();
  const work_days = Math.max(0, Number(daysEl?.value || 0));
  if (!node_name) return toast('請輸入工作項目名稱');
  const nodes = [...(config.scheduleNodes || []), { id: uid(), template_node_id: '', sort_order: (config.scheduleNodes || []).length + 1, node_name, department, work_days }];
  config = normalizeProjectScheduleNodeOrder({...config, scheduleNodes: nodes});
  state.projectSchedules[key] = config;
  writeStore();
  renderAll();
  toast('已新增專案時程節點');
}
function removeProjectScheduleNode(key, nodeId) {
  if (!confirm('確定移除此專案的時程節點？只會影響這個專案，不會影響預設時程節點。')) return;
  let config = ensureProjectScheduleCopy(key, true) || getScheduleForProject(key);
  const nodes = (config.scheduleNodes || []).filter(n => n.id !== nodeId);
  const nodeDates = {...(config.nodeDates || {})};
  delete nodeDates[nodeId];
  config = normalizeProjectScheduleNodeOrder({...config, scheduleNodes: nodes, nodeDates});
  state.projectSchedules[key] = config;
  writeStore();
  renderAll();
  toast('已移除專案時程節點');
}
function moveProjectScheduleNode(key, nodeId, dir) {
  let config = ensureProjectScheduleCopy(key, true) || getScheduleForProject(key);
  const nodes = (config.scheduleNodes || []).slice().sort((a,b)=>Number(a.sort_order || 0)-Number(b.sort_order || 0));
  const idx = nodes.findIndex(n => n.id === nodeId);
  const target = idx + dir;
  if (idx < 0 || target < 0 || target >= nodes.length) return;
  [nodes[idx], nodes[target]] = [nodes[target], nodes[idx]];
  // v38：交換陣列後要先重編 sort_order；不能再用舊 sort_order 排序，否則上移/下移會被還原。
  const reordered = nodes.map((n, i) => ({...n, sort_order: i + 1, work_days: Number(n.work_days || 0)}));
  config = {...config, scheduleNodes: reordered};
  state.projectSchedules[key] = config;
  writeStore();
  renderAll();
  toast('已調整專案時程節點順序');
}
function updateProjectScheduleNodeDate(key, nodeId, field, value) {
  const config = ensureProjectScheduleCopy(key, true) || getScheduleForProject(key);
  const nodeDates = {...(config.nodeDates || {})};
  nodeDates[nodeId] = {...(nodeDates[nodeId] || {}), [field]: value};
  state.projectSchedules[key] = {...config, nodeDates};
  writeStore(); renderAll();
  if (!value) {
    toast(field === 'actual_date' ? '實際完成日已設為未設定' : (field === 'start_date' ? '開始執行日已設為未設定' : '推估完成日已設為未設定'));
  } else {
    toast(field === 'actual_date' ? '已更新實際完成日' : (field === 'start_date' ? '已更新開始執行日' : '已更新推估完成日'));
  }
}
function importExcel() {
  const imported = (window.excelRecords || []).map(normalizeRecord);
  state.records = imported;
  normalizeMasters(); writeStore(); renderAll(); toast(`已匯入 ${imported.length} 筆 Excel 範例資料，並自動建立客戶/產品主檔`);
}
function seedDemo() {
  const demo = [
    {customer:'測試客戶A', product_name:'米花-海苔', spec:'60g', work_type:'樣品', status:'等待回覆', record_date:today, title:'提供 V1 樣品給業務', notes:'先模擬樣品提供紀錄，可測試樣品版本頁。', sample_version:'V1'},
    {customer:'測試客戶A', product_name:'米花-海苔', spec:'60g', work_type:'送驗/報告', status:'進行中', record_date:today, title:'安排送驗', notes:'預計取得報告後提供成分標。'},
    {customer:'測試客戶B', product_name:'米片-明太子', spec:'35g', work_type:'包裝審查', status:'待處理', record_date:today, title:'包裝審查第 1 次', notes:'檢查標示與版面文字。'},
    {customer:'內部', product_name:'新品上市準備', spec:'組合包', work_type:'出貨/上市', status:'進行中', record_date:today, title:'建立上市時程測試專案', notes:'到設定的產品口味＋規格＋狀態中按「設定上市時程」，輸入起算日即可推算。'},
    {customer:'測試客戶C', product_name:'米花-焦糖', spec:'80g', work_type:'設計/版面', status:'已結案', record_date:addDays(-10), title:'客戶取消此版本', notes:'客戶取消此版本，結案原因直接寫在記事內容。'}
  ].map(normalizeRecord);
  state.records = [...demo, ...state.records]; normalizeMasters(); writeStore(); renderAll(); toast('已建立模擬資料，並自動建立主檔');
}
function addDays(n) { const d = new Date(); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); }

function supabaseService() { return window.WR_SUPABASE_SERVICE; }
function supabaseReady() { return !!(supabaseService()?.isReady && supabaseService().isReady()); }
function supabaseAuthenticated() { return !!(supabaseService()?.isAuthenticated && supabaseService().isAuthenticated()); }
function currentUserId() { return supabaseService()?.getUser?.()?.id || ''; }
function canEditRecord(r) { return !r?.owner_id || !currentUserId() || r.owner_id === currentUserId(); }
function editOnlyHint() { toast('這筆工作記錄由其他帳號建立，只能查閱，不能修改或刪除'); }
function currentSupabaseUser() { return supabaseService()?.getUser ? supabaseService().getUser() : null; }
function hasRemoteData(remote) {
  return Boolean((remote.records || []).length || (remote.masters?.customers || []).length || (remote.masters?.productSpecs || []).length || (remote.masters?.scheduleNodes || []).length || Object.keys(remote.projectSchedules || {}).length);
}
function setStateFromRemote(remote) {
  remoteApplying = true;
  state.records = (remote.records || []).map(normalizeRecord);
  state.masters = remote.masters || { customers: [], productSpecs: [], scheduleNodes: [] };
  state.projectSchedules = remote.projectSchedules || {};
  normalizeMasters();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.records));
  localStorage.setItem(MASTER_STORAGE_KEY, JSON.stringify(state.masters));
  localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(state.projectSchedules));
  remoteApplying = false;
}

function getSupabaseDebugText(err, label) {
  const service = supabaseService();
  const info = err?.debugInfo || service?.getLastDebug?.() || null;
  const lines = [];
  lines.push(`錯誤位置：${label || '未指定'}`);
  lines.push(`錯誤訊息：${err?.message || '未知錯誤'}`);
  if (err?.code) lines.push(`Supabase/PostgREST code：${err.code}`);
  if (err?.details) lines.push(`details：${err.details}`);
  if (err?.hint) lines.push(`hint：${err.hint}`);
  if (info) {
    lines.push('');
    lines.push('--- request / response debug ---');
    lines.push(JSON.stringify(info, null, 2));
    lines.push('');
    lines.push('--- SQL 檢查建議 ---');
    lines.push(`select policyname, cmd, qual, with_check\nfrom pg_policies\nwhere schemaname = 'public'\n  and tablename = '${info.table_hint || '請填表名'}'\norder by policyname;`);
  }
  return lines.join('\n');
}
function showSupabaseError(label, err) {
  const text = getSupabaseDebugText(err, label);
  renderSupabaseStatus(`${label}：${err?.message || '未知錯誤'}\n\n詳細錯誤已展開在下方 Debug 區。`, false);
  const box = $('supabaseDebugText');
  const wrap = $('supabaseDebugWrap');
  if (box) box.textContent = text;
  if (wrap) wrap.open = true;
  console.error('[Supabase Debug]', label, err, err?.debugInfo || supabaseService()?.getLastDebug?.());
}

function renderSupabaseStatus(message, ok = null) {
  const el = $('supabaseStatus');
  if (!el) return;
  const service = supabaseService();
  const cfg = service?.getConfig ? service.getConfig() : {};
  const ready = supabaseReady();
  const user = currentSupabaseUser();
  const authText = user?.email ? `已登入：${escapeHtml(user.email)}` : '尚未登入';
  const base = ready
    ? `v25 Debug 正式權限資料庫模式：已啟用｜${escapeHtml(cfg.url || '')}<br>${authText}`
    : '目前設定：尚未啟用。會繼續使用瀏覽器本機暫存。';
  const syncText = lastAutoSyncAt ? `<br>最近自動同步：${escapeHtml(lastAutoSyncAt)}` : '';
  const cls = ok === true ? '✅ ' : ok === false ? '⚠️ ' : '';
  el.innerHTML = `${cls}${base}${message ? `<br>${escapeHtml(message)}` : ''}${syncText}`;
  const authStatus = $('authStatus');
  if (authStatus) authStatus.textContent = ready ? authText : 'Supabase 尚未啟用';
}
function scheduleAutoSync() {
  if (!supabaseReady() || !supabaseAuthenticated()) return;
  clearTimeout(autoSyncTimer);
  renderSupabaseStatus('等待自動同步到 Supabase...', null);
  autoSyncTimer = setTimeout(syncNowToSupabase, 700);
}
async function syncNowToSupabase() {
  if (!supabaseReady() || !supabaseAuthenticated() || remoteApplying) return;
  if (autoSyncBusy) { scheduleAutoSync(); return; }
  autoSyncBusy = true;
  try {
    renderSupabaseStatus('自動同步到 Supabase 中...', null);
    await supabaseService().pushAll(state);
    lastAutoSyncAt = new Date().toLocaleString('zh-TW');
    renderSupabaseStatus('已自動同步到 Supabase。', true);
  } catch (err) {
    showSupabaseError('自動同步失敗', err);
  } finally {
    autoSyncBusy = false;
  }
}
async function loadFromSupabaseOnStart() {
  if (!supabaseReady()) { renderSupabaseStatus(); return; }
  if (!supabaseAuthenticated()) { renderSupabaseStatus('請先登入，登入後才會自動載入你的資料。'); return; }
  try {
    renderSupabaseStatus('正式資料庫模式啟用，正在從 Supabase 載入資料...');
    const localHasData = Boolean(state.records.length || state.masters.customers.length || state.masters.productSpecs.length || Object.keys(state.projectSchedules || {}).length);
    const remote = await supabaseService().pullAll();
    if (!hasRemoteData(remote) && localHasData) {
      renderSupabaseStatus('Supabase 目前沒有資料，先保留本機資料；你可以按「立即同步到 Supabase」。', true);
      return;
    }
    setStateFromRemote(remote);
    renderAll();
    fillForm(null);
    renderSupabaseStatus('已從 Supabase 載入資料，之後新增/修改/刪除會自動同步。', true);
  } catch (err) {
    showSupabaseError('啟動載入失敗，暫時保留本機資料', err);
  }
}
async function testSupabaseConnection() {
  try {
    renderSupabaseStatus('連線測試中...');
    await supabaseService().testConnection();
    renderSupabaseStatus('連線成功，且目前登入者可讀取自己的 customers 資料。', true);
    toast('Supabase 連線成功');
  } catch (err) {
    showSupabaseError('連線失敗', err);
    toast('Supabase 連線失敗，請看設定頁說明');
  }
}
async function pushLocalToSupabase() {
  if (!confirm('會將目前畫面資料立即同步到 Supabase。已刪除資料會用軟刪除方式保留在資料庫。確定繼續？')) return;
  try {
    renderSupabaseStatus('立即同步到 Supabase 中...');
    await supabaseService().pushAll(state);
    lastAutoSyncAt = new Date().toLocaleString('zh-TW');
    renderSupabaseStatus('已完成：目前資料已同步到 Supabase。', true);
    toast('已同步到 Supabase');
  } catch (err) {
    showSupabaseError('同步失敗', err);
    toast('同步失敗，請檢查 SQL / RLS / 設定');
  }
}
async function pullFromSupabase() {
  if (!confirm('會用 Supabase 資料覆蓋目前瀏覽器本機資料。確定繼續？')) return;
  try {
    renderSupabaseStatus('從 Supabase 載入中...');
    const remote = await supabaseService().pullAll();
    setStateFromRemote(remote);
    renderAll();
    fillForm(null);
    renderSupabaseStatus('已完成：已從 Supabase 載入並覆蓋本機暫存。', true);
    toast('已從 Supabase 載入資料');
  } catch (err) {
    showSupabaseError('載入失敗', err);
    toast('載入失敗，請檢查 SQL / RLS / 設定');
  }
}



async function loadAuditLogs() {
  if (!supabaseAuthenticated()) return toast('請先登入');
  try {
    const rows = await supabaseService().listAuditLogs(30);
    const box = $('auditLogList');
    if (box) box.innerHTML = (rows || []).map(r => `<div class="mini-line"><b>${escapeHtml(r.action)}</b> ${escapeHtml(r.table_name)}<span>${escapeHtml(new Date(r.created_at).toLocaleString('zh-TW'))}</span></div>`).join('') || '<p class="empty">尚無操作紀錄。</p>';
    toast('已載入操作紀錄');
  } catch (err) { showSupabaseError('操作紀錄載入失敗', err); }
}

async function signUpSupabaseUser() {
  const email = $('authEmail')?.value.trim();
  const password = $('authPassword')?.value;
  if (!email || !password) return toast('請輸入 Email 和密碼');
  try {
    renderSupabaseStatus('建立帳號中...');
    await supabaseService().signUp(email, password);
    renderSupabaseStatus('帳號已建立。若 Supabase 要求信箱確認，請先到信箱確認後再登入。', true);
    toast('已送出註冊');
  } catch (err) { showSupabaseError('註冊失敗', err); }
}
async function signInSupabaseUser() {
  const email = $('authEmail')?.value.trim();
  const password = $('authPassword')?.value;
  if (!email || !password) return toast('請輸入 Email 和密碼');
  try {
    renderSupabaseStatus('登入中...');
    await supabaseService().signIn(email, password);
    renderSupabaseStatus('已登入，正在載入你的資料...', true);
    await loadFromSupabaseOnStart();
    toast('已登入');
  } catch (err) { showSupabaseError('登入失敗', err); }
}
async function signOutSupabaseUser() {
  try { await supabaseService().signOut(); } catch (_) {}
  renderSupabaseStatus('已登出。畫面會保留目前本機暫存資料，但不會再自動同步。', true);
  toast('已登出');
}

async function requestSupabasePasswordReset() {
  const email = $('authEmail')?.value.trim();
  if (!email) return toast('請先輸入要找回密碼的 Email');
  try {
    renderSupabaseStatus('正在寄送密碼重設信...');
    await supabaseService().requestPasswordReset(email);
    renderSupabaseStatus('密碼重設信已寄出。請檢查收件匣與垃圾郵件，點開信中的連結後設定新密碼。', true);
    toast('密碼重設信已寄出');
  } catch (err) { showSupabaseError('密碼重設信寄送失敗', err); }
}

function showPasswordRecoveryBox(show) {
  const box = $('passwordRecoveryBox');
  if (box) box.hidden = !show;
  if (show) {
    switchView('settings');
    switchSettingsTab('supabase');
    setTimeout(() => $('newAuthPassword')?.focus(), 0);
  }
}

function clearPasswordRecoveryUrl() {
  if (!window.history?.replaceState) return;
  const cleanUrl = window.location.href.split('#')[0].split('?')[0];
  window.history.replaceState({}, document.title, cleanUrl);
}

async function updateSupabasePassword() {
  const password = $('newAuthPassword')?.value || '';
  const confirmPassword = $('confirmAuthPassword')?.value || '';
  if (password.length < 8) return toast('新密碼至少需要 8 碼');
  if (password !== confirmPassword) return toast('兩次輸入的新密碼不一致');
  try {
    renderSupabaseStatus('正在更新密碼...');
    await supabaseService().updatePassword(password);
    $('newAuthPassword').value = '';
    $('confirmAuthPassword').value = '';
    showPasswordRecoveryBox(false);
    clearPasswordRecoveryUrl();
    renderSupabaseStatus('密碼已更新完成。你目前已登入，可繼續使用系統。', true);
    toast('密碼已更新');
  } catch (err) { showSupabaseError('密碼更新失敗', err); }
}

function cancelPasswordRecovery() {
  showPasswordRecoveryBox(false);
  clearPasswordRecoveryUrl();
  toast('已取消設定新密碼');
}

function init() {
  readStore();
  const isPasswordRecovery = Boolean(supabaseService()?.consumePasswordRecoveryFromUrl?.());
  document.addEventListener('input', (event) => {
    if (event.target instanceof HTMLTextAreaElement) autoResizeTextarea(event.target);
  });
  const textareaObserver = new MutationObserver((mutations) => {
    mutations.forEach(mutation => mutation.addedNodes.forEach(node => {
      if (!(node instanceof Element)) return;
      if (node.matches('textarea')) autoResizeTextarea(node);
      resizeAllTextareas(node);
    }));
  });
  textareaObserver.observe(document.body, { childList: true, subtree: true });
  document.querySelectorAll('.nav-btn').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));
  document.querySelectorAll('.flow-step').forEach(b => b.addEventListener('click', () => switchView(b.dataset.go)));
  document.querySelectorAll('.settings-tab').forEach(b => b.addEventListener('click', () => switchSettingsTab(b.dataset.settingsTab)));
  $('recordForm').addEventListener('submit', saveForm);
  $('resetBtn').addEventListener('click', () => fillForm(null));
  $('newRecordBtn').addEventListener('click', () => fillForm(null));
  $('duplicateBtn').addEventListener('click', duplicateRecord);
  $('importExcelBtn')?.addEventListener('click', importExcel);
  $('seedDemoBtn')?.addEventListener('click', seedDemo);
  $('clearDataBtn')?.addEventListener('click', async () => {
    if(confirm('會清空目前畫面資料；若已登入 Supabase，只會把自己建立的遠端工作記錄標記為軟刪除；共用專案/客戶/時程設定不會一起清空。確定？')) {
      if (supabaseAuthenticated()) {
        try {
          await supabaseService().softDeleteAllOwned('work_records');
        } catch (err) { showSupabaseError('清空遠端工作記錄失敗', err); return; }
      }
      state.records=[]; state.masters={customers:[],productSpecs:[],scheduleNodes:[...(window.defaultScheduleNodes || [])]}; state.projectSchedules={}; normalizeMasters(); writeStore(); renderAll(); toast('已清空');
    }
  });
  $('addCustomerBtn').addEventListener('click', addCustomer);
  $('addProductSpecBtn').addEventListener('click', addProductSpec);
  $('addScheduleNodeBtn').addEventListener('click', addScheduleNode);
  $('resetScheduleNodesBtn').addEventListener('click', resetScheduleNodes);
  $('masterCustomerSelect').addEventListener('change', () => {
    state.scheduleEditorProject = '';
    renderSettings();
    bindDynamicActions();
  });
  $('customer').addEventListener('change', () => { $('productSpecCombo').value = ''; $('productName').value = ''; $('spec').value = ''; updateProductSpecOptions(); });
  $('productSpecCombo').addEventListener('input', applyComboToHiddenFields);
  // 查詢條件改變後，工作記事清單會重新產生；必須同步重綁新按鈕的事件。
  // 否則篩選後畫面上的「查／改／結案／刪除」按鈕會因 DOM 被替換而失效。
  ['keyword','customerFilter','statusFilter','typeFilter'].forEach(id => $(id).addEventListener('input', () => {
    renderRecords();
    bindDynamicActions();
  }));
  $('projectSearch')?.addEventListener('input', () => { renderProjects(); bindDynamicActions(); });
  $('timelineProjectSelect').addEventListener('change', () => renderTimeline());
  $('calendarMonth').addEventListener('change', () => { state.calendarStartOffset = 0; state.calendarEndOffset = 0; renderCalendar(); bindDynamicActions(); });
  $('recordModalClose').addEventListener('click', closeRecordModal);
  $('recordModal').addEventListener('click', (e) => { if (e.target.id === 'recordModal') closeRecordModal(); });
  $('authSignUpBtn')?.addEventListener('click', signUpSupabaseUser);
  $('authSignInBtn')?.addEventListener('click', signInSupabaseUser);
  $('authForgotPasswordBtn')?.addEventListener('click', requestSupabasePasswordReset);
  $('authUpdatePasswordBtn')?.addEventListener('click', updateSupabasePassword);
  $('authCancelRecoveryBtn')?.addEventListener('click', cancelPasswordRecovery);
  $('authSignOutBtn')?.addEventListener('click', signOutSupabaseUser);
  $('testSupabaseBtn')?.addEventListener('click', testSupabaseConnection);
  $('pushSupabaseBtn')?.addEventListener('click', pushLocalToSupabase);
  $('pullSupabaseBtn')?.addEventListener('click', pullFromSupabase);
  $('loadAuditBtn')?.addEventListener('click', loadAuditLogs);
  renderSupabaseStatus();
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => { document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active')); t.classList.add('active'); state.currentFollowMode = t.dataset.follow; renderFollowups(); bindDynamicActions(); }));
  renderAll(); fillForm(null); requestAnimationFrame(() => resizeAllTextareas());
  if (isPasswordRecovery) {
    showPasswordRecoveryBox(true);
    renderSupabaseStatus('密碼重設連結驗證成功，請設定新密碼。', true);
  } else {
    loadFromSupabaseOnStart();
  }
}
init();
