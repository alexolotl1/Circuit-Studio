const paletteBlocks = document.querySelectorAll(".block.palette");
const workspace = document.getElementById("workspace");

let draggingBlock = null;
let selectedConnector = null;
let connections = []; // stores all wire connections
let contextMenu = null;
let _blockIdCounter = 1;
let selectedBlock = null;
let hoverTimer = null;
const undoStack = [];
let hoverBlurbHideTimer = null;
// opt-in debug flag; set to true in the browser console to enable detailed logs
let CT_DEBUG = false;
// system summary removed

/*
  Overview / flow (high-level):
  - UI creates draggable parts via `createBlockInstance()` and wires via `createWire()`.
  - `connections[]` stores wire endpoints (SVG line + two connector elements).
  - `evaluateCircuit()` is the central function: it builds electrical "nets" using a union-find
    over connector DOM nodes, translates components into solver inputs (resistors, voltage
    sources, diodes), then calls `CircuitSolver.solveMNA(...)` when available.
  - If the JS solver isn't available or fails, `fallbackSimplePowering()` and path-based
    heuristics attempt to mark LEDs as powered (and now also attach conservative current/voltage
    estimates so the tooltip can display values for debugging).

  Common failure points:
  - Nets: connectors that are isolated or not connected to any wire will have no net id.
  - Net mapping: if the union-find doesn't include a connector because of a bug, components
    can get `null` nets and be ignored by the solver.
  - Solver output mapping: the code relies on array ordering (resistors[], diodes[], vSources[])
    matching the solver's returned arrays. If ordering mismatches, annotations will attach to
    wrong blocks.
  - Fallback heuristics only detect connectivity (not voltages/currents) which can lead tooltips
    to show no numeric values; to make debugging easier we now estimate and attach conservative
    numbers when a component is heuristically considered powered.
*/

// Simulation run state
let isSimRunning = false;
let simInterval = null;
let simTickCount = 0;
let simNoProgressCount = 0;
let lastSimSummary = { ledCount: 0, totalCurrent: 0 };

function ensureTooltipElement(){
  if (!document.querySelector('.ct-tooltip')){
    const tt = document.createElement('div'); tt.className = 'ct-tooltip'; document.body.appendChild(tt);
  }
}

// Clear current workspace: remove all blocks and wires
function clearWorkspace(){
  // remove wire SVGs
  connections.forEach(c=>{ try{ if (c.line && c.line.parentNode) c.line.parentNode.removeChild(c.line); }catch(e){} });
  connections = [];
  // remove blocks
  const blocks = Array.from(workspace.querySelectorAll('.block'));
  blocks.forEach(b=>{ try{ b.remove(); }catch(e){} });
}

// The test-circuit loader was removed (did not behave reliably).
// If you want to re-add a canonical demo, implement a small initializer
// that uses createBlockInstance() and createWire() while respecting
// current simulation state (and call evaluateCircuit()).

function ensureSimBanner(){
  let el = document.getElementById('sim-banner');
  if (!el){ el = document.createElement('div'); el.id = 'sim-banner'; document.body.appendChild(el); }
  return el;
}

function updateSimBanner(msg, type='error', visible=true){
  const el = ensureSimBanner();
  el.textContent = msg || '';
  el.classList.remove('error','ok');
  if (type === 'ok') el.classList.add('ok'); else el.classList.add('error');
  if (visible) el.classList.add('visible'); else el.classList.remove('visible');
}

function clearSimBanner(){ const el = document.getElementById('sim-banner'); if (el) el.classList.remove('visible'); }

function disableEditingDuringSim(enable){
  isSimRunning = !!enable;
  if (isSimRunning) document.body.classList.add('sim-running'); else document.body.classList.remove('sim-running');
}

// Data-driven hover blurbs for parts; easy to extend when adding parts
const partBlurbs = {
  battery: {
    title: 'Battery',
    desc: 'Supplies a voltage difference to power circuits. Place positive (anode) and negative (cathode) connectors to complete a loop.'
  },
  resistor: {
    title: 'Resistor',
    desc: 'Limits current flow and divides voltage. Use resistors to protect LEDs or set sensor thresholds.'
  },
  led: {
    title: 'LED',
    desc: 'Light Emitting Diode: lights up when forward biased. Needs a resistor to limit current.'
  },
  switch: {
    title: 'Switch',
    desc: 'Controls current flow by making or breaking the circuit. Click to toggle on/off during or before simulation.'
  }
};

// SVG icons per part type
const svgMap = {
  battery: '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="6" width="16" height="12" rx="2" fill="#34d399" opacity="0.14"/><rect x="4" y="8" width="12" height="8" rx="1" fill="#34d399"/><rect x="18" y="10" width="2" height="4" rx="0.5" fill="#34d399"/></svg>',
  resistor: '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="6" width="20" height="12" rx="2" fill="#60a5fa" opacity="0.12"/><path d="M3 12h3l2-4 3 8 2-4h3" stroke="#2563eb" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  led: '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="9" r="3" fill="#f59e0b"/><path d="M12 12v6" stroke="#f59e0b" stroke-width="1.6" stroke-linecap="round"/><path d="M7 4l1.5 1.5M16.5 4L15 5.5" stroke="#f59e0b" stroke-width="1.2" stroke-linecap="round"/></svg>'
};

function updateHoverBlurb(type, event) {
  const hb = document.getElementById('hover-blurb');
  if (!hb) return;
  
  // clear any pending hide timer when showing a new blurb
  if (hoverBlurbHideTimer) { 
    clearTimeout(hoverBlurbHideTimer); 
    hoverBlurbHideTimer = null; 
  }
  
  if (!type) {
    // delay hiding to allow a short linger/animation (500ms)
    hoverBlurbHideTimer = setTimeout(() => {
      hb.classList.remove('visible');
      hb.classList.remove('battery', 'resistor', 'led');
    }, 500);
    return;
  }

  const info = partBlurbs[type] || { title: type || 'Part', desc: '' };
  const icon = hb.querySelector('.hb-icon');
  const title = hb.querySelector('.hb-title');
  const desc = hb.querySelector('.hb-desc');
  const extra = hb.querySelector('.hb-extra');

  // Keep the blurb statically inside the properties panel —
  // do not set `left`/`top` here. Positioning is handled by CSS.
  // (previously we positioned the blurb near hovered elements; reverted)

  if (icon) {
    if (svgMap[type]) icon.innerHTML = svgMap[type];
    else icon.textContent = (type && type[0]) ? type[0].toUpperCase() : '?';
  }
  if (title) title.textContent = info.title || '';
  if (desc) desc.textContent = info.desc || '';
  if (extra) extra.textContent = info.extra || '';

  hb.classList.add('visible');
  hb.classList.remove('battery', 'resistor', 'led');
  hb.classList.add(type);
}


// Create an SVG layer for wires
const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
svg.setAttribute("class", "wire-layer");
workspace.appendChild(svg);

// small counter for user-created wire nodes (bend points)
let _wireNodeCounter = 1;

// create a visual/interactive wire node (bend point) at workspace coords
function createWireNode(x, y){
  const n = document.createElement('div');
  n.className = 'wire-node input';
  n.dataset.blockId = `node${_wireNodeCounter++}`;
  n.dataset.terminal = 'node';
  n.style.position = 'absolute';
  // position: if x is a px string (import), use directly; otherwise treat as client coords
  if (typeof x === 'string' && x.indexOf('px')>=0){
    n.style.left = x; n.style.top = y || '0px';
  } else {
    const wsRect = workspace.getBoundingClientRect();
    n.style.left = (x - wsRect.left - 6) + 'px';
    n.style.top = (y - wsRect.top - 6) + 'px';
  }
  n.style.width = '12px'; n.style.height = '12px'; n.style.borderRadius = '6px'; n.style.background = '#444'; n.style.zIndex = 60; n.title = 'wire node';
  // make node clickable as a connector
  n.addEventListener('click', e => { e.stopPropagation(); handleConnectorClick(e, n); });
  // small drag support for repositioning nodes
  let moving=false, sx, sy, ox, oy;
  n.addEventListener('mousedown', e=>{ if (e.button!==0) return; moving=true; sx=e.clientX; sy=e.clientY; const rect=n.getBoundingClientRect(); ox=rect.left; oy=rect.top; document.body.classList.add('ct-moving'); e.stopPropagation(); });
  document.addEventListener('mousemove', e=>{ if (!moving) return; const wsRect = workspace.getBoundingClientRect(); const nx = ox + (e.clientX - sx); const ny = oy + (e.clientY - sy); n.style.left = (nx - wsRect.left) + 'px'; n.style.top = (ny - wsRect.top) + 'px'; updateAllWires(); });
  document.addEventListener('mouseup', e=>{ if (moving){ moving=false; document.body.classList.remove('ct-moving'); evaluateCircuit(); } });
  workspace.appendChild(n);
  return n;
}

