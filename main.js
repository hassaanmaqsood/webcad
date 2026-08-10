import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import GUI from 'lil-gui';
import { parseScadParams, setLineValue, paramToLiteral, formatNumber } from './params.js';
import * as storage from './storage.js';

// --------------------------------------------------------------------------
// Starter script — every Customizer construct the parser understands:
// groups, sliders (with/without step), a checkbox, and a dropdown.
// --------------------------------------------------------------------------
const STARTER_SCRIPT = `/* [Dimensions] */
width = 30;  // [10:60]
depth = 30;  // [10:60]
height = 10; // [5:40]

/* [Hole] */
has_hole = true;
hole_radius = 5; // [2:0.5:15]

/* [Quality] */
$fn = 32; // [12:100]

/* [Material] */
material = "PLA"; // [PLA, ABS, PETG, Wood Fill]

module main() {
    difference() {
        cube([width, depth, height], center = true);
        if (has_hole) {
            cylinder(h = height + 2, r = hole_radius, center = true);
        }
    }
}

main();
`;

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------
const state = {
  lines: STARTER_SCRIPT.split('\n'),
  paramsMeta: { params: [], groupOrder: [] },
  currentDesignId: null,
  lastSTLBuffer: null,
  dirty: false,
};

function currentScript() {
  return state.lines.join('\n');
}
function markDirty() { state.dirty = true; }
function markClean() { state.dirty = false; }
async function confirmDiscardIfDirty(message) {
  if (!state.dirty) return true;
  return window.confirm(message || 'You have unsaved changes. Continue and lose them?');
}

// --------------------------------------------------------------------------
// DOM refs
// --------------------------------------------------------------------------
const el = (id) => document.getElementById(id);
const codePanel = el('code-panel');
const guiPanel = el('gui-panel');
const guiContainer = el('gui-container');
const designTitleInput = el('design-title');
const loadingBadge = el('loading-badge');
const errorBanner = el('error-banner');
const compileStatus = el('compile-status');
const compileStatusText = el('compile-status-text');
const designsDropdown = el('designs-dropdown');
const shareDropdown = el('share-dropdown');
const userDropdown = el('user-dropdown');
const shareUrlInput = el('share-url');
const toast = el('toast');
const userAvatar = el('user-avatar');
const userNameLabel = el('user-name');
const modalRoot = el('modal-root');

