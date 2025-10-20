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

// Create an SVG layer for wires
const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
svg.setAttribute("class", "wire-layer");
workspace.appendChild(svg);

// create a simple custom context menu (hidden by default)
function ensureContextMenu() {
  if (contextMenu) return;
  contextMenu = document.createElement('div');
  contextMenu.className = 'ct-context-menu';
  contextMenu.innerHTML = '<div id="ct-delete">Click to delete</div>';
  document.body.appendChild(contextMenu);

  // create tooltip used for hover display
  if (!document.querySelector('.ct-tooltip')) {
    const tt = document.createElement('div');
    tt.className = 'ct-tooltip';
    document.body.appendChild(tt);
  }

  // click handler for delete
  contextMenu.addEventListener('click', e => {
    const targetBlock = contextMenu._targetBlock;
    if (!targetBlock) return hideContextMenu();
    if (e.target.id === 'ct-delete') {
      removeBlockAndConnections(targetBlock);
      hideContextMenu();
      return;
    }

    // handle save from inline editor
    if (e.target.id === 'ct-save') {
      const input = contextMenu.querySelector('input');
      if (!input) return hideContextMenu();
      const val = Number(input.value);
      if (isNaN(val)) return hideContextMenu();
      const blk = contextMenu._targetBlock;
      if (blk.dataset.type === 'battery') blk.dataset.voltage = String(val);
      if (blk.dataset.type === 'resistor') blk.dataset.resistance = String(val);
      evaluateCircuit();
      hideContextMenu();
      return;
    }
    hideContextMenu();
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
  contextMenu.innerHTML = '<div id="ct-delete">Click to delete</div>';
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

// --- Handle drag start from palette ---
paletteBlocks.forEach(block => {
  block.addEventListener("mousedown", e => {
    const type = block.dataset.type;
    const newBlock = createBlockInstance(type);

    newBlock.classList.add("dragging");
    document.body.appendChild(newBlock);
    moveBlockTo(newBlock, e.pageX, e.pageY);

    draggingBlock = newBlock;
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
  block.textContent = type.toUpperCase();

  // style based on palette version
  // visual styling is handled by CSS classes (palette and instance rules)

  const leftInput = document.createElement("div");
  leftInput.className = "input left";
  const rightInput = document.createElement("div");
  rightInput.className = "input right";

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
    block.dataset.forwardVoltage = 2; // volts (approx)
    block.dataset.powered = 'false';
  }

  // tooltip handlers (show measurements)
  block.addEventListener('mouseenter', e => {
    // delay tooltip by 500ms
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(()=>{
      const tt = document.querySelector('.ct-tooltip');
      if (!tt) return;
      updateTooltipForBlock(block, tt);
      const rect = block.getBoundingClientRect();
      tt.style.left = (rect.right + 8) + 'px';
      tt.style.top = (rect.top) + 'px';
      tt.classList.add('visible');
    }, 500);
  });
  block.addEventListener('mousemove', e => {
    const tt = document.querySelector('.ct-tooltip');
    if (!tt) return;
    tt.style.left = (e.pageX + 10) + 'px';
    tt.style.top = (e.pageY + 10) + 'px';
    updateTooltipForBlock(block, tt);
  });
  block.addEventListener('mouseleave', e => {
    clearTimeout(hoverTimer);
    const tt = document.querySelector('.ct-tooltip');
    if (!tt) return;
    tt.classList.remove('visible');
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
  const conns = connections.map(c=>({ conn1BlockId: c.conn1.dataset.blockId, conn1Terminal: c.conn1.dataset.terminal, conn2BlockId: c.conn2.dataset.blockId, conn2Terminal: c.conn2.dataset.terminal }));
  undoStack.push({ blocks, conns });
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
    const b = createBlockInstance(bdata.type);
    b.dataset.id = bdata.id;
    Object.keys(bdata.dataset||{}).forEach(k=>b.dataset[k]=bdata.dataset[k]);
    b.style.position='absolute'; b.style.left = bdata.left; b.style.top = bdata.top; b.classList.add('instance');
    workspace.appendChild(b);
    makeMovable(b);
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
});

function exportCircuit(){
  const blocks = Array.from(workspace.querySelectorAll('.block')).map(b=>({ id:b.dataset.id, type:b.dataset.type, dataset:{...b.dataset}, left:b.style.left, top:b.style.top }));
  const conns = connections.map(c=>({ conn1BlockId:c.conn1.dataset.blockId, conn1Terminal:c.conn1.dataset.terminal, conn2BlockId:c.conn2.dataset.blockId, conn2Terminal:c.conn2.dataset.terminal }));
  return { blocks, conns };
}

function importCircuit(data){
  if (!data) return;
  // clear current
  connections.forEach(c=>{ if (c.line && c.line.parentNode) c.line.parentNode.removeChild(c.line); }); connections=[];
  workspace.querySelectorAll('.block').forEach(b=>b.remove());
  data.blocks.forEach(bdata=>{
    const b = createBlockInstance(bdata.type);
    b.dataset.id = bdata.id || `b${_blockIdCounter++}`;
    Object.keys(bdata.dataset||{}).forEach(k=>b.dataset[k]=bdata.dataset[k]);
    b.style.position='absolute'; b.style.left=bdata.left; b.style.top=bdata.top; b.classList.add('instance');
    workspace.appendChild(b); makeMovable(b);
  });
  data.conns.forEach(c=>{
    const b1 = Array.from(workspace.querySelectorAll('.block')).find(x=>x.dataset.id===c.conn1BlockId);
    const b2 = Array.from(workspace.querySelectorAll('.block')).find(x=>x.dataset.id===c.conn2BlockId);
    if (!b1 || !b2) return;
    const conn1 = b1.querySelector(`.input.${c.conn1Terminal}`);
    const conn2 = b2.querySelector(`.input.${c.conn2Terminal}`);
    if (conn1 && conn2) createWire(conn1, conn2);
  });
  evaluateCircuit();
}

// --- Handle connecting two inputs ---
function handleConnectorClick(e, connector) {
  e.stopPropagation();
  if (!selectedConnector) {
    // select the first connector
    selectedConnector = connector;
    connector.classList.add("selected");
  } else if (selectedConnector === connector) {
    // clicking same one cancels selection
    connector.classList.remove("selected");
    selectedConnector = null;
  } else {
    // connect the two
    createWire(selectedConnector, connector);
    selectedConnector.classList.remove("selected");
    selectedConnector = null;
  }
}

// --- Draw a wire between two connectors ---
function createWire(conn1, conn2) {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("stroke", "#222");
  line.setAttribute("stroke-width", "2");

  svg.appendChild(line);

  connections.push({ line, conn1, conn2 });
  updateWirePosition({ line, conn1, conn2 });
  // evaluate circuit whenever a wire is created
  evaluateCircuit();
}

// --- Update wire position ---
function updateWirePosition(conn) {
  const { conn1, conn2, line } = conn;
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
}

// --- Update all wires when blocks move ---
function updateAllWires() {
  connections.forEach(updateWirePosition);
}

// Remove all connections for a given block and remove the block from DOM
function removeBlockAndConnections(block) {
  if (!block || !block.parentElement) return;

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
  // MNA nodal solver (supports resistors and independent voltage sources)
  // Reset component measurement metadata
  const blocks = workspace.querySelectorAll('.block');
  blocks.forEach(b => {
    delete b.dataset.current;
    delete b.dataset.voltageDrop;
    if (b.dataset.type === 'battery' && !b.dataset.voltage) b.dataset.voltage = 10;
    if (b.dataset.type === 'resistor' && !b.dataset.resistance) b.dataset.resistance = 100;
    if (b.dataset.type === 'led' && !b.dataset.forwardVoltage) b.dataset.forwardVoltage = 2;
    if (b.dataset.type === 'led') { b.dataset.powered = 'false'; b.classList.remove('powered'); }
  });

  // build connector list and net ids using union-find (wires short connectors)
  const connectorList = Array.from(workspace.querySelectorAll('.input'));
  const cIndex = new Map(connectorList.map((c,i) => [c,i]));
  const parent = connectorList.map((_,i) => i);
  function find(i){ return parent[i]===i?i:(parent[i]=find(parent[i])); }
  function union(i,j){ const ri=find(i), rj=find(j); if(ri!==rj) parent[rj]=ri; }
  connections.forEach(c => { if (!c.conn1 || !c.conn2) return; const i=cIndex.get(c.conn1), j=cIndex.get(c.conn2); if (i!=null && j!=null) union(i,j); });
  const netId = connectorList.map((_,i) => find(i));

  // map nets to indices (exclude nets with no components)
  const netMap = new Map(); let netCounter = 0;
  function netForConnector(conn){ const idx = cIndex.get(conn); if (idx==null) return null; const r = netId[idx]; if (!netMap.has(r)) netMap.set(r, netCounter++); return netMap.get(r); }

  // collect components and build MNA elements
  const resistors = []; const vSources = []; const diodes = [];
  connectorList.forEach(() => {});
  blocks.forEach(b => {
    const left = b.querySelector('.input.left');
    const right = b.querySelector('.input.right');
    if (!left || !right) return;
    const na = netForConnector(left);
    const nb = netForConnector(right);
    if (b.dataset.type === 'resistor') {
      resistors.push({ n1: na, n2: nb, R: Number(b.dataset.resistance)||0, block: b });
    } else if (b.dataset.type === 'battery') {
      vSources.push({ nPlus: nb, nMinus: na, V: Number(b.dataset.voltage)||10, block: b });
    } else if (b.dataset.type === 'led') {
      // diode using Shockley equation: I = Is*(exp(Vd/nVt)-1)
      // Note: choose orientation so the block's RIGHT connector is the diode anode
      // and the LEFT connector is the diode cathode. This matches how batteries
      // are stamped (right = positive, left = negative) and makes typical
      // right-to-left current flow forward-bias the LED.
      const Vf = Number(b.dataset.forwardVoltage) || 2;
      const Is = 1e-12; // saturation current (heuristic)
      const nVt = 0.026; // thermal voltage * ideality factor (approx)
      // note: n1 is the anode net, n2 is the cathode net
      diodes.push({ n1: nb, n2: na, Is, nVt, Vf, block: b });
    }
  });

  // If there are no nets or no components, fallback
  if (netMap.size === 0) { return; }

  // We'll solve using Newton-Raphson: at each iter linearize diodes to conductance + current source
  const N = netMap.size; const M = vSources.length;

  function buildAndSolveWithDiodeLinearization(voltGuess) {
    // voltGuess: array length N initial node voltages
    // Build linearized G matrix and RHS z
    const G = Array.from({length:N},()=>Array(N).fill(0));
    const I = Array(N).fill(0);
    // add resistors
    resistors.forEach(r=>{
      if (r.n1 == null || r.n2 == null) return;
      const g = 1/(r.R||1e-12);
      if (r.n1 !== r.n2) {
        G[r.n1][r.n1] += g; G[r.n2][r.n2] += g; G[r.n1][r.n2] -= g; G[r.n2][r.n1] -= g;
      } else { G[r.n1][r.n1] += g; }
    });

    // linearize diodes
    diodes.forEach(d=>{
      if (d.n1==null || d.n2==null) return;
      const v1 = voltGuess[d.n1]||0; const v2 = voltGuess[d.n2]||0; const Vd = v1 - v2;
      // Shockley
      const Icalc = d.Is * (Math.exp(Vd / d.nVt) - 1);
      const Gd = (d.Is / d.nVt) * Math.exp(Vd / d.nVt); // dI/dV
      // current source equivalent: I_eq = Icalc - Gd * Vd
      const Ieq = Icalc - Gd * Vd;
      // stamp
      if (d.n1 !== d.n2) {
        G[d.n1][d.n1] += Gd; G[d.n2][d.n2] += Gd; G[d.n1][d.n2] -= Gd; G[d.n2][d.n1] -= Gd;
        I[d.n1] -= Ieq; I[d.n2] += Ieq; // sign: currents injected to node
      } else {
        G[d.n1][d.n1] += Gd; I[d.n1] -= Ieq;
      }
    });

    // Now include voltage sources via MNA expansion
    const B = Array.from({length:N},()=>Array(M).fill(0));
    const E = vSources.map(v=>v.V);
    vSources.forEach((vs, j) => { if (vs.nPlus != null) B[vs.nPlus][j] = 1; if (vs.nMinus != null) B[vs.nMinus][j] = -1; });

    const dim = N + M; const A = Array.from({length:dim},()=>Array(dim).fill(0)); const z = Array(dim).fill(0);
    for (let i=0;i<N;i++) for (let j=0;j<N;j++) A[i][j]=G[i][j];
    for (let i=0;i<N;i++) for (let j=0;j<M;j++) A[i][N+j]=B[i][j];
    for (let i=0;i<M;i++) for (let j=0;j<N;j++) A[N+i][j]=B[j][i];
    for (let i=0;i<N;i++) z[i]=I[i];
    for (let i=0;i<M;i++) z[N+i]=E[i];

    // solve
      let x=null; try { x = solveLinear(A,z); } catch(e) { x=null; }
    return x;
  }

    // Dense linear solver with partial pivoting
    // A is a square 2D array (n x n), z is RHS length n
    function solveLinear(Ain, zin) {
      const n = Ain.length;
      // clone matrices to avoid mutating inputs
      const A = Array.from({length:n}, (_,i) => Array.from(Ain[i]));
      const z = Array.from(zin);

      for (let i = 0; i < n; i++) {
        // find pivot
        let maxRow = i; let maxVal = Math.abs(A[i][i]);
        for (let r = i+1; r < n; r++) { const v = Math.abs(A[r][i]); if (v > maxVal) { maxVal = v; maxRow = r; } }
        if (maxVal < 1e-15) throw new Error('Singular matrix');
        // swap rows i and maxRow
        if (maxRow !== i) { const tmp = A[i]; A[i] = A[maxRow]; A[maxRow] = tmp; const tz = z[i]; z[i] = z[maxRow]; z[maxRow] = tz; }

        // normalize and eliminate
        const pivot = A[i][i];
        for (let r = i+1; r < n; r++) {
          const factor = A[r][i] / pivot;
          if (!isFinite(factor)) continue;
          for (let c = i; c < n; c++) A[r][c] -= factor * A[i][c];
          z[r] -= factor * z[i];
        }
      }

      // back substitution
      const x = Array(n).fill(0);
      for (let i = n-1; i >= 0; i--) {
        let s = z[i];
        for (let j = i+1; j < n; j++) s -= A[i][j] * x[j];
        x[i] = s / A[i][i];
      }
      return x;
    }

  // initial guess: zeros
  let Vguess = Array(N).fill(0);
  let converged = false; let x = null;
  for (let iter=0; iter<30; iter++) {
    x = buildAndSolveWithDiodeLinearization(Vguess);
    if (!x) break;
    const Vnew = x.slice(0,N);
    // check convergence
    let maxDiff = 0; for (let i=0;i<N;i++) maxDiff = Math.max(maxDiff, Math.abs((Vnew[i]||0) - (Vguess[i]||0)));
    Vguess = Vnew;
    if (maxDiff < 1e-6) { converged = true; break; }
  }
  // debug: if not converged, print summary to console to aid debugging
  if (!converged) {
    const hasLED = diodes.length > 0;
    if (hasLED) {
      console.warn('evaluateCircuit: NR did not converge', { N, M, diodesCount: diodes.length });
    }
  }
  if (!converged || !x) { fallbackSimplePowering(); return; }

  // extract and annotate
  const V = x.slice(0,N); const J = x.slice(N);
  // compute branch currents for resistors and diodes
  resistors.forEach(r=>{
    if (r.n1==null || r.n2==null) return;
    const v1 = V[r.n1]||0; const v2 = V[r.n2]||0; const vd = v1 - v2; const Icomp = vd / (r.R||1e-12);
    r.block.dataset.voltageDrop = String(Math.abs(vd)); r.block.dataset.current = String(Math.abs(Icomp));
  });
  diodes.forEach(d=>{
    if (d.n1==null || d.n2==null) return;
    const v1 = V[d.n1]||0; const v2 = V[d.n2]||0; const Vd = v1 - v2; const Icalc = d.Is * (Math.exp(Vd / d.nVt) - 1);
    d.block.dataset.voltageDrop = String(Vd); d.block.dataset.current = String(Math.abs(Icalc));
    if (Math.abs(Icalc) > 1e-5) { d.block.dataset.powered='true'; d.block.classList.add('powered'); }
  });
  vSources.forEach((vs, idx)=>{ vs.block.dataset.current = String(Math.abs(J[idx]||0)); vs.block.dataset.voltageDrop = String(vs.V); });

  // success
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
    }
  });
}