// create a simple custom context menu (hidden by default)
function ensureContextMenu() {
  if (contextMenu) return;
  contextMenu = document.createElement('div');
  contextMenu.className = 'ct-context-menu';
  contextMenu.innerHTML = '<div id="ct-rotate">Rotate</div><div id="ct-delete">Click to delete</div>';
  document.body.appendChild(contextMenu);

  // create tooltip used for hover display
  if (!document.querySelector('.ct-tooltip')) {
    const tt = document.createElement('div');
    tt.className = 'ct-tooltip';
    document.body.appendChild(tt);
  }

  // Function to handle block rotation
  function rotateBlock(block) {
    if (!block) return;
    const currentRotation = block.style.transform || '';
    const currentDegrees = currentRotation.match(/rotate\((\d+)deg\)/) ? 
      parseInt(currentRotation.match(/rotate\((\d+)deg\)/)[1]) : 0;
    const newDegrees = (currentDegrees + 90) % 360;
    block.style.transform = `rotate(${newDegrees}deg)`;
    
    // Update connections if any
    if (connections.length > 0) {
      updateAllWires();
    }
  }

  // click handler for menu options
  contextMenu.addEventListener('click', e => {
    const targetBlock = contextMenu._targetBlock;
    if (!targetBlock) return hideContextMenu();
    if (e.target.id === 'ct-rotate') {
      rotateBlock(targetBlock);
      hideContextMenu();
      return;
    }
    if (e.target.id === 'ct-delete') {
      removeBlockAndConnections(targetBlock);
      hideContextMenu();
      return;
    }
  });

  // hide on any global click
  document.addEventListener('click', e => {
    if (!contextMenu) return;
    if (e.button === 2) return; // ignore right-clicks (they'll show it)
    if (!contextMenu.contains(e.target)) hideContextMenu();
  });
}


function showContextMenu(x, y, block) {
  ensureContextMenu();
  contextMenu.style.left = x + 'px';
  contextMenu.style.top = y + 'px';
  // populate menu with block-specific controls
  contextMenu._targetBlock = block;
  // include rotate control
  contextMenu.innerHTML = '<div id="ct-rotate">Rotate</div><div id="ct-delete">Click to delete</div>';
  if (block.dataset.type === 'battery') {
    const v = Number(block.dataset.voltage) || 10;
    const editor = document.createElement('div');
    editor.className = 'ct-edit';
    editor.innerHTML = `<label>V</label><input type="number" step="0.1" value="${v}" /><button id="ct-save">Save</button>`;
    contextMenu.appendChild(editor);
  } else if (block.dataset.type === 'resistor') {
    const r = Number(block.dataset.resistance) || 100;
    const editor = document.createElement('div');
    editor.className = 'ct-edit';
    editor.innerHTML = `<label>RΩ</label><input type="number" step="1" value="${r}" /><button id="ct-save">Save</button>`;
    contextMenu.appendChild(editor);
  }
  contextMenu.classList.add('visible');
}

function hideContextMenu() {
  if (!contextMenu) return;
  contextMenu.classList.remove('visible');
  contextMenu._targetBlock = null;
}

// Rotate (flip) a block's connectors and update logic/visuals
function rotateBlock(block) {
  if (!block) return;
  pushUndo();
  // find inputs (they may have class names left/right before swap)
  const inpLeft = block.querySelector('.input.left');
  const inpRight = block.querySelector('.input.right');
  if (!inpLeft || !inpRight) return;
  // swap class names left/right
  inpLeft.classList.remove('left'); inpLeft.classList.add('right');
  inpRight.classList.remove('right'); inpRight.classList.add('left');
  // swap terminal dataset
  inpLeft.dataset.terminal = 'right';
  inpRight.dataset.terminal = 'left';
  // swap polarity classes anode/cathode
  const leftWasAnode = inpLeft.classList.contains('anode');
  if (leftWasAnode) {
    inpLeft.classList.remove('anode'); inpLeft.classList.add('cathode');
    inpRight.classList.remove('cathode'); inpRight.classList.add('anode');
  } else {
    inpLeft.classList.remove('cathode'); inpLeft.classList.add('anode');
    inpRight.classList.remove('anode'); inpRight.classList.add('cathode');
  }
  // toggle flipped flag on dataset
  block.dataset.flipped = block.dataset.flipped === 'true' ? 'false' : 'true';
  // update wires and solver
  updateAllWires();
  evaluateCircuit();
}

// --- Handle drag start from palette ---
paletteBlocks.forEach(block => {
  block.addEventListener("mousedown", e => {
    // prevent creating new blocks while simulation is running
    if (isSimRunning) { updateSimBanner('Stop simulation before editing the workspace.', 'error', true); return; }
    const type = block.dataset.type;
    const newBlock = createBlockInstance(type);

    newBlock.classList.add("dragging");
    document.body.appendChild(newBlock);
    moveBlockTo(newBlock, e.pageX, e.pageY);

    draggingBlock = newBlock;
  });

  // show the hover blurb when user hovers palette items
  block.addEventListener('mouseenter', e => {
    const type = block.dataset.type;
    if (type) updateHoverBlurb(type, e);
  });
  
  block.addEventListener('mouseleave', e => {
    updateHoverBlurb(null, e);
  });
});

// --- While dragging block from palette ---
document.addEventListener("mousemove", e => {
  if (!draggingBlock) return;
  moveBlockTo(draggingBlock, e.pageX, e.pageY);
});

// --- Drop block into workspace ---
document.addEventListener("mouseup", e => {
  if (!draggingBlock) return;

  const wsRect = workspace.getBoundingClientRect();
  const blockRect = draggingBlock.getBoundingClientRect();

  // check if dropped inside workspace
  if (
    blockRect.right > wsRect.left &&
    blockRect.left < wsRect.right &&
    blockRect.bottom > wsRect.top &&
    blockRect.top < wsRect.bottom
  ) {
    // position relative to workspace
    const x = e.pageX - wsRect.left - draggingBlock.offsetWidth / 2;
    const y = e.pageY - wsRect.top - draggingBlock.offsetHeight / 2;

  draggingBlock.style.position = "absolute";
  draggingBlock.style.left = `${x}px`;
  draggingBlock.style.top = `${y}px`;

  // mark instance for workspace-specific styling
  draggingBlock.classList.add('instance');
  workspace.appendChild(draggingBlock);
  makeMovable(draggingBlock);
  // evaluate circuit when a new block is placed
  evaluateCircuit();
  } else {
    // dropped outside workspace — discard
    draggingBlock.remove();
  }

  draggingBlock.classList.remove("dragging");
  draggingBlock = null;
});

// --- Helper to move blocks ---
function moveBlockTo(block, x, y) {
  block.style.position = "absolute";
  block.style.left = `${x - block.offsetWidth / 2}px`;
  block.style.top = `${y - block.offsetHeight / 2}px`;
}

// --- Create block with connectors ---
function createBlockInstance(type) {
  const block = document.createElement("div");
  block.className = "block";
  // assign stable id for future reference
  block.dataset.id = `b${_blockIdCounter++}`;
  block.dataset.type = type;

  // Create component label
  const label = document.createElement("div");
  label.className = "component-label";
  label.textContent = type.toUpperCase();
  block.appendChild(label);

  // Create component image/indicator container
  const imageContainer = document.createElement("div");
  imageContainer.className = "component-image";
  
  // For switch, we use a simple line indicator
  if (type === 'switch') {
    block.dataset.state = 'off';
  }
  
  block.appendChild(imageContainer);

  // style based on palette version
  // visual styling is handled by CSS classes (palette and instance rules)

  const leftInput = document.createElement("div");
  leftInput.className = "input left";
  const rightInput = document.createElement("div");
  rightInput.className = "input right";
  // mark visual polarity: right = anode (red), left = cathode (blue)
  leftInput.classList.add('cathode');
  rightInput.classList.add('anode');

  block.appendChild(leftInput);
  block.appendChild(rightInput);

  // tag connectors so we can reference them in graph algorithms
  leftInput.dataset.blockId = block.dataset.id;
  leftInput.dataset.terminal = 'left';
  rightInput.dataset.blockId = block.dataset.id;
  rightInput.dataset.terminal = 'right';

  leftInput.addEventListener("click", e => handleConnectorClick(e, leftInput));
  rightInput.addEventListener("click", e => handleConnectorClick(e, rightInput));

  // component default properties for simulation
  if (type === 'battery') {
    block.dataset.voltage = 5; // volts
  } else if (type === 'resistor') {
    block.dataset.resistance = 100; // ohms
  } else if (type === 'led') {
    block.dataset.resistance = 100; // treat LED like a resistor that lights up
    block.dataset.powered = 'false';
    block.dataset.current = '';
    block.dataset.voltageDrop = '';
  } else if (type === 'switch') {
    block.dataset.state = 'on';
    // Add click handler for switch toggling
    block.addEventListener('click', e => {
      if (e.target === block) {  // Only toggle if clicking the block itself, not connectors
        block.dataset.state = block.dataset.state === 'on' ? 'off' : 'on';
        if (isBasicSimRunning || isSimRunning) {
          evaluateCircuit();  // Re-run simulation when switch changes
        }
      }
    });
  }

  // tooltip handlers (show measurements)
  block.addEventListener('mouseenter', e => {
    // populate the right-side hover blurb immediately for workspace instances
    const type = block.dataset.type;
    if (type) {
      try { updateHoverBlurb(type, e); } catch (err) { }
    }
    
    // delay tooltip by 500ms
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
        // Re-evaluate circuit on hover to force-show current computed values for debugging
        try { evaluateCircuit(); } catch (err) { /* non-fatal */ }

        const tt = document.querySelector('.ct-tooltip');
        if (!tt) return;
        updateTooltipForBlock(block, tt);
        const rect = block.getBoundingClientRect();
        tt.style.left = (rect.right + 8) + 'px';
        tt.style.top = (rect.top) + 'px';
        tt.classList.add('visible');

        // Add a temporary debug visual while hovering so it's obvious which part we're inspecting
        try { block.classList.add('hovered-debug'); } catch(e) {}
    }, 500);
  });
  
  block.addEventListener('mousemove', e => {
    const type = block.dataset.type;
    if (type && !selectedConnector) {
      try { updateHoverBlurb(type, e); } catch (err) { }
    }
    
    const tt = document.querySelector('.ct-tooltip');
    if (!tt) return;
    tt.style.left = (e.pageX + 10) + 'px';
    tt.style.top = (e.pageY + 10) + 'px';
    updateTooltipForBlock(block, tt);
  });
  
  block.addEventListener('mouseleave', e => {
    clearTimeout(hoverTimer);
    const tt = document.querySelector('.ct-tooltip');
    if (tt) tt.classList.remove('visible');
    // hide right-side blurb
    try { updateHoverBlurb(null, e); } catch (err) { }
    try { block.classList.remove('hovered-debug'); } catch(e) {}
  });

  // selection on click
  block.addEventListener('click', e => {
    e.stopPropagation();
    selectBlock(block);
  });

  return block;
}