// --------------------------------------------------------------------------
// Modal system (promise-based, used for onboarding + prompts)
// --------------------------------------------------------------------------
function showModal(innerHTML, { onMount } = {}) {
  modalRoot.innerHTML = `<div class="modal-backdrop"></div><div class="modal-box">${innerHTML}</div>`;
  modalRoot.classList.add('open');
  if (onMount) onMount(modalRoot);
}
function hideModal() {
  modalRoot.classList.remove('open');
  modalRoot.innerHTML = '';
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function promptUsername() {
  const recents = storage.recentUsernames();
  return new Promise((resolve) => {
    showModal(`
      <h2>Welcome to WebCAD</h2>
      <p>Enter a name to save and open your designs on this device. Your designs are encrypted locally with it.</p>
      <input id="modal-username" type="text" placeholder="e.g. ahmed" autocomplete="off" maxlength="24" />
      ${recents.length ? `<div class="modal-recents">${recents.map((n) => `<button type="button" class="chip-btn" data-name="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join('')}</div>` : ''}
      <button class="btn filled block" id="modal-continue">Continue</button>
    `, {
      onMount: (root) => {
        const input = root.querySelector('#modal-username');
        input.focus();
        root.querySelectorAll('.chip-btn').forEach((b) => b.addEventListener('click', () => { input.value = b.dataset.name; submit(); }));
        root.querySelector('#modal-continue').addEventListener('click', submit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
        function submit() {
          const val = input.value.trim();
          if (!val) { input.focus(); return; }
          hideModal();
          resolve(val);
        }
      },
    });
  });
}

async function promptDesignPicker() {
  const designs = await storage.listDesigns();
  return new Promise((resolve) => {
    showModal(`
      <h2>Your designs</h2>
      <p>Signed in as <strong>${escapeHtml(storage.currentUsername())}</strong></p>
      <div class="modal-design-list">
        <button type="button" class="design-tile new" id="tile-new"><span class="plus">+</span><span>New design</span></button>
        ${designs.map((d) => `
          <button type="button" class="design-tile" data-id="${d.id}">
            <span class="name">${escapeHtml(d.name)}</span>
            <span class="meta">${new Date(d.updatedAt).toLocaleDateString()}</span>
          </button>`).join('')}
      </div>
    `, {
      onMount: (root) => {
        root.querySelector('#tile-new').addEventListener('click', () => { hideModal(); resolve({ type: 'new' }); });
        root.querySelectorAll('.design-tile[data-id]').forEach((btn) => {
          btn.addEventListener('click', () => { hideModal(); resolve({ type: 'open', id: btn.dataset.id }); });
        });
      },
    });
  });
}

function promptDesignName(defaultName) {
  return new Promise((resolve) => {
    showModal(`
      <h2>Name your design</h2>
      <p>You can rename it any time from the title bar.</p>
      <input id="modal-design-name" type="text" placeholder="e.g. bracket mount" value="${escapeHtml(defaultName || '')}" maxlength="60" />
      <button class="btn filled block" id="modal-name-continue">Create</button>
    `, {
      onMount: (root) => {
        const input = root.querySelector('#modal-design-name');
        input.focus();
        input.select();
        function submit() {
          hideModal();
          resolve(input.value.trim() || 'Untitled design');
        }
        root.querySelector('#modal-name-continue').addEventListener('click', submit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      },
    });
  });
}

// --------------------------------------------------------------------------
// Three.js scene
// --------------------------------------------------------------------------
const container = el('canvas-container');
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 2000);
const DEFAULT_CAM_POS = new THREE.Vector3(60, 60, 60);
camera.position.copy(DEFAULT_CAM_POS);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(window.devicePixelRatio);
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const grid = new THREE.GridHelper(200, 20, 0x2b3242, 0x1c212b);
scene.add(grid);

// Normal material — color encodes surface direction, no lighting needed.
const material = new THREE.MeshNormalMaterial();

let currentMesh = null;

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

function resizeRenderer() {
  const w = container.clientWidth, h = container.clientHeight;
  if (w === 0 || h === 0) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', resizeRenderer);
new ResizeObserver(resizeRenderer).observe(container);

el('btn-reset-view').addEventListener('click', () => {
  camera.position.copy(DEFAULT_CAM_POS);
  controls.target.set(0, 0, 0);
  controls.update();
});

// --------------------------------------------------------------------------
// Worker + render queueing
// --------------------------------------------------------------------------
const worker = new Worker('worker.js', { type: 'module' });
const stlLoader = new STLLoader();

let isRendering = false;
let pendingScript = null;

function setCompileStatus(mode, text) {
  compileStatus.className = mode;
  compileStatusText.textContent = text;
}

worker.onmessage = (e) => {
  if (e.data.type === 'ready') {
    loadingBadge.classList.add('hidden');
    queueRender(currentScript());
  } else if (e.data.type === 'success') {
    errorBanner.classList.remove('visible');
    setCompileStatus('ok', 'Compiled');
    state.lastSTLBuffer = e.data.stl;

    const geometry = stlLoader.parse(e.data.stl);
    geometry.computeVertexNormals();
    geometry.center();

    if (currentMesh) {
      scene.remove(currentMesh);
      currentMesh.geometry.dispose();
    }
    currentMesh = new THREE.Mesh(geometry, material);
    currentMesh.rotation.x = -Math.PI / 2; // OpenSCAD Z-up -> Three.js Y-up
    scene.add(currentMesh);

    isRendering = false;
    if (pendingScript !== null) {
      const next = pendingScript;
      pendingScript = null;
      triggerRender(next);
    }
  } else if (e.data.type === 'error') {
    setCompileStatus('error', 'Compile error');
    errorBanner.textContent = e.data.error;
    errorBanner.classList.add('visible');
    isRendering = false;
    if (pendingScript !== null) {
      const next = pendingScript;
      pendingScript = null;
      triggerRender(next);
    }
  }
};

function queueRender(script) {
  setCompileStatus('busy', 'Compiling…');
  if (!isRendering) triggerRender(script);
  else pendingScript = script;
}
function triggerRender(script) {
  isRendering = true;
  worker.postMessage({ type: 'render', script });
}

// --------------------------------------------------------------------------
// CodeMirror editor — edits require an explicit Run (button or Ctrl/Cmd+Enter)
// --------------------------------------------------------------------------
const cm = CodeMirror.fromTextArea(el('code-editor'), {
  mode: 'text/x-csrc',
  lineNumbers: true,
  tabSize: 2,
  indentUnit: 2,
  viewportMargin: Infinity,
  matchBrackets: true,
  extraKeys: {
    'Ctrl-Enter': () => runCode(),
    'Cmd-Enter': () => runCode(),
  },
});

function syncEditorFromState() {
  const scrollInfo = cm.getScrollInfo();
  cm.setValue(currentScript());
  cm.scrollTo(scrollInfo.left, scrollInfo.top);
}

function runCode() {
  state.lines = cm.getValue().split('\n');
  markDirty();
  rebuildParamsFromScript();
  queueRender(currentScript());
  const btn = el('btn-run');
  btn.classList.remove('pulse');
  void btn.offsetWidth; // restart animation
  btn.classList.add('pulse');
}
el('btn-run').addEventListener('click', runCode);

// --------------------------------------------------------------------------
// Parameters -> lil-gui panel
// --------------------------------------------------------------------------
let gui = null;

function rebuildParamsFromScript() {
  state.paramsMeta = parseScadParams(currentScript());
  renderGui();
}

function humanize(name) {
  return name.replace(/^\$/, '').replace(/_/g, ' ');
}

function renderGui() {
  if (gui) { gui.destroy(); gui = null; }
  guiContainer.innerHTML = '';
  gui = new GUI({ container: guiContainer, title: 'Parameters', width: undefined });

  const { params, groupOrder } = state.paramsMeta;
  if (params.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'params-empty';
    empty.innerHTML = `No parameters detected yet. Add a comment constraint above a
      variable, e.g. <code>width = 30; // [10:60]</code>, and it becomes a control here.`;
    guiContainer.appendChild(empty);
    return;
  }

  const byGroup = {};
  params.forEach((p) => (byGroup[p.group] = byGroup[p.group] || []).push(p));

  groupOrder.forEach((groupName) => {
    const rows = byGroup[groupName];
    if (!rows || rows.length === 0) return;
    const folder = gui.addFolder(groupName);
    rows.forEach((param) => addControllerForParam(folder, param));
  });
}

function addControllerForParam(folder, param) {
  const proxy = { value: param.value };
  let controller;

  if (param.type === 'slider') {
    controller = folder.add(proxy, 'value', param.min, param.max, param.step).name(humanize(param.name));
  } else if (param.type === 'checkbox') {
    controller = folder.add(proxy, 'value').name(humanize(param.name));
  } else if (param.type === 'dropdown') {
    const optsMap = {};
    param.options.forEach((o) => { optsMap[o.label] = param.quote ? o.value : Number(o.value); });
    proxy.value = param.quote ? param.value : Number(param.value);
    controller = folder.add(proxy, 'value', optsMap).name(humanize(param.name));
  } else {
    // 'number' | 'text' | 'raw'
    controller = folder.add(proxy, 'value').name(humanize(param.name));
  }

  if (param.description && controller.$name) controller.$name.title = param.description;

  controller.onChange((v) => {
    param.value = v;
    commitParamChange(param, { immediate: param.type !== 'slider' });
  });
}

let sliderDebounce = null;
function commitParamChange(param, { immediate = true } = {}) {
  markDirty();
  const literal = paramToLiteral(param);
  state.lines = setLineValue(state.lines, param.lineIndex, literal);
  syncEditorFromState();

  if (immediate) {
    queueRender(currentScript());
  } else {
    clearTimeout(sliderDebounce);
    sliderDebounce = setTimeout(() => queueRender(currentScript()), 100);
  }
}

// --------------------------------------------------------------------------
// Panel toggles (desktop: docked collapse · mobile: slide-over)
// --------------------------------------------------------------------------
function togglePanel(panelEl, toggleBtn) {
  panelEl.classList.toggle('collapsed');
  toggleBtn.classList.toggle('active', !panelEl.classList.contains('collapsed'));
}
el('btn-toggle-code').addEventListener('click', () => togglePanel(codePanel, el('btn-toggle-code')));
el('btn-toggle-gui').addEventListener('click', () => togglePanel(guiPanel, el('btn-toggle-gui')));
el('close-code-panel').addEventListener('click', () => togglePanel(codePanel, el('btn-toggle-code')));
el('close-gui-panel').addEventListener('click', () => togglePanel(guiPanel, el('btn-toggle-gui')));

// --------------------------------------------------------------------------
// Export STL
// --------------------------------------------------------------------------
el('btn-export-stl').addEventListener('click', () => {
  if (!state.lastSTLBuffer) { showToast('Nothing to export yet — wait for the model to compile.'); return; }
  const blob = new Blob([state.lastSTLBuffer], { type: 'model/stl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slugify(designTitleInput.value || 'model')}.stl`;
  a.click();
  URL.revokeObjectURL(url);
});
function slugify(s) {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'model';
}

// --------------------------------------------------------------------------
// Loading a script into all UI surfaces (no Run needed — not user-typed)
// --------------------------------------------------------------------------
function loadScript(script, title) {
  state.lines = script.split('\n');
  designTitleInput.value = title || 'Untitled design';
  syncEditorFromState();
  rebuildParamsFromScript();
  queueRender(currentScript());
  markClean();
}

// --------------------------------------------------------------------------
// Save
// --------------------------------------------------------------------------
el('btn-save').addEventListener('click', async () => {
  const entry = await storage.saveDesign({
    id: state.currentDesignId,
    name: designTitleInput.value.trim() || 'Untitled design',
    script: currentScript(),
  });
  state.currentDesignId = entry.id;
  markClean();
  showToast('Saved to this device');
});

// --------------------------------------------------------------------------
// Design switching (My Designs button, New design, boot flow)
// --------------------------------------------------------------------------
async function createNewDesignFlow() {
  const name = await promptDesignName('Untitled design');
  loadScript(STARTER_SCRIPT, name);
  const entry = await storage.saveDesign({ id: null, name, script: STARTER_SCRIPT });
  state.currentDesignId = entry.id;
  markClean();
  storage.clearShareParams();
}

async function openDesignPicker() {
  const ok = await confirmDiscardIfDirty();
  if (!ok) return;
  const choice = await promptDesignPicker();
  if (choice.type === 'open') {
    const design = await storage.loadDesignById(choice.id);
    if (design) {
      loadScript(design.script, design.name);
      state.currentDesignId = design.id;
      storage.clearShareParams();
      showToast(`Opened "${design.name}"`);
    } else {
      await createNewDesignFlow();
    }
  } else {
    await createNewDesignFlow();
  }
}
el('btn-my-designs').addEventListener('click', (e) => { e.stopPropagation(); closeAllDropdowns(); openDesignPicker(); });
el('btn-new-design').addEventListener('click', async () => {
  userDropdown.classList.remove('open');
  const ok = await confirmDiscardIfDirty();
  if (!ok) return;
  await createNewDesignFlow();
});

// --------------------------------------------------------------------------
// User menu / switch user
// --------------------------------------------------------------------------
function updateUserBadge(username) {
  userNameLabel.textContent = username;
  userAvatar.textContent = username.slice(0, 1).toUpperCase();
}

el('btn-user-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  closeAllDropdowns();
  userDropdown.classList.toggle('open');
});

el('btn-switch-user').addEventListener('click', async () => {
  userDropdown.classList.remove('open');
  const ok = await confirmDiscardIfDirty('Switch user? Unsaved changes to this design will be lost.');
  if (!ok) return;
  const username = await promptUsername();
  await storage.login(username);
  updateUserBadge(username);
  await openDesignPicker();
});

// --------------------------------------------------------------------------
// Share
// --------------------------------------------------------------------------
el('btn-share').addEventListener('click', (e) => {
  e.stopPropagation();
  closeAllDropdowns();
  const url = storage.buildShareUrl(currentScript(), designTitleInput.value.trim(), storage.currentUsername());
  shareUrlInput.value = url;
  shareDropdown.classList.toggle('open');
});
el('btn-copy-link').addEventListener('click', async () => {
  shareUrlInput.select();
  try {
    await navigator.clipboard.writeText(shareUrlInput.value);
  } catch {
    document.execCommand('copy');
  }
  showToast('Link copied to clipboard');
});

function closeAllDropdowns() {
  designsDropdown.classList.remove('open');
  shareDropdown.classList.remove('open');
  userDropdown.classList.remove('open');
}
document.addEventListener('click', closeAllDropdowns);
[designsDropdown, shareDropdown, userDropdown].forEach((d) => d.addEventListener('click', (e) => e.stopPropagation()));

// --------------------------------------------------------------------------
// Toast
// --------------------------------------------------------------------------
let toastTimer = null;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2400);
}

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------
async function boot() {
  const username = await promptUsername();
  await storage.login(username);
  updateUserBadge(username);

  const shared = storage.parseShareUrl();
  if (shared) {
    loadScript(shared.script, shared.title);
    state.currentDesignId = null;
    showToast(`Loaded a design shared by ${shared.username}`);
  } else {
    const choice = await promptDesignPicker();
    if (choice.type === 'open') {
      const design = await storage.loadDesignById(choice.id);
      if (design) {
        loadScript(design.script, design.name);
        state.currentDesignId = design.id;
      } else {
        await createNewDesignFlow();
      }
    } else {
      await createNewDesignFlow();
    }
  }
}

boot();