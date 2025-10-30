// Simple, naive path-based circuit solver for teaching/demo purposes.
// It intentionally avoids matrix math and uses path finding / Ohm's law on series paths
// to estimate currents and voltages. This is best-effort and not a full circuit solver.

window.SimpleSolver = (function() {
  'use strict';

  function findAllPaths(start, end, excludeBattery, adj, maxPaths = 20) {
    if (start == null || end == null) return [];
    // Use string keys to avoid number/string key mismatches between different callers
    const sKey = String(start);
    const eKey = String(end);
    const paths = [];
    const visited = new Map();  // track visit count per node (string keys)

    function dfs(current, path, edges) {
      if (paths.length >= maxPaths) return;
      
      // Found a path to end node (compare against stringified end key)
      if (current === eKey) {
        // Always consider the path valid if it reaches the end
        // and contains at least one component
        const hasComponent = edges.some(e => e && (e.type === 'resistor' || e.type === 'led'));
        if (hasComponent) {
          paths.push({nets: [...path], edges: [...edges]});
        }
        // Do NOT return here — allow exploration to continue so we can find
        // longer paths that visit the end node after traversing components.
        // Visiting is still controlled by the `visited` counts to avoid loops.
      }
      
      const neighbors = adj.get(current) || [];
      for (const {to, meta} of neighbors) {
        // Initialize visit count if not seen
        if (!visited.has(to)) visited.set(to, 0);
        
        // Allow visiting each node up to twice to handle parallel paths
        if (visited.get(to) >= 2) continue;
        
        // Count this visit
        visited.set(to, visited.get(to) + 1);
        path.push(to);
        edges.push(meta);
        
        dfs(to, path, edges);
        
        // Backtrack
        edges.pop();
        path.pop();
        visited.set(to, visited.get(to) - 1);
      }
    }
    
    // Start visit count for path-finding: use Map#set (visited is a Map of counts)
    visited.set(sKey, 1);
    dfs(sKey, [sKey], [null]);
    return paths;
  }

  function simulate(model) {
    try {
      if (!model) return { success: false, reason: 'no-model' };
      const { netMap, resistors, vSources } = model;  // We don't use diodes array - LEDs are in resistors with meta.type='led'
      
      if (window.CT_DEBUG) {
        console.debug('SimpleSolver: Input model:', {
          nets: netMap ? netMap.size : 0,
          resistors: resistors ? resistors.map(r => ({
            n1: r.n1, 
            n2: r.n2, 
            R: r.R,
            type: r.meta?.type || 'resistor'
          })) : [],
          vSources: vSources ? vSources.map(v => ({
            plus: v.nPlus,
            minus: v.nMinus,
            V: v.V
          })) : []
        });
      }
      
      if (window.CT_DEBUG) {
        console.debug('SimpleSolver: Starting simulation with:', {
          nets: Array.from(netMap.entries()),
          resistors: resistors.map(r => ({n1: r.n1, n2: r.n2, R: r.R})),
          vSources: vSources.map(v => ({plus: v.nPlus, minus: v.nMinus, V: v.V}))
        });
      }
      
      // Build adjacency on nets using resistors, diodes and batteries
      const adj = new Map();
      function addAdj(a, b, meta) { 
        if (a == null || b == null) return; 
        const ka = String(a), kb = String(b);
        if (!adj.has(ka)) adj.set(ka, []); 
        adj.get(ka).push({to: kb, meta}); 
        if (!adj.has(kb)) adj.set(kb, []); 
        adj.get(kb).push({to: ka, meta}); 
      }
      
      // Add all resistors and LEDs to adjacency (LEDs are resistors with meta.type='led')
      resistors.forEach((r, idx) => addAdj(r.n1, r.n2, { 
        type: r.meta && r.meta.type === 'led' ? 'led' : 'resistor',
        idx, 
        meta: r 
      }));
      vSources.forEach((v, idx) => addAdj(v.nPlus, v.nMinus, { type: 'battery', idx, meta: v }));

      const resistorResults = [];
      const diodeResults = [];
  const pathSummaries = [];

      // Find all possible paths for each voltage source
      vSources.forEach(vs => {
        if (vs.nPlus == null || vs.nMinus == null) return;
        
        // Get all paths from battery positive to negative
        const paths = findAllPaths(vs.nPlus, vs.nMinus, vs, adj);
        if (window.CT_DEBUG) console.debug('SimpleSolver: Found paths:', paths);
        if (!paths || paths.length === 0) return;

  // Process each path separately
        paths.forEach(p => {
          if (!p || !p.nets || p.nets.length < 2) return;
          
          if (window.CT_DEBUG) {
            console.debug('SimpleSolver: Processing path:', {
              nets: p.nets,
              edges: p.edges.map(e => e ? {type: e.type, n1: e.meta?.n1, n2: e.meta?.n2} : null)
            });
          }
          
          // Use simple battery voltage for this path
          const Vb = Number(vs.V || 0);
          
          // Build explicit edge list between consecutive nets
          const edgeList = [];
          for (let i = 1; i < p.nets.length; i++) {
            const a = p.nets[i-1], b = p.nets[i];
            const neighbors = adj.get(a) || [];
            // Find all edges between these nets
            const matches = neighbors.filter(nbr => nbr.to === b).map(nbr => nbr.meta);
            if (!matches.length) {
              edgeList.push(null);
            } else {
              edgeList.push(matches);
            }
          }

          // compute series resistance for resistor edges along path
          let Rsum = 0;
          edgeList.forEach(matches => {
            if (!matches) return;
            // Include both resistors and LEDs in component matching
            const componentMatches = matches.filter(m => m && (m.type === 'resistor' || m.type === 'led'));
            if (componentMatches.length === 1) {
              // For LEDs, use a small resistance but account for forward voltage later
              const isLED = componentMatches[0].type === 'led';
              Rsum += isLED ? 10 : Number(componentMatches[0].meta.R || 0);
            } else if (componentMatches.length > 1) {
              let Gsum = 0;
              const regularResistors = componentMatches.filter(m => m.type === 'resistor');
              regularResistors.forEach(rm => {
                const Rv = Number(rm.meta.R || 0) || 1e-12;
                Gsum += 1 / Rv;
              });
              if (Gsum > 0) Rsum += 1 / Gsum;
            }
          });

          const DEFAULT_R = 10;
          if (Rsum <= 0) Rsum = DEFAULT_R;
          
          // Simple current calculation using Ohm's Law
          const Iraw = Math.abs(Vb) / Rsum;
          // Round currents to reasonable precision for display (6 decimal places)
          const I = Number(Iraw.toFixed(6));

          if (window && window.CT_DEBUG) {
            try {
              console.debug('SimpleSolver: path Rsum/I', { Rsum, I });
              console.debug('SimpleSolver: raw edgeList', edgeList.map(matches => matches ? matches.map(m => ({ type: m.type, idx: m.idx, n1: m.meta && m.meta.n1, n2: m.meta && m.meta.n2 })) : null));
            } catch(e) {}
          }

          // record brief summary for diagnostics
          pathSummaries.push({ nets: p.nets.slice(), edgeList: edgeList.map(matches => matches ? matches.map(m => ({ type: m.type, idx: m.idx })) : null), Rsum });

          // Initialize node voltages for this path. nodeVoltages[0] is battery positive.
          const nodeVoltages = [];
          nodeVoltages[0] = Vb;
          // Small debug helpers (keeps older debug output stable)
          const Vsum = Vb;
          const drivingV = Vb;

          // Process components along the path
          for (let i = 0; i < edgeList.length; i++) {
            const matches = edgeList[i];
            if (!matches) continue;

            const prevNet = p.nets[i];
            const curNet = p.nets[i+1];
            const componentMatches = matches.filter(m => m && (m.type === 'resistor' || m.type === 'led'));

            if (componentMatches.length) {
              let Vdrop = 0;
              if (componentMatches.length === 1) {
                const component = componentMatches[0];
                const isLED = component.type === 'led';
                // For LEDs, use forward voltage drop instead of I*R
                if (isLED) {
                  const Vf = Number(
                    (component.meta.block && component.meta.block.dataset.forwardVoltage) || 2
                  );
                  Vdrop = Vf;
                } else {
                  const R = Number(component.meta.R || 0);
                  Vdrop = I * R;
                }
                resistorResults.push({ meta: componentMatches[0].meta, idx: componentMatches[0].idx, I, Vdrop: Number(Vdrop.toFixed ? Vdrop.toFixed(6) : Vdrop) });
                if (window && window.CT_DEBUG) try { console.debug('SimpleSolver: added resistorResult', { block: componentMatches[0].meta && componentMatches[0].meta.block && componentMatches[0].meta.block.dataset && componentMatches[0].meta.block.dataset.id, idx: componentMatches[0].idx, I, Vdrop }); } catch(e){}
              } else {
                // Handle parallel components (both resistors and LEDs)
                let Gsum = 0;
                const regularResistors = componentMatches.filter(m => m.type === 'resistor');
                const leds = componentMatches.filter(m => m.type === 'led');
                
                // Handle parallel resistors
                regularResistors.forEach(rm => {
                  const Rv = Number(rm.meta.R || 0) || 1e-12;
                  Gsum += 1 / Rv;
                });
                
                const Req = (Gsum > 0) ? (1 / Gsum) : 0;
                const baseVdrop = I * Req;
                
                // Process resistors
                regularResistors.forEach(rm => {
                  const Rv = Number(rm.meta.R || 0) || 1e-12;
                  const rr = { meta: rm.meta, idx: rm.idx, I: Number((I * (1 / Rv) / Gsum).toFixed(6)), Vdrop: Number(baseVdrop.toFixed ? baseVdrop.toFixed(6) : baseVdrop) };
                  resistorResults.push(rr);
                  if (window && window.CT_DEBUG) try { console.debug('SimpleSolver: added parallel resistorResult', { block: rm.meta && rm.meta.block && rm.meta.block.dataset && rm.meta.block.dataset.id, idx: rm.idx, rr }); } catch(e){}
                });
                
                // Process LEDs with forward voltage
                leds.forEach(led => {
                  const Vf = Number((led.meta.block && led.meta.block.dataset.forwardVoltage) || 2);
                  const rr = { meta: led.meta, idx: led.idx, I: Number((I / leds.length).toFixed(6)), Vdrop: Number(Vf.toFixed ? Vf.toFixed(6) : Vf) };
                  resistorResults.push(rr);
                  if (window && window.CT_DEBUG) try { console.debug('SimpleSolver: added parallel LED result', { block: led.meta && led.meta.block && led.meta.block.dataset && led.meta.block.dataset.id, idx: led.idx, rr }); } catch(e){}
                });
                
                // Use the larger of the voltage drops
                Vdrop = Math.max(baseVdrop, leds.length > 0 ? 2 : 0);
              }
              nodeVoltages[i+1] = nodeVoltages[i] - Vdrop;
              continue;
            }

            // LEDs are now handled in the component/resistor section above

            nodeVoltages[i+1] = nodeVoltages[i];
          }

          if (window && window.CT_DEBUG) {
            const pathInfo = {
              nets: p.nets.slice(),
              edges: edgeList.map(matches => 
                matches ? matches.map(m => ({
                  type: m.type,
                  metaSummary: {
                    n1: m.meta && m.meta.n1,
                    n2: m.meta && m.meta.n2,
                    R: m.meta && m.meta.R,
                    V: m.meta && m.meta.V
                  }
                })) : null
              ),
              Rsum,
              Vsum,
              drivingV,
              I,
              nodeVoltages
            };
            console.debug('SimpleSolver: path debug', pathInfo);
          }
        });
      });

      // If we found paths but pushed no resistorResults, emit a diagnostic warning so user can see why
      if (resistorResults.length === 0 && pathSummaries.length > 0) {
        try {
          console.warn('SimpleSolver: found paths but no resistorResults were produced. Diagnostics:', { pathSummaries, adjSummary: Array.from(adj.entries()).map(([k,v])=>[k, v.map(x=>({to:x.to, type:x.meta && x.meta.type}))]), resistors, vSources });
        } catch(e) { console.warn('SimpleSolver: diagnostics failed', e); }
      }
      if (window && window.CT_DEBUG) {
        try { console.debug('SimpleSolver: raw resistorResults count', resistorResults.length, resistorResults); } catch(e){}
      }

      // Deduplicate results
      const rrMap = new Map();
      resistorResults.forEach(r => {
        const key = r.meta.block ? r.meta.block.dataset.id : `${r.meta.n1}_${r.meta.n2}`;
        rrMap.set(key, r);
      });

      const drMap = new Map();
      diodeResults.forEach(d => {
        const key = d.meta.block ? d.meta.block.dataset.id : `${d.meta.n1}_${d.meta.n2}`;
        drMap.set(key, d);
      });

      const results = {
        success: true,
        resistorResults: Array.from(rrMap.values()).map(r => ({
          meta: r.meta,
          idx: r.idx,
          I: r.I,
          Vdrop: r.Vdrop
        })),
        diodeResults: Array.from(drMap.values()).map(d => ({
          meta: d.meta,
          idx: d.idx,
          I: d.I,
          Vd: d.Vd,
          forward: d.forward
        }))
      };

      if (window.CT_DEBUG) {
        console.debug('SimpleSolver: Final results:', {
          resistorResults: results.resistorResults.map(r => ({
            n1: r.meta?.n1,
            n2: r.meta?.n2,
            I: r.I,
            Vdrop: r.Vdrop
          }))
        });
      }

      return results;
    } catch(e) {
      console.error('SimpleSolver simulate error', e);
      return { success: false, reason: 'exception' };
    }
  }

  return { simulate };
})();