// --- Make block movable inside workspace ---
function makeMovable(block) {
  let moving = false;
  let startX, startY, origX, origY;

  block.addEventListener("mousedown", e => {
    if (isSimRunning) { updateSimBanner('Stop simulation before moving parts.', 'error', true); return; }
    if (e.target.classList.contains("input")) return; // don't move if clicking connector
    e.stopPropagation();
    // prevent text selection while moving
    document.body.classList.add('ct-moving');
    moving = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = block.getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    origX = rect.left - workspaceRect.left;
    origY = rect.top - workspaceRect.top;
    block.style.cursor = "grabbing";
  });

  document.addEventListener("mousemove", e => {
    if (!moving) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    block.style.left = `${origX + dx}px`;
    block.style.top = `${origY + dy}px`;
    updateAllWires();
  });

  document.addEventListener("mouseup", e => {
    if (!moving) return;
    moving = false;
    block.style.cursor = "grab";
    document.body.classList.remove('ct-moving');

    // if released outside workspace, delete block and its connections
    const blockRect = block.getBoundingClientRect();
    const wsRect = workspace.getBoundingClientRect();
    const intersects = (
      blockRect.right > wsRect.left &&
      blockRect.left < wsRect.right &&
      blockRect.bottom > wsRect.top &&
      blockRect.top < wsRect.bottom
    );

    if (!intersects) {
      removeBlockAndConnections(block);
      hideContextMenu();
    } else {
      // ensure the block's position is relative to workspace (clamp within)
      const newLeft = Math.max(0, Math.min(block.offsetLeft, workspace.clientWidth - block.offsetWidth));
      const newTop = Math.max(0, Math.min(block.offsetTop, workspace.clientHeight - block.offsetHeight));
      block.style.left = `${newLeft}px`;
      block.style.top = `${newTop}px`;
    }
    // evaluate after any move ends
    evaluateCircuit();
  });

  // custom context menu for blocks inside workspace
  block.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.pageX, e.pageY, block);
  });
}

function selectBlock(block) {
  if (selectedBlock === block) return;
  selectedBlock = block;
  updatePropertiesPanel(block);
}

function updatePropertiesPanel(block) {
  const panel = document.getElementById('prop-content');
  if (!panel) return;
  if (!block) { panel.innerHTML = 'Select a block to edit properties'; return; }
  const type = block.dataset.type;
  let html = `<div><strong>${type.toUpperCase()}</strong></div>`;
  if (type === 'battery') {
    const v = Number(block.dataset.voltage) || 10;
    html += `<div>Voltage: <input id="prop-voltage" type="number" step="0.1" value="${v}" /></div>`;
  }
  if (type === 'resistor') {
    const r = Number(block.dataset.resistance) || 100;
    html += `<div>Resistance: <input id="prop-resistance" type="number" step="1" value="${r}" /></div>`;
  }
  // show computed values
  if (block.dataset.current) html += `<div>Current: ${Number(block.dataset.current).toFixed(6)} A</div>`;
  if (block.dataset.voltageDrop) html += `<div>ΔV: ${Number(block.dataset.voltageDrop).toFixed(4)} V</div>`;
  html += `<div style="margin-top:8px"><button id="prop-save">Save</button></div>`;
  panel.innerHTML = html;

  const saveBtn = document.getElementById('prop-save');
  if (saveBtn) saveBtn.onclick = () => {
    pushUndo();
    if (type === 'battery') {
      const v = Number(document.getElementById('prop-voltage').value);
      block.dataset.voltage = String(v);
    }
    if (type === 'resistor') {
      const r = Number(document.getElementById('prop-resistance').value);
      block.dataset.resistance = String(r);
    }
    evaluateCircuit();
    updatePropertiesPanel(block);
  };
}

function pushUndo() {
  // snapshot minimal state: blocks (type, id, dataset, position) and connections (indexes by connector)
  const blocks = Array.from(workspace.querySelectorAll('.block')).map(b=>({ id: b.dataset.id, type: b.dataset.type, dataset: {...b.dataset}, left: b.style.left, top: b.style.top }));
  // include wire nodes in snapshot
  const nodes = Array.from(workspace.querySelectorAll('.wire-node')).map(n=>({ id: n.dataset.blockId, type: 'node', dataset:{...n.dataset}, left: n.style.left, top: n.style.top }));
  const conns = connections.map(c=>({ conn1BlockId: c.conn1.dataset.blockId, conn1Terminal: c.conn1.dataset.terminal, conn2BlockId: c.conn2.dataset.blockId, conn2Terminal: c.conn2.dataset.terminal }));
  undoStack.push({ blocks: blocks.concat(nodes), conns });
  if (undoStack.length > 50) undoStack.shift();
}

function undo() {
  const snap = undoStack.pop();
  if (!snap) return;
  // Clear workspace
  // remove current blocks and wires
  connections.forEach(c=>{ if (c.line && c.line.parentNode) c.line.parentNode.removeChild(c.line); });
  connections = [];
  workspace.querySelectorAll('.block').forEach(b=>b.remove());
  // recreate blocks
  snap.blocks.forEach(bdata=>{
    if (bdata.type === 'node'){
      const node = createWireNode(bdata.left || '0px', bdata.top || '0px');
      node.dataset.blockId = bdata.id;
    } else {
      const b = createBlockInstance(bdata.type);
      b.dataset.id = bdata.id;
      Object.keys(bdata.dataset||{}).forEach(k=>b.dataset[k]=bdata.dataset[k]);
      b.style.position='absolute'; b.style.left = bdata.left; b.style.top = bdata.top; b.classList.add('instance');
      workspace.appendChild(b);
      makeMovable(b);
    }
  });
  // recreate connections
  snap.conns.forEach(c=>{
    const b1 = Array.from(workspace.querySelectorAll('.block')).find(x=>x.dataset.id===c.conn1BlockId);
    const b2 = Array.from(workspace.querySelectorAll('.block')).find(x=>x.dataset.id===c.conn2BlockId);
    if (!b1 || !b2) return;
    const conn1 = b1.querySelector(`.input.${c.conn1Terminal}`);
    const conn2 = b2.querySelector(`.input.${c.conn2Terminal}`);
    if (conn1 && conn2) createWire(conn1, conn2);
  });
  evaluateCircuit();
}

// Wire up UI buttons
document.addEventListener('DOMContentLoaded', ()=>{
  const undoBtn = document.getElementById('undo-btn');
  const saveBtn = document.getElementById('save-btn');
  const loadBtn = document.getElementById('load-btn');
  const loadFile = document.getElementById('load-file');
  if (undoBtn) undoBtn.onclick = () => undo();
  if (saveBtn) saveBtn.onclick = () => {
    const data = exportCircuit();
    const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'circuit.json'; a.click(); URL.revokeObjectURL(url);
  };
  if (loadBtn && loadFile) loadBtn.onclick = () => loadFile.click();
  if (loadFile) loadFile.onchange = e=>{
    const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = ev=>{ try{ importCircuit(JSON.parse(ev.target.result)); }catch(err){ console.error(err); } }; r.readAsText(f);
  };
  // clear connector selection when clicking elsewhere
  document.addEventListener('click', (ev) => {
    if (selectedConnector && !ev.target.classList.contains('input')) {
      try { selectedConnector.classList.remove('selected'); } catch(e) {}
      selectedConnector = null;
    }
    // hide hover blurb when clicking away
    updateHoverBlurb(null);
  });

// Allow right-click in workspace to create a wire node when a connector is selected
workspace.addEventListener('contextmenu', e => {
  if (!selectedConnector) return; // only used when we're mid-connection
  e.preventDefault();
  const node = createWireNode(e.clientX, e.clientY);
  // connect selectedConnector -> node and set node as new selectedConnector so user can continue
  createWire(selectedConnector, node);
  try { if (selectedConnector && selectedConnector.classList) selectedConnector.classList.remove('selected'); } catch(e){}
  selectedConnector = node; node.classList.add('selected');
});

  // Theme toggle initialization (light/dark)
  const themeBtn = document.getElementById('theme-btn');
  function applyTheme(t) {
    if (t === 'dark') { document.body.classList.add('dark'); if (themeBtn) themeBtn.textContent = '🌙'; }
    else { document.body.classList.remove('dark'); if (themeBtn) themeBtn.textContent = '🌞'; }
    try { localStorage.setItem('ct-theme', t); } catch(e){}
  }
  // load saved or use system preference
  try {
    const saved = localStorage.getItem('ct-theme');
    if (saved) applyTheme(saved);
    else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) applyTheme('dark');
    else applyTheme('light');
  } catch(e) { if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) applyTheme('dark'); }
  if (themeBtn) themeBtn.addEventListener('click', ()=>{ applyTheme(document.body.classList.contains('dark') ? 'light' : 'dark'); });
  // system summary persistence removed
});

