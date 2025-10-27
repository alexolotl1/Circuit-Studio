// Simple, naive path-based circuit solver for teaching/demo purposes.
// It intentionally avoids matrix math and uses path finding / Ohm's law on series paths
// to estimate currents and voltages. This is best-effort and not a full circuit solver.

window.SimpleSolver = (function(){
  function simulate(model){
    try {
      if (!model) return { success:false, reason:'no-model' };
      const { netMap, resistors, vSources, diodes } = model;
  // Build adjacency on nets using resistors, diodes and batteries (voltage sources included)
      const adj = new Map();
      function addAdj(a,b,meta){ if (a==null||b==null) return; if (!adj.has(a)) adj.set(a,[]); adj.get(a).push({to:b,meta}); if (!adj.has(b)) adj.set(b,[]); adj.get(b).push({to:a,meta}); }
      resistors.forEach((r,idx)=> addAdj(r.n1, r.n2, { type:'resistor', idx, meta:r }));
      diodes.forEach((d,idx)=> addAdj(d.n1, d.n2, { type:'led', idx, meta:d }));
  vSources.forEach((v,idx)=> addAdj(v.nPlus, v.nMinus, { type:'battery', idx, meta: v }));

      // helper BFS to produce a path (list of nets) and the edge meta between them
      // findPath optionally accepts excludeMeta to skip specific edges (useful to avoid
      // picking the trivial battery edge when searching for a battery's external path)
      function findPath(start, end, excludeMeta){
        if (start==null || end==null) return null;
        const q = [start];
        const prev = new Map(); prev.set(start, null);
        const prevEdge = new Map();
        while(q.length){
          const cur = q.shift();
          if (cur === end) break;
          const list = adj.get(cur)||[];
          for (const e of list){
            // if caller asked to exclude a specific battery (edge), skip that edge
            if (excludeMeta && e.meta && e.meta.type === 'battery' && e.meta.meta === excludeMeta) continue;
            const to = e.to; if (prev.has(to)) continue; prev.set(to, cur); prevEdge.set(to, e.meta); q.push(to);
          }
        }
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
        // exclude the battery's own edge when searching so we don't pick the trivial direct edge
        const p = findPath(vs.nPlus, vs.nMinus, vs);
        if (!p || !p.nets || p.nets.length < 2) return;
        // Build explicit edge list between consecutive nets so we reliably find the
        // adjacency meta objects (and handle multiple parallel edges).
        const edgeList = [];
        for (let i=1;i<p.nets.length;i++){
          const a = p.nets[i-1], b = p.nets[i];
          const neighbors = adj.get(a) || [];
          // find all adjacency entries that go to b
          const matches = neighbors.filter(nbr => nbr.to === b).map(nbr => nbr.meta);
          // if none found (shouldn't happen), push null
          if (!matches.length) { edgeList.push(null); } else { edgeList.push(matches); }
        }

        // compute series resistance for resistor edges along path using edgeList
        let Rsum = 0;
        edgeList.forEach(matches => {
          if (!matches) return;
          // if multiple parallel edges exist between the same nets, treat resistors by summing their equivalent (parallel) conductance
          const resistorMatches = matches.filter(m => m && m.type === 'resistor');
          if (resistorMatches.length === 1) Rsum += Number(resistorMatches[0].meta.R || 0);
          else if (resistorMatches.length > 1) {
            // parallel resistors: compute equivalent R
            let Gsum = 0; resistorMatches.forEach(rm => { const Rv = Number(rm.meta.R || 0) || 1e-12; Gsum += 1 / Rv; });
            if (Gsum > 0) Rsum += 1 / Gsum; // add equivalent resistance for this segment
          }
        });

        // compute net voltage along path by summing battery edges with sign depending on traversal direction
        let Vsum = 0;
        for (let i=0;i<edgeList.length;i++){
          const matches = edgeList[i]; if (!matches) continue;
          const prevNet = p.nets[i]; const curNet = p.nets[i+1];
          const batteryMatches = matches.filter(m => m && m.type === 'battery');
          batteryMatches.forEach(bm => {
            const bmeta = bm.meta || bm; // bm.meta if wrapper
            // when traversing from prevNet -> curNet, if that traversal goes from
            // the battery's minus->plus (nMinus -> nPlus) it raises the potential
            // in traversal direction, so add +V. If traversal goes from plus->minus
            // it drops the potential, so subtract V.
            if (bmeta.nPlus === prevNet && bmeta.nMinus === curNet) Vsum -= Number(bmeta.V || 0);
            else if (bmeta.nPlus === curNet && bmeta.nMinus === prevNet) Vsum += Number(bmeta.V || 0);
          });
        }
  // if Rsum zero, use conservative default to avoid infinite current
  const DEFAULT_R = 10; // ohms, smaller for more visible currents in teaching mode
  if (Rsum <= 0) Rsum = DEFAULT_R;
  // prefer summed battery voltage (Vsum). If Vsum is zero, fall back to the source's V.
  const drivingV = (Math.abs(Vsum) > 1e-12) ? Vsum : (Number(vs.V || 0));
  const I = Math.abs(drivingV) / Rsum;
  // traverse path assigning voltage drops. Start with the net driving voltage (sum of batteries on path)
  let nodeVoltages = []; nodeVoltages[0] = Number(Vsum || vs.V || 0);
        for (let i=0;i<edgeList.length;i++){
          const matches = edgeList[i]; if (!matches){ nodeVoltages[i+1] = nodeVoltages[i]; continue; }
          const prevNet = p.nets[i]; const curNet = p.nets[i+1];
          // resistors: if multiple resistors across this segment, we already added equivalent R to Rsum
          const resistorMatches = matches.filter(m => m && m.type === 'resistor');
          if (resistorMatches.length){
            // compute equivalent R for this segment
            let Vdrop = 0;
            if (resistorMatches.length === 1){ const R = Number(resistorMatches[0].meta.R || 0); Vdrop = I * R; resistorResults.push({ meta: resistorMatches[0].meta, idx: resistorMatches[0].idx, I, Vdrop }); }
            else { let Gsum=0; resistorMatches.forEach(rm=>{ const Rv = Number(rm.meta.R||0)||1e-12; Gsum += 1/Rv; }); const Req = (Gsum>0)?(1/Gsum):0; Vdrop = I * Req; resistorMatches.forEach(rm=>{ resistorResults.push({ meta: rm.meta, idx: rm.idx, I: I * (1 / (Number(rm.meta.R||0)||1e-12)) / Gsum, Vdrop: Vdrop * ((1 / (Number(rm.meta.R||0)||1e-12)) / Gsum) }); }); }
            nodeVoltages[i+1] = nodeVoltages[i] - Vdrop;
            continue;
          }
          // diodes: there may be multiple parallel diodes between the same nets — consider only those
          // oriented in the traversal direction (n1 -> n2). Non-aligned diodes are reverse and won't conduct.
          const diodeMatches = matches.filter(m => m && m.type === 'led');
          if (diodeMatches.length){
            // Consider diodes whose endpoints match the segment in either direction
            const candidates = diodeMatches.filter(dm => dm.meta && (
              (dm.meta.n1 === prevNet && dm.meta.n2 === curNet) ||
              (dm.meta.n1 === curNet && dm.meta.n2 === prevNet)
            ));
            const Vavailable = nodeVoltages[i];
            if (candidates.length){
              // prefer diodes stored with matching forward orientation; if none, assume stored meta may be inverted and use candidates
              const forwardOriented = candidates.filter(dm => dm.meta.n1 === prevNet && dm.meta.n2 === curNet);
              const used = forwardOriented.length ? forwardOriented : candidates;
              const Vf = Number((used[0] && used[0].meta.Vf) || (diodeMatches[0] && diodeMatches[0].meta.block && diodeMatches[0].meta.block.dataset && diodeMatches[0].meta.block.dataset.forwardVoltage) || 2);
              if (Vavailable >= Vf){
                const Iper = I / used.length;
                used.forEach(dm => { diodeResults.push({ meta: dm.meta, idx: dm.idx, I: Iper, Vd: Vf, forward: true }); });
                // any diodeMatches that weren't used are reverse relative to traversal; report them off
                diodeMatches.filter(dm => !used.includes(dm)).forEach(dm => { diodeResults.push({ meta: dm.meta, idx: dm.idx, I: 0, Vd: 0, forward: false }); });
                nodeVoltages[i+1] = nodeVoltages[i] - Vf;
                continue;
              } else {
                // no conductors
                diodeMatches.forEach(dm => { diodeResults.push({ meta: dm.meta, idx: dm.idx, I: 0, Vd: 0, forward: false }); });
                for (let k=0;k<resistorResults.length;k++){ if (resistorResults[k]) resistorResults[k].I = 0; }
                return;
              }
            }
          }
          // batteries or other edges: no voltage drop in this simple model
          nodeVoltages[i+1] = nodeVoltages[i];
        }
        // Verbose per-path debug when enabled from the main app
        try {
          if (window && window.CT_DEBUG) {
            const pathInfo = { nets: p.nets.slice(), edges: edgeList.map(matches => (matches?matches.map(m=>({type:m.type, metaSummary: { n1: m.meta && m.meta.n1, n2: m.meta && m.meta.n2, R: m.meta && m.meta.R, V: m.meta && m.meta.V } })) : null)), Rsum, Vsum, drivingV: drivingV, I, nodeVoltages };
            console.debug('SimpleSolver: path debug', pathInfo);
          }
        } catch(e) { /* ignore debug errors */ }
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
