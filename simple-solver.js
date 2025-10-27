// Simple, naive path-based circuit solver for teaching/demo purposes.
// It intentionally avoids matrix math and uses path finding / Ohm's law on series paths
// to estimate currents and voltages. This is best-effort and not a full circuit solver.

window.SimpleSolver = (function(){
  function simulate(model){
    try {
      if (!model) return { success:false, reason:'no-model' };
      const { netMap, resistors, vSources, diodes } = model;
      // Build adjacency on nets using resistors and diodes (voltage sources excluded)
      const adj = new Map();
      function addAdj(a,b,meta){ if (a==null||b==null) return; if (!adj.has(a)) adj.set(a,[]); adj.get(a).push({to:b,meta}); if (!adj.has(b)) adj.set(b,[]); adj.get(b).push({to:a,meta}); }
      resistors.forEach((r,idx)=> addAdj(r.n1, r.n2, { type:'resistor', idx, meta:r }));
      diodes.forEach((d,idx)=> addAdj(d.n1, d.n2, { type:'led', idx, meta:d }));

      // helper BFS to produce a path (list of nets) and the edge meta between them
      function findPath(start, end){
        if (start==null || end==null) return null;
        const q = [start];
        const prev = new Map(); prev.set(start, null);
        const prevEdge = new Map();
        while(q.length){ const cur = q.shift(); if (cur === end) break; const list = adj.get(cur)||[]; for (const e of list){ const to = e.to; if (prev.has(to)) continue; prev.set(to, cur); prevEdge.set(to, e.meta); q.push(to); } }
        if (!prev.has(end)) return null;
        const nets = []; const edges = [];
        let cur = end; while(cur!=null){ nets.unshift(cur); const ed = prevEdge.get(cur); edges.unshift(ed||null); cur = prev.get(cur); }
        // edges aligned so that edges[i] is the edge used to enter nets[i]
        return { nets, edges };
      }

      const resistorResults = [];
      const diodeResults = [];

      // For each voltage source, try to find a path and estimate current along it
      vSources.forEach(vs => {
        if (vs.nPlus==null || vs.nMinus==null) return;
        const p = findPath(vs.nPlus, vs.nMinus);
        if (!p || !p.nets || p.nets.length < 2) return;
        // compute series resistance for resistor edges along path
        let Rsum = 0; for (let i=1;i<p.nets.length;i++){ const edge = p.edges[i]; if (!edge) continue; if (edge.type==='resistor') Rsum += Number(edge.meta.R||edge.meta.meta?.R||0); }
        // if Rsum zero, use conservative default to avoid infinite current
        if (Rsum <= 0) Rsum = 100; // ohms
        const I = Math.abs(Number(vs.V || 0)) / Rsum;
        // traverse path assigning voltage drops
        let nodeVoltages = []; nodeVoltages[0] = Number(vs.V||0);
        for (let i=1;i<p.nets.length;i++){
          const edge = p.edges[i]; if (!edge){ nodeVoltages[i] = nodeVoltages[i-1]; continue; }
          if (edge.type==='resistor'){
            const R = Number(edge.meta.R||edge.meta.meta?.R||0);
            const Vdrop = I*R; nodeVoltages[i] = nodeVoltages[i-1] - Vdrop;
            // annotate corresponding resistor result
            resistorResults.push({ meta: edge.meta.meta || edge.meta, idx: edge.meta.idx, I, Vdrop });
          } else if (edge.type==='led'){
            const dmeta = edge.meta.meta || edge.meta;
            // check orientation: if we traversed from n1->n2 as stored in dmeta (n1==p.nets[i-1], n2==p.nets[i]) then forward
            const forward = (dmeta.n1 === p.nets[i-1] && dmeta.n2 === p.nets[i]);
            const Vf = Number(dmeta.Vf || dmeta.block?.dataset?.forwardVoltage || 2);
            // estimate diode drop: if nodeVoltages[i-1] - (I*0) >= Vf mark as forward and set drop to Vf, otherwise block
            const Vavailable = nodeVoltages[i-1];
            if (Vavailable >= Vf){ const Vd = Vf; nodeVoltages[i] = nodeVoltages[i-1] - Vd; diodeResults.push({ meta: dmeta, idx: edge.meta.idx, I, Vd, forward }); }
            else { // diode not forward, zero current through this path
              diodeResults.push({ meta: dmeta, idx: edge.meta.idx, I:0, Vd:0, forward:false });
              // this path effectively open-circuited; set I to 0 and break
              // Replace previous resistor annotations for this path to zero current
              for (let k=0;k<resistorResults.length;k++){ if (resistorResults[k] && resistorResults[k].meta && p.nets.includes(resistorResults[k].meta.n1) && p.nets.includes(resistorResults[k].meta.n2)) resistorResults[k].I = 0; }
              return; // stop processing this source
            }
          } else { nodeVoltages[i] = nodeVoltages[i-1]; }
        }
      });

      // deduplicate resistorResults by meta.block and aggregate last seen if multiple sources
      const rrMap = new Map(); resistorResults.forEach(r => { const key = r.meta.block ? r.meta.block.dataset.id : `${r.meta.n1}_${r.meta.n2}`; rrMap.set(key, r); });
      const finalRes = Array.from(rrMap.values()).map(r=>({ meta: r.meta, idx: r.idx, I: r.I, Vdrop: r.Vdrop }));

      const drMap = new Map(); diodeResults.forEach(d => { const key = d.meta.block ? d.meta.block.dataset.id : `${d.meta.n1}_${d.meta.n2}`; drMap.set(key, d); });
      const finalDiodes = Array.from(drMap.values()).map(d=>({ meta: d.meta, idx: d.idx, I: d.I, Vd: d.Vd, forward: d.forward }));

      return { success:true, resistorResults: finalRes, diodeResults: finalDiodes };
    } catch(e){ console.error('SimpleSolver simulate error', e); return { success:false, reason: 'exception' }; }
  }

  return { simulate };
})();