function exportCircuit(){
  const blocks = Array.from(workspace.querySelectorAll('.block')).map(b=>({ id:b.dataset.id, type:b.dataset.type, dataset:{...b.dataset}, left:b.style.left, top:b.style.top }));
  // include wire nodes so they can be persisted
  const nodes = Array.from(workspace.querySelectorAll('.wire-node')).map(n=>({ id: n.dataset.blockId, type: 'node', dataset: {...n.dataset}, left: n.style.left || '0px', top: n.style.top || '0px' }));
  const allBlocks = blocks.concat(nodes);
  const conns = connections.map(c=>({ conn1BlockId:c.conn1.dataset.blockId, conn1Terminal:c.conn1.dataset.terminal, conn2BlockId:c.conn2.dataset.blockId, conn2Terminal:c.conn2.dataset.terminal }));
  return { blocks: allBlocks, conns };
}

function importCircuit(data){
  if (!data) return;
  // clear current
  connections.forEach(c=>{ if (c.line && c.line.parentNode) c.line.parentNode.removeChild(c.line); }); connections=[];
  workspace.querySelectorAll('.block').forEach(b=>b.remove());
  data.blocks.forEach(bdata=>{
    if (bdata.type === 'node'){
      // create a wire-node at the stored position
      const node = createWireNode(bdata.left || '0px', bdata.top || '0px');
      node.dataset.blockId = bdata.id || `node${_wireNodeCounter++}`;
      // make node draggable already handled in createWireNode
    } else {
      const b = createBlockInstance(bdata.type);
      b.dataset.id = bdata.id || `b${_blockIdCounter++}`;
      Object.keys(bdata.dataset||{}).forEach(k=>b.dataset[k]=bdata.dataset[k]);
      b.style.position='absolute'; b.style.left=bdata.left; b.style.top=bdata.top; b.classList.add('instance');
      workspace.appendChild(b); makeMovable(b);
    }
  });
  data.conns.forEach(c=>{
    // Try to resolve both connection endpoints: can be blocks or wire-nodes
    const allConnectors = Array.from(workspace.querySelectorAll('.block, .wire-node'));
    // primary match by dataset.id, fallback to element id if present
    const b1 = allConnectors.find(x => x.dataset.id === c.conn1BlockId || x.dataset.blockId === c.conn1BlockId || x.id === c.conn1BlockId);
    const b2 = allConnectors.find(x => x.dataset.id === c.conn2BlockId || x.dataset.blockId === c.conn2BlockId || x.id === c.conn2BlockId);
    if (!b1 || !b2) {
      // record missing connection entries for later reporting (do not throw)
      if (!importCircuit._missingConns) importCircuit._missingConns = [];
      importCircuit._missingConns.push({ requested: c, found1: !!b1, found2: !!b2 });
      return;
    }
    // connectors may be .input children (blocks) or the node element itself
    const conn1 = b1.classList && b1.classList.contains('wire-node') ? b1 : b1.querySelector(`.input.${c.conn1Terminal}`);
    const conn2 = b2.classList && b2.classList.contains('wire-node') ? b2 : b2.querySelector(`.input.${c.conn2Terminal}`);
    if (conn1 && conn2) createWire(conn1, conn2);
  });
  // Report any connection entries that referenced non-existent blocks so users can fix JSON
  if (importCircuit._missingConns && importCircuit._missingConns.length) {
    try {
      console.warn('CT: importCircuit - some connections referenced missing blocks:', importCircuit._missingConns);
      updateSimBanner(`Import: ${importCircuit._missingConns.length} connection(s) referenced missing block IDs. Check the JSON and console for details.`, 'error', true);
      // keep the missingConns visible briefly
      setTimeout(()=>{ updateSimBanner('', 'ok', false); }, 4000);
    } catch(e) { console.warn('CT: failed to report missing conns', e); }
    // clear for next import
    importCircuit._missingConns = [];
  }
  // system summary import removed
  evaluateCircuit();
}

// --- Handle connecting two inputs ---
function handleConnectorClick(e, connector) {
  e.stopPropagation();
  if (isSimRunning) { updateSimBanner('Stop simulation before editing connections.', 'error', true); return; }
  if (!selectedConnector) {
    // select the first connector
    selectedConnector = connector;
    connector.classList.add("selected");
    return;
  }
  // clicking same one cancels selection
  if (selectedConnector === connector) {
    connector.classList.remove("selected");
    selectedConnector = null;
    return;
  }
  // don't allow connecting two connectors on the same block
  const aBlock = selectedConnector.closest('.block');
  const bBlock = connector.closest('.block');
  if (aBlock && bBlock && aBlock === bBlock) {
    // same block — just deselect
    selectedConnector.classList.remove('selected');
    selectedConnector = null;
    return;
  }
  // connect the two
  createWire(selectedConnector, connector);
  selectedConnector.classList.remove("selected");
  selectedConnector = null;
}

// --- Draw a wire between two connectors ---
function createWire(conn1, conn2) {
  if (isSimRunning) { updateSimBanner('Stop simulation before creating wires.', 'error', true); return; }
  // Validate connectors: must be elements inside the workspace and be input elements
  if (!conn1 || !conn2) return;
  if (!(conn1 instanceof Element) || !(conn2 instanceof Element)) return;
  // prevent connecting a connector to itself or to a connector on the same block
  if (conn1 === conn2) return;
  const b1 = conn1.closest('.block');
  const b2 = conn2.closest('.block');
  // allow wiring to "wire-node" connectors which are not inside .block elements
  // if both connectors are inside the same block, avoid wiring intra-block
  if (b1 && b2 && b1 === b2) return;

  // Prevent duplicates: check existing connections
  for (const c of connections) {
    if (!c.conn1 || !c.conn2) continue;
    if ((c.conn1 === conn1 && c.conn2 === conn2) || (c.conn1 === conn2 && c.conn2 === conn1)) return;
  }

  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("stroke", "#222");
  line.setAttribute("stroke-width", "2");
  line.setAttribute('stroke-linecap', 'round');
  // store lightweight metadata for inspection/debugging
  line.dataset.from = `${conn1.dataset.blockId || '?'}/${conn1.dataset.terminal || '?'}`;
  line.dataset.to = `${conn2.dataset.blockId || '?'}/${conn2.dataset.terminal || '?'}`;

  svg.appendChild(line);

  connections.push({ line, conn1, conn2 });
  updateWirePosition({ line, conn1, conn2 });
  // evaluate circuit whenever a wire is created
  evaluateCircuit();
}

// --- Update wire position ---
function updateWirePosition(conn) {
  const { conn1, conn2, line } = conn;
  if (!line) return;
  if (!conn1 || !conn2) {
    // remove any orphaned line
    if (line.parentNode) line.parentNode.removeChild(line);
    return;
  }
  // sometimes connectors are removed; guard against that
  try {
    const rect1 = conn1.getBoundingClientRect();
    const rect2 = conn2.getBoundingClientRect();
    const wsRect = workspace.getBoundingClientRect();

    const x1 = rect1.left + rect1.width / 2 - wsRect.left;
    const y1 = rect1.top + rect1.height / 2 - wsRect.top;
    const x2 = rect2.left + rect2.width / 2 - wsRect.left;
    const y2 = rect2.top + rect2.height / 2 - wsRect.top;

    line.setAttribute("x1", x1);
    line.setAttribute("y1", y1);
    line.setAttribute("x2", x2);
    line.setAttribute("y2", y2);
  } catch (e) {
    // if anything goes wrong, safely remove line and its connection entry
    try { if (line.parentNode) line.parentNode.removeChild(line); } catch (er) {}
    const idx = connections.findIndex(c => c.line === line);
    if (idx >= 0) connections.splice(idx, 1);
  }
}

// --- Update all wires when blocks move ---
function updateAllWires() {
  connections.forEach(updateWirePosition);
}

// Remove all connections for a given block and remove the block from DOM
function removeBlockAndConnections(block) {
  if (!block || !block.parentElement) return;
  if (isSimRunning) { updateSimBanner('Stop simulation before deleting parts.', 'error', true); return; }

  // If a connector is currently selected on this block, clear selection
  if (selectedConnector && (selectedConnector.closest('.block') === block)) {
    selectedConnector.classList.remove('selected');
    selectedConnector = null;
  }

  // remove connections entries and svg lines
  const toRemove = [];
  connections.forEach((c, idx) => {
    const b1 = c.conn1.closest('.block');
    const b2 = c.conn2.closest('.block');
    if (b1 === block || b2 === block) {
      // remove line
      if (c.line && c.line.parentNode) c.line.parentNode.removeChild(c.line);
      toRemove.push(idx);
    }
  });

  // remove from connections array (reverse indices)
  for (let i = toRemove.length - 1; i >= 0; i--) {
    connections.splice(toRemove[i], 1);
  }

  // finally remove the block element
  block.parentElement.removeChild(block);

  // update wires just in case
  updateAllWires();
  evaluateCircuit();
}

// Return the other connector (left/right) element for the same block
function getOtherConnector(conn) {
  const block = conn.closest('.block');
  if (!block) return null;
  return block.querySelector(`.input.${conn.classList.contains('left') ? 'right' : 'left'}`) || null;
}

// Evaluate circuits in the workspace and update component states (e.g., LEDs)
function evaluateCircuit() {
  // Build blocks and reset metadata
  const blocks = Array.from(workspace.querySelectorAll('.block'));
  blocks.forEach(b => { delete b.dataset.current; delete b.dataset.voltageDrop; if (b.dataset.type === 'battery' && !b.dataset.voltage) b.dataset.voltage = 5; if (b.dataset.type === 'resistor' && !b.dataset.resistance) b.dataset.resistance = 100; if (b.dataset.type === 'led' && !b.dataset.forwardVoltage) b.dataset.forwardVoltage = 2; if (b.dataset.type === 'led') { b.dataset.powered = 'false'; b.classList.remove('powered'); } });

  // Build connector list & nets using union-find of wires
  const connectorList = Array.from(workspace.querySelectorAll('.input'));
  const cIndex = new Map(connectorList.map((c,i) => [c,i]));
  const parent = connectorList.map((_,i) => i);
  function find(i){ return parent[i]===i?i:(parent[i]=find(parent[i])); }
  function union(i,j){ const ri=find(i), rj=find(j); if(ri!==rj) parent[rj]=ri; }
  connections.forEach(c => { if (!c.conn1 || !c.conn2) return; const i=cIndex.get(c.conn1), j=cIndex.get(c.conn2); if (i!=null && j!=null) union(i,j); });
  const netId = connectorList.map((_,i) => find(i));
  const netMap = new Map(); let netCounter = 0;
  function netFor(conn){ const idx = cIndex.get(conn); if (idx==null) return null; const r = netId[idx]; if (!netMap.has(r)) netMap.set(r, netCounter++); return netMap.get(r); }

  // Debug: print mapping of connectors -> net ids
  if (CT_DEBUG) {
    try {
      console.debug('CT: connectorList count', connectorList.length);
      connectorList.forEach((c,i)=>{
        const nid = netFor(c);
        const bid = c.dataset.blockId || '(no-block)';
        const term = c.dataset.terminal || '(no-term)';
        console.debug(`CT: connector[${i}] block=${bid} term=${term} net=${nid}`);
      });
    } catch (e) { console.debug('CT: debug mapping failed', e); }
  }

  // Collect elements for solver
  const resistors = []; const vSources = []; const diodes = [];
  blocks.forEach(b => {
    const left = b.querySelector('.input.left');
    const right = b.querySelector('.input.right');
    if (!left || !right) return;
    const na = netFor(left); const nb = netFor(right);
    if (b.dataset.type === 'resistor') resistors.push({ n1: na, n2: nb, R: Number(b.dataset.resistance)||1e-12, block: b });
    else if (b.dataset.type === 'battery') vSources.push({ nPlus: nb, nMinus: na, V: Number(b.dataset.voltage)||5, block: b });
    else if (b.dataset.type === 'led') {
      // LEDs are now handled as resistors with meta.type='led' to simplify the circuit model
      resistors.push({ n1: na, n2: nb, R: Number(b.dataset.resistance)||100, block: b, meta: {type:'led'} });
    }
  });

  if (CT_DEBUG) {
    try {
      console.debug('CT: solver inputs', { connectorCount: connectorList.length, resistors: resistors.length, vSources: vSources.length, diodes: diodes.length });
    } catch (e) { console.debug('CT: debug inputs failed', e); }
  }

  if (netMap.size === 0) {
    // no nets detected: collect helpful debug info and show banner so user can inspect
    try {
      console.warn('CT: evaluateCircuit - no nets detected. connectorCount=', connectorList.length, 'connections=', connections.length);
      if (!CT_DEBUG) {
        // provide a friendly banner message when not in CT_DEBUG mode
        updateSimBanner('No nets detected: components may not be connected (or connection IDs mismatch). Check wiring or imported JSON. See console for details.', 'error', true);
        setTimeout(()=>{ clearSimBanner(); }, 4000);
      } else {
        // print verbose mapping when CT_DEBUG
        connectorList.forEach((c,i)=>{
          const nid = netFor(c);
          const bid = c.dataset.blockId || '(no-block)';
          const term = c.dataset.terminal || '(no-term)';
          console.debug(`CT: connector[${i}] block=${bid} term=${term} net=${nid}`);
        });
        console.debug('CT: connections (raw):', connections.map(c=>({ from: c.conn1?.dataset?.blockId, to: c.conn2?.dataset?.blockId, line: c.line?.dataset }))); 
      }
    } catch(e) { console.debug('CT: debug-no-nets failed', e); }
    return { success: false, reason: 'no-nets' };
  }
  const N = netMap.size;

  // Call library solver
  if (typeof CircuitSolver === 'undefined' || !CircuitSolver.solveMNA) { fallbackSimplePowering(); return { success:false, reason:'no-solver' }; }
  const sol = CircuitSolver.solveMNA(N, resistors, vSources, diodes, { maxIter: 60, tol: 1e-8, damping: 0.7 });
  if (!sol || !sol.success) { fallbackSimplePowering(); return { success:false, reason:'solver-failed' }; }

  // annotate results
  if (CT_DEBUG) {
    try { console.debug('CT: solver output', sol); } catch (e) { console.debug('CT: debug output failed', e); }
  }
  const V = sol.V; const J = sol.J || [];
  if (sol.resistorResults) {
    sol.resistorResults.forEach(rres => {
      const block = rres.meta && rres.meta.block;
      if (!block) return;
      block.dataset.voltageDrop = String(Math.abs(rres.Vdrop || 0));
      block.dataset.current = String(Math.abs(rres.I || 0));
    });
  }
  if (sol.diodeResults) {
    sol.diodeResults.forEach((dres, idx) => {
      const meta = diodes[idx]; if (!meta || !meta.block) return;
      // update LED metrics
      const I = Math.abs(dres.I || 0);
      const Vd = (dres.Vd || 0);
      meta.block.dataset.voltageDrop = String(Vd);
      meta.block.dataset.current = String(I);
      // Consider LED powered if forward voltage is reached and current exceeds micro-amp threshold
      const Vf = Number(meta.Vf || meta.block.dataset.forwardVoltage || 2);
      const Ithreshold = 1e-6; // 1 microamp minimal visible current
      if (Vd >= Vf && I > Ithreshold) {
        meta.block.dataset.powered = 'true';
        meta.block.classList.add('powered');
      } else {
        meta.block.dataset.powered = 'false';
        meta.block.classList.remove('powered');
      }
      // set LED visual intensity proportional to current (clamped)
      try {
        const maxVisualI = 0.02; // 20 mA typical LED bright
        const intensity = Math.min(1, I / maxVisualI);
        meta.block.style.setProperty('--led-intensity', String(intensity));
      } catch (e) { }
    });
  }
  // annotate voltage source currents if provided
  if (sol.J) {
    vSources.forEach((vs, idx) => { if (!vs.block) return; vs.block.dataset.current = String(Math.abs(sol.J[idx]||0)); vs.block.dataset.voltageDrop = String(vs.V||0); });
  }

  // If solver didn't produce diodeResults (e.g., LED modeled elsewhere), try a simple heuristic:
  // mark any LED as powered if it's in a complete series path from battery -> resistor -> LED -> battery
  // This is a fallback for circuits where diode modeling didn't return results.
  try {
    const leds = Array.from(diodes || []).map(d => d.block).filter(Boolean);
    if (leds.length) {
      leds.forEach(b => {
        if (b.dataset.powered === 'true') return; // already set via solver
        // simple heuristic: if LED has a nonzero voltage drop recorded (from adjacent resistor annotation) or current, use that
        const I = Math.abs(Number(b.dataset.current) || 0);
        const Vd = Math.abs(Number(b.dataset.voltageDrop) || 0);
        const Vf = Number(b.dataset.forwardVoltage || 2);
            if ((Vd >= Vf && I > 1e-6) || I > 1e-6) {
              // mark powered and attach conservative numeric estimates so the tooltip can show values
              b.dataset.powered = 'true'; b.classList.add('powered');
              // attach estimated (or previously computed) voltage drop/current for debug tooltip
              try { if (!b.dataset.voltageDrop || Number(b.dataset.voltageDrop) === 0) b.dataset.voltageDrop = String(Vf); } catch(e){}
              try { if (!b.dataset.current || Number(b.dataset.current) === 0) b.dataset.current = String(Math.max(I, 1e-4)); } catch(e){}
            }
            try { const maxVisualI = 0.02; const intensity = Math.min(1, Math.max(I, 1e-6) / maxVisualI); b.style.setProperty('--led-intensity', String(intensity)); } catch(e){}
      });
    }
  } catch (e) { /* ignore fallback errors */ }

  // Additional robust path-based powering heuristic:
  // Build net adjacency from components (exclude voltage sources) and search for paths
  try {
    // Build adjacency: netId -> [{ toNet, type, meta }]
    const adj = new Map();
    function addAdj(a,b,meta){ if (a==null || b==null) return; if (!adj.has(a)) adj.set(a,[]); adj.get(a).push({to:b, meta}); if (!adj.has(b)) adj.set(b,[]); adj.get(b).push({to:a, meta}); }
    // add resistors and diodes as edges
    resistors.forEach((r, idx) => { addAdj(r.n1, r.n2, { type: 'resistor', R: Number(r.R)||0, block: r.block, idx }); });
    diodes.forEach((d, idx) => { addAdj(d.n1, d.n2, { type: 'led', Vf: d.Vf || Number(d.block?.dataset?.forwardVoltage)||2, block: d.block, idx, n1: d.n1, n2: d.n2 }); });

    // helper BFS to find path of nets excluding using any battery edges
    function findPath(startNet, endNet){
      if (startNet==null || endNet==null) return null;
      const q = [{ net: startNet, via: null }];
      const seen = new Map(); // net -> { prevNet, viaMeta }
      seen.set(startNet, { prev: null, via: null });
      while (q.length){ const cur = q.shift(); const list = adj.get(cur.net) || []; for (const e of list){ const to = e.to; if (seen.has(to)) continue; seen.set(to, { prev: cur.net, via: e.meta }); if (to === endNet) { // reconstruct path
            const path = []; let curN = to; while (curN !== startNet){ const info = seen.get(curN); path.unshift({ net: curN, via: info.via }); curN = info.prev; } path.unshift({ net: startNet, via: null }); return path; }
          q.push({ net: to, via: e.meta }); }
      }
      return null;
    }

    // For each battery, try to find a non-trivial path from plus to minus
    vSources.forEach(vs => {
      if (!vs || vs.nPlus==null || vs.nMinus==null) return;
      const path = findPath(vs.nPlus, vs.nMinus);
      if (!path || path.length < 3) return; // trivial or no path
      // compute series resistance along path and collect LED edges encountered with orientation
      let Rsum = 0; const ledsOnPath = [];
      for (let i=1;i<path.length;i++){
        const via = path[i].via; if (!via) continue; if (via.type === 'resistor') Rsum += (Number(via.R) || 0); else if (via.type === 'led') {
          // determine traversal direction: we moved from prev net to this net; find if that corresponds to n1->n2 (forward)
          const prevNet = path[i-1].net; const curNet = path[i].net;
          let forward = false;
          if (via.n1 != null && via.n2 != null) {
            // if prevNet === n1 and curNet === n2, we traversed anode->cathode
            if (prevNet === via.n1 && curNet === via.n2) forward = true;
            // if prevNet === n2 and curNet === via.n1, then we traversed reverse
          }
          ledsOnPath.push({ meta: via, forward, block: via.block });
        }
      }
      // estimate current: if Rsum > 0, I = V / Rsum; otherwise treat as small (avoid infinite)
      const Vb = Number(vs.V) || 0;
      const Iest = Rsum > 0 ? Math.abs(Vb) / Rsum : 1e-3; // if no resistor, small conservative current
      const Ith = 1e-6;
      if (Iest > Ith && ledsOnPath.length){
        ledsOnPath.forEach(l => {
          if (!l.block) return;
          // only mark if orientation is forward (anode->cathode) or if unknown, mark anyway
          if (l.forward || l.forward == null) {
            l.block.dataset.powered = 'true'; l.block.classList.add('powered');
            // set intensity proportional to Iest, reuse same maxVisualI as elsewhere
            try { const maxVisualI = 0.02; const intensity = Math.min(1, Iest / maxVisualI); l.block.style.setProperty('--led-intensity', String(intensity)); } catch(e){}
          }
        });
      }
    });
  } catch(e) { /* non-critical */ }

  // system summary logic removed
  return { success: true, sol };
}

// Build a lightweight circuit model (connectors, nets, components) that can be
// consumed by either the advanced MNA solver or the basic fallback solver.
function buildCircuitModel(){
  const connectorList = Array.from(workspace.querySelectorAll('.input'));
  const cIndex = new Map(connectorList.map((c,i) => [c,i]));
  const parent = connectorList.map((_,i) => i);
  function find(i){ return parent[i]===i?i:(parent[i]=find(parent[i])); }
  function union(i,j){ const ri=find(i), rj=find(j); if(ri!==rj) parent[rj]=ri; }
  connections.forEach(c => { if (!c.conn1 || !c.conn2) return; const i=cIndex.get(c.conn1), j=cIndex.get(c.conn2); if (i!=null && j!=null) union(i,j); });
  const netId = connectorList.map((_,i) => find(i));
  const netMap = new Map(); let netCounter = 0;
  function netFor(conn){ const idx = cIndex.get(conn); if (idx==null) return null; const r = netId[idx]; if (!netMap.has(r)) netMap.set(r, netCounter++); return netMap.get(r); }

  // Collect components
  const blocks = Array.from(workspace.querySelectorAll('.block'));
  const resistors = []; const vSources = []; const diodes = [];
  blocks.forEach(b => {
    const left = b.querySelector('.input.left');
    const right = b.querySelector('.input.right');
    if (!left || !right) return;
    const na = netFor(left); const nb = netFor(right);
    if (b.dataset.type === 'resistor') {
      resistors.push({ n1: na, n2: nb, R: Number(b.dataset.resistance)||1e-12, block: b });
    } else if (b.dataset.type === 'battery') {
      // Battery positive terminal is on the right
      vSources.push({ nPlus: nb, nMinus: na, V: Number(b.dataset.voltage)||5, block: b });
    } else if (b.dataset.type === 'switch') {
      // Switches are modeled as resistors: very low R when on, very high when off
      const isOn = b.dataset.state !== 'off';
      resistors.push({ n1: na, n2: nb, R: isOn ? 1e-6 : 1e12, block: b });
    } else if (b.dataset.type === 'led') {
      // LEDs behave like resistors that light up when current flows (no polarity)
      resistors.push({ n1: na, n2: nb, R: Number(b.dataset.resistance)||100, block: b, meta: {type:'led'} });
    }
  });

  return { connectorList, cIndex, netMap, netFor, resistors, vSources, diodes };
}

// Basic solver runner state
let isBasicSimRunning = false;
let basicSimInterval = null;

function applyBasicResults(results){
  // results: { resistorResults:[{idx,I,Vdrop}] } - LEDs are in resistorResults with meta.type=='led'
  try {
    if (results.resistorResults) results.resistorResults.forEach(rr => {
      const meta = rr.meta; if (!meta || !meta.block) return;
      const I = Math.abs(rr.I||0);
      const V = Math.abs(rr.Vdrop||0);
      meta.block.dataset.current = String(I);
      meta.block.dataset.voltageDrop = String(V);
      
      // If this is an LED, light it up based on current
      if (meta.type === 'led') {
        const isLit = I > 1e-6; // LED lights up with any significant current
        meta.block.dataset.powered = String(isLit);
        meta.block.classList[isLit ? 'add' : 'remove']('powered');
        if (isLit) {
          // Visual intensity uses a max reference current
          const maxVisualI = 0.02;
          const intensity = Math.min(1, I / maxVisualI);
          meta.block.style.setProperty('--led-intensity', String(intensity));
        }
      }
    });
    // Additional pass: ensure any LED that has a measurable current or sufficient V is marked powered
    try {
      const leds = Array.from(workspace.querySelectorAll('.block[data-type="led"]'));
      leds.forEach(lb => {
        const I = Math.abs(Number(lb.dataset.current) || 0);
        const Vd = Math.abs(Number(lb.dataset.voltageDrop) || 0);
        const Vf = Number(lb.dataset.forwardVoltage || lb.dataset.forwardvoltage || 2);
        const Ith = 1e-6;
        if (I > Ith || Vd >= Vf) {
          lb.dataset.powered = 'true'; lb.classList.add('powered');
          try { const maxVisualI = 0.02; const intensity = Math.min(1, Math.max(I, 1e-6) / maxVisualI); lb.style.setProperty('--led-intensity', String(intensity)); } catch(e){}
          // ensure dataset.current/voltageDrop exist for tooltip clarity
          if (!lb.dataset.current || Number(lb.dataset.current) === 0) lb.dataset.current = String(Math.max(I, 1e-6));
          if (!lb.dataset.voltageDrop || Number(lb.dataset.voltageDrop) === 0) lb.dataset.voltageDrop = String(Math.max(Vd, Vf));
        } else {
          lb.dataset.powered = 'false'; lb.classList.remove('powered');
        }
      });
    } catch(e) { /* non-critical */ }
  } catch(e){ console.debug('CT: applyBasicResults failed', e); }
}

function runBasicOnce(){
  const model = buildCircuitModel();
  if (!model || !model.netMap || model.netMap.size === 0) { updateSimBanner('Basic sim: no nets detected (check wiring or import).','error',true); setTimeout(()=>clearSimBanner(),3000); return; }
  if (CT_DEBUG) {
    try { console.debug('CT: Basic sim model', { nets: model.netMap.size, resistors: model.resistors.length, batteries: model.vSources.length, diodes: model.diodes.length }); } catch(e){}
  }
  // Detailed debug: list connectors and their net ids, and component net assignments
  if (CT_DEBUG) {
    try {
      console.debug('CT: connectors mapping:');
      model.connectorList.forEach((c, i) => {
        const bid = c.dataset.blockId || c.closest('.block')?.dataset?.id || '(no-block)';
        const term = c.dataset.terminal || '(no-term)';
        const net = model.netFor(c);
        console.debug(`CT: connector[${i}] block=${bid} term=${term} net=${net}`);
      });
      console.debug('CT: components:');
      model.resistors.forEach((r, i) => console.debug(`resistor[${i}] n1=${r.n1} n2=${r.n2} R=${r.R} block=${r.block?.dataset?.id}`));
      model.vSources.forEach((v, i) => console.debug(`battery[${i}] nPlus=${v.nPlus} nMinus=${v.nMinus} V=${v.V} block=${v.block?.dataset?.id}`));
      model.diodes.forEach((d, i) => console.debug(`led[${i}] n1=${d.n1} n2=${d.n2} Vf=${d.Vf} block=${d.block?.dataset?.id}`));
    } catch(e) { console.debug('CT: connector/component debug failed', e); }
  }
  if (!window.SimpleSolver || !window.SimpleSolver.simulate) { updateSimBanner('Basic sim backend not loaded.', 'error', true); setTimeout(()=>clearSimBanner(),2000); return; }
  const res = window.SimpleSolver.simulate(model);
  if (CT_DEBUG) try { console.debug('CT: Basic sim result', res); } catch(e){}
  if (res && res.success) { applyBasicResults(res); } else { updateSimBanner('Basic sim failed to produce results.', 'error', true); setTimeout(()=>clearSimBanner(),2000); }
  return res;
}

function startBasicSimulation(button){
  if (isBasicSimRunning) return;
  isBasicSimRunning = true; disableEditingDuringSim(true);
  if (button) { button.classList.add('stop'); button.textContent = 'Stop Basic'; }
  updateSimBanner('Basic simulation running…','ok',true);
  // ensure simple solver script is loaded (dynamic load)
  if (!window.SimpleSolver) {
    const s = document.createElement('script'); s.src = './simple-solver.js'; s.onload = ()=>{ console.info('CT: SimpleSolver loaded'); };
    s.onerror = ()=>{ updateSimBanner('Failed to load SimpleSolver.js', 'error', true); };
    document.body.appendChild(s);
  }
  // immediate run
  try { runBasicOnce(); } catch(e){ console.error(e); }
  basicSimInterval = setInterval(()=>{ runBasicOnce(); }, 700);
}

function stopBasicSimulation(button){
  if (!isBasicSimRunning) return;
  isBasicSimRunning = false; disableEditingDuringSim(false);
  if (button) { button.classList.remove('stop'); button.textContent = 'Run Basic Simulation'; }
  if (basicSimInterval) { clearInterval(basicSimInterval); basicSimInterval = null; }
  updateSimBanner('Basic simulation stopped.', 'ok', true);
  setTimeout(()=>clearSimBanner(),1200);
}

// Update tooltip contents for a block element
function updateTooltipForBlock(block, tt) {
  const lines = [];
  const type = block.dataset.type || 'component';
  lines.push(type.toUpperCase());
  if (block.dataset.resistance) lines.push(`R: ${Number(block.dataset.resistance).toFixed(2)} Ω`);
  if (block.dataset.voltage) lines.push(`V: ${Number(block.dataset.voltage).toFixed(2)} V`);
  if (block.dataset.voltageDrop) lines.push(`ΔV: ${Number(block.dataset.voltageDrop).toFixed(4)} V`);
  if (block.dataset.current) lines.push(`I: ${Number(block.dataset.current).toFixed(6)} A`);
  if (block.dataset.powered === 'true') lines.push('Powered: yes');
  // If debugging is enabled, append raw dataset for quick inspection
  if (CT_DEBUG) {
    try {
      const raw = JSON.stringify(block.dataset); lines.push(`<small style="color:#9ca3af;margin-top:6px">${raw}</small>`);
    } catch(e) {}
  }
  tt.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
}

// Fallback simple powering logic (used when solver cannot run)
function fallbackSimplePowering() {
  const adjConn = new Map();
  function addEdgeConn(a, b, meta) {
    if (!adjConn.has(a)) adjConn.set(a, []);
    if (!adjConn.has(b)) adjConn.set(b, []);
    adjConn.get(a).push({ node: b, meta });
    adjConn.get(b).push({ node: a, meta });
  }
  connections.forEach(c => { if (c.conn1 && c.conn2) addEdgeConn(c.conn1, c.conn2, { type: 'wire' }); });
  const blocks = workspace.querySelectorAll('.block');
  blocks.forEach(b => { const l = b.querySelector('.input.left'); const r = b.querySelector('.input.right'); if (l && r) addEdgeConn(l, r, { type: 'component', block: b }); });
  const batteries = Array.from(blocks).filter(b => b.dataset.type === 'battery' && b.parentElement === workspace);
  batteries.forEach(batt => {
    const pos = batt.querySelector('.input.right');
    const neg = batt.querySelector('.input.left');
    if (!pos || !neg) return;
    const queue = [{ node: pos, cameThroughLED: false }];
    const visited = new Set([pos]);
    let found = false;
    while (queue.length && !found) {
      const { node, cameThroughLED } = queue.shift();
      if (node === neg) { if (cameThroughLED) found = true; break; }
      const neighbors = adjConn.get(node) || [];
      for (const nb of neighbors) {
        const next = nb.node;
        if (visited.has(next)) continue;
        visited.add(next);
        let nextCame = cameThroughLED;
        if (nb.meta && nb.meta.type === 'component' && nb.meta.block.dataset.type === 'led') nextCame = true;
        queue.push({ node: next, cameThroughLED: nextCame });
      }
    }
    if (found) {
      const reachableFromPos = new Set(); (function dfs(node){ if (reachableFromPos.has(node)) return; reachableFromPos.add(node); const neighbors = adjConn.get(node)||[]; for (const nb of neighbors) dfs(nb.node); })(pos);
      const reachableToNeg = new Set(); (function dfs2(node){ if (reachableToNeg.has(node)) return; reachableToNeg.add(node); const neighbors = adjConn.get(node)||[]; for (const nb of neighbors) dfs2(nb.node); })(neg);
      blocks.forEach(b => { if (b.dataset.type !== 'led') return; const l = b.querySelector('.input.left'); const r = b.querySelector('.input.right'); if (l && r && reachableFromPos.has(l) && reachableFromPos.has(r) && reachableToNeg.has(l) && reachableToNeg.has(r)) { b.dataset.powered = 'true'; b.classList.add('powered'); } });
      // attach conservative numeric estimates for LEDs discovered by this connectivity-only heuristic
      try {
        // estimate current based on simple series assumption (if no resistor found we pick a small current)
        const Vbat = Number(batt.dataset.voltage) || 5;
        const Rseries = 100; // conservative guessed series resistance if none is explicitly present
        const Iest = Rseries > 0 ? Math.abs(Vbat) / Rseries : 1e-3;
        Array.from(blocks).forEach(b => {
          if (b.dataset.type !== 'led') return;
          const l = b.querySelector('.input.left'); const r = b.querySelector('.input.right');
          if (!(l && r)) return;
          if (reachableFromPos.has(l) && reachableFromPos.has(r) && reachableToNeg.has(l) && reachableToNeg.has(r)) {
            if (!b.dataset.current) b.dataset.current = String(Iest);
            if (!b.dataset.voltageDrop) b.dataset.voltageDrop = String(Number(b.dataset.forwardVoltage || 2));
            try { const intensity = Math.min(1, Iest / 0.02); b.style.setProperty('--led-intensity', String(intensity)); } catch(e){}
          }
        });
      } catch(e) { /* non-critical */ }
    }
  });
    }

    // Start/Stop simulation runner
    function startSimulation(button){
      if (isSimRunning) return;
      disableEditingDuringSim(true);
      if (button) { button.classList.add('stop'); button.textContent = 'Stop Simulation'; }
      simTickCount = 0; simNoProgressCount = 0; lastSimSummary = { ledCount: 0, totalCurrent: 0 };
      updateSimBanner('Simulation running…', 'ok', true);
      // immediate run
      try { evaluateCircuit(); } catch(e){ console.error(e); }
      simInterval = setInterval(()=>{
        simTickCount++;
        const res = evaluateCircuit();
        // summarize
        const ledsPowered = workspace.querySelectorAll('.block[data-type="led"].powered').length;
        let totalCurrent = 0;
        Array.from(workspace.querySelectorAll('.block')).forEach(b=>{ totalCurrent += Math.abs(Number(b.dataset.current) || 0); });
        // detect solver failure
        if (res && res.success === false){
          if (res.reason === 'solver-failed') updateSimBanner('Solver failed to converge (singular / looped circuit). Try adding a resistor or check wiring.', 'error', true);
          else if (res.reason === 'no-nets') updateSimBanner('No nets detected: components are not connected.', 'error', true);
        }
        // detect lack of visible progress: no LEDs lit and near-zero currents
        const noProgress = (ledsPowered === 0 && totalCurrent < 1e-6);
        if (noProgress){ simNoProgressCount++; } else { simNoProgressCount = 0; clearSimBanner(); }
        if (simNoProgressCount >= 6){ updateSimBanner('No powered components detected. Check wiring, polarity, or battery voltage.', 'error', true); }
        lastSimSummary = { ledCount: ledsPowered, totalCurrent };
      }, 600);
    }

    function stopSimulation(button){
      if (!isSimRunning) return;
      disableEditingDuringSim(false);
      if (button) { button.classList.remove('stop'); button.textContent = 'Run Simulation'; }
      if (simInterval) { clearInterval(simInterval); simInterval = null; }
      updateSimBanner('Simulation stopped.', 'ok', true);
      setTimeout(()=>{ clearSimBanner(); }, 1400);
    }

// --- Lesson / teaching UI (levels, show answer modal, submit feedback) ---
(function(){
  const levels = [
    {
      id: 0,
      title: 'Welcome to Circuit Studio',
      desc: "Welcome to Circuit Studio! Here you will learn how to make circuits and explore components. You can drag and drop parts from the left to connect them and light up LEDs, build simple math counters, switches, and more. Feel free to experiment try changing component values, rearranging wiring, and observe how voltage, current, and resistance change in the system. This environment is for learning, exploring, and having fun.",
      tips: [
        'Be sure to keep track of wiring and which components are powered avoid creating unintended short circuits or infinite loops.',
        'You can always delete or rotate parts if something does not work; rotating changes connector orientation.',
        'Try small experiments: change one thing at a time (e.g., resistor value) and observe what changes in the system summary.',
        'Ask yourself why a component is (or isn\'t) powered tracing the path of current helps a lot.',
        'Connector polarity tip: battery RIGHT → component RIGHT (anode) → component LEFT (cathode) → battery LEFT — this is the easiest series wiring pattern to light an LED.'
      ],
      image: null
    },
    {
      id: 1,
      title: 'Connect an LED',
      desc: "Place a battery, an LED, and a resistor so the LED lights when the circuit is complete. This teaches polarity, series connections, and current limiting.",
      tips: [
        'Try to connect a resistor in series with the LED to limit current rather than putting it in parallel.',
        'Make sure the LED is oriented correctly (anode vs cathode) LEDs only light when forward biased.',
        'If the LED does not light, double-check your wires form a closed loop back to the battery.'
      ],
      image: null
    },
    {
      id: 2,
      title: 'Ramping up voltage',
      desc: "Chain batteries in series to increase total voltage and observe how current changes through resistors and LEDs. This helps you understand why voltage adds in series and how higher voltage affects components.",
      tips: [
        'Connect batteries in series (positive to negative) to add voltages; watch component limits.',
        'Higher voltage can increase current use resistors to protect LEDs and other parts.',
        'Observe the system summary for voltage and current changes as you add batteries.'
      ],
      image: null
    },
    {
      id: 3,
      title: 'Series and Parallel Resistors',
      desc: "Build circuits with resistors arranged in series and parallel to see how total resistance and current change. Series adds resistances; parallel reduces the equivalent resistance.",
      tips: [
        'Try combining equal resistors in series and parallel and compare total resistance in the system summary.',
        'Measure how current through a branch changes when you alter resistor values.',
        'Think about how splitting current in parallel affects component voltages.'
      ],
      image: null
    },
    {
      id: 4,
      title: 'Connecting to a 7-segment display',
      desc: "A 7-segment display is made of multiple LED segments. Plan which segments to drive, use resistors for each segment, and decide between a common-anode or common-cathode wiring approach.",
      tips: [
        'Each segment behaves like an LED: give it a resistor to limit current.',
        'Decide whether your display is common-anode or common-cathode and wire accordingly.',
        'Start by lighting a single segment before trying to drive all seven.'
      ],
      image: null
    },
    {
      id: 5,
      title: 'Experiment!',
      desc: "Combine what you\'ve learned: design small projects, try logic using LEDs and switches, or build measurement setups. This level is intentionally open-ended to encourage creativity.",
      tips: [
        'Try combining batteries, resistors, and LEDs to make a small pattern or indicator.',
        'Break big ideas into small steps: prototype one section, test, then expand.',
        'Don\'t be afraid to fail — iterating is how you learn. Have fun!'
      ],
      image: null
    }
  ];

  function initLevelSelector(){
    const sel = document.getElementById('level-select');
    if (!sel) return;
    sel.innerHTML = levels.map(l => `<option value="${l.id}">${l.id}. ${l.title}</option>`).join('');
    sel.addEventListener('change', e => {
      const id = Number(e.target.value);
      updateLessonUI(id);
    });
    // default
    updateLessonUI(levels[0].id);
  }

  function updateLessonUI(id){
    const lvl = levels.find(l=>l.id===id) || levels[0];
    const num = document.getElementById('level-num');
    const title = document.getElementById('level-title');
    const desc = document.getElementById('level-desc');
    if (num) num.textContent = `${lvl.id}.`;
    if (title) title.textContent = lvl.title;
    if (desc) {
      // render the main description and optional tips as HTML
      let html = `<p>${lvl.desc}</p>`;
      if (Array.isArray(lvl.tips) && lvl.tips.length) {
        html += '<div class="level-tips"><strong></strong><ol>' + lvl.tips.map(t => `<li>${t}</li>`).join('') + '</ol></div>';
      }
      desc.innerHTML = html;
    }
    // clear any previous result message
    const res = document.getElementById('answer-result'); if (res) res.style.display = 'none';
  }

  function showAnswerModalForLevel(id){
    const modal = document.getElementById('answer-modal');
    const img = document.getElementById('answer-image');
    if (!modal || !img) return;
    // placeholder inline SVG image
    const svgData = encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='800' height='480'><rect width='100%' height='100%' fill='%23ffffff' /><text x='50%' y='50%' font-size='28' text-anchor='middle' fill='%236b7280'>Answer image placeholder</text></svg>`);
    img.src = `data:image/svg+xml;utf8,${svgData}`;
    modal.classList.add('visible');
    modal.setAttribute('aria-hidden','false');
  }

  function closeAnswerModal(){
    const modal = document.getElementById('answer-modal');
    if (!modal) return;
    modal.classList.remove('visible');
    modal.setAttribute('aria-hidden','true');
  }

  function submitAnswer(){
    // For now simply show congrats message briefly
    const res = document.getElementById('answer-result');
    if (!res) return;
    res.textContent = 'Congrats!';
    res.style.display = 'block';
    // small highlight animation
    res.style.opacity = '1';
    setTimeout(()=>{ if (res) { res.style.display = 'none'; } }, 2200);
  }

  // wire up UI after DOM ready
  document.addEventListener('DOMContentLoaded', ()=>{
    // ensure tooltip exists early so hover tooltips always work
    ensureTooltipElement();
    // simulation controls
      // simulation controls
      const simBtn = document.getElementById('sim-run');
      if (simBtn){
        simBtn.addEventListener('click', ()=>{
          if (!isSimRunning) startSimulation(simBtn); else stopSimulation(simBtn);
        });
      }
      // basic/simple solver control
      const basicBtn = document.getElementById('sim-basic');
      if (basicBtn){
        basicBtn.addEventListener('click', ()=>{
          if (!isBasicSimRunning) startBasicSimulation(basicBtn); else stopBasicSimulation(basicBtn);
        });
      }
      // top-right undo button (quick workspace undo)
      const undoTopBtn = document.getElementById('undo-top');
      if (undoTopBtn) undoTopBtn.addEventListener('click', ()=>{ undo(); });
    // create sim banner element once
    ensureSimBanner();
    initLevelSelector();
    const showBtn = document.getElementById('show-answer');
    const submitBtn = document.getElementById('submit-answer');
    const modal = document.getElementById('answer-modal');
    if (showBtn) showBtn.addEventListener('click', ()=>{
      const sel = document.getElementById('level-select');
      const id = sel ? Number(sel.value) : 0;
      showAnswerModalForLevel(id);
    });
    if (submitBtn) submitBtn.addEventListener('click', ()=>{
      submitAnswer();
    });
    if (modal) {
      modal.querySelector('.overlay')?.addEventListener('click', closeAnswerModal);
      modal.querySelector('.close')?.addEventListener('click', closeAnswerModal);
    }
  // The test circuit button was removed from the UI. (loadTestCircuit was removed.)
  });

})();
