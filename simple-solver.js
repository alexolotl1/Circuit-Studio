// Simple, naive path-based circuit solver for teaching/demo purposes.
// It intentionally avoids matrix math and uses path finding / Ohm's law on series paths
// to estimate currents and voltages. This is best-effort and not a full circuit solver.

window.SimpleSolver = (function() {
  'use strict';

  function findAllPaths(start, end, excludeBattery, adj, maxPaths = 20) {
    if (start == null || end == null) return [];
    const paths = [];
    const visited = new Set();
    
    function dfs(current, path, edges) {
      if (paths.length >= maxPaths) return;
      
      // Found a path to end node
      if (current === end) {
        // Add path if it has at least one component and isn't just the battery
        const hasComponent = edges.some(e => e && (e.type === 'resistor' || e.type === 'led'));
        const isNotJustBattery = path.length > 2 || hasComponent;
        if (isNotJustBattery) {
          paths.push({nets: [...path], edges: [...edges]});
        }
        return;
      }
      
      const neighbors = adj.get(current) || [];
      for (const {to, meta} of neighbors) {
        // Skip the excluding battery to prevent direct short
        if (excludeBattery && meta && meta.type === 'battery' && meta.meta === excludeBattery) continue;
        
        // Allow a node to be visited twice (for parallel paths) but not more
        const visitsToNode = path.filter(n => n === to).length;
        if (visitsToNode >= 2) continue;
        
        // Prevent immediate backtracking unless it's through a component
        const isBacktrack = path.length >= 2 && to === path[path.length - 2];
        if (isBacktrack && (!meta || meta.type === 'wire')) continue;
        
        visited.add(to);
        path.push(to);
        edges.push(meta);
        dfs(to, path, edges);
        edges.pop();
        path.pop();
        visited.delete(to);
      }
    }
    
    visited.add(start);
    dfs(start, [start], [null]);
    return paths;
  }

  function simulate(model) {
    try {
      if (!model) return { success: false, reason: 'no-model' };
      const { netMap, resistors, vSources } = model;  // We don't use diodes array - LEDs are in resistors with meta.type='led'
      
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
        if (!adj.has(a)) adj.set(a, []); 
        adj.get(a).push({to: b, meta}); 
        if (!adj.has(b)) adj.set(b, []); 
        adj.get(b).push({to: a, meta}); 
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

      // Find all possible paths for each voltage source
      vSources.forEach(vs => {
        if (vs.nPlus == null || vs.nMinus == null) return;
        
        // Get all paths from battery positive to negative
        const paths = findAllPaths(vs.nPlus, vs.nMinus, vs, adj);
        if (window.CT_DEBUG) console.debug('SimpleSolver: Found paths:', paths);
        if (!paths || paths.length === 0) return;

        // First accumulate total voltage from all batteries in series
        let totalVoltage = Number(vs.V || 0);
        paths.forEach(path => {
          path.edges.forEach(edge => {
            if (edge && edge.type === 'battery' && edge.meta !== vs) {
              totalVoltage += Number(edge.meta.V || 0);
            }
          });
        });

        // Process each path separately
        paths.forEach(p => {
          if (!p || !p.nets || p.nets.length < 2) return;
          
          if (window.CT_DEBUG) {
            console.debug('SimpleSolver: Processing path:', {
              nets: p.nets,
              edges: p.edges.map(e => e ? {type: e.type, n1: e.meta?.n1, n2: e.meta?.n2} : null)
            });
          }
          
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
              resistorMatches.forEach(rm => {
                const Rv = Number(rm.meta.R || 0) || 1e-12;
                Gsum += 1 / Rv;
              });
              if (Gsum > 0) Rsum += 1 / Gsum;
            }
          });

          // compute net voltage along path
          let Vsum = 0;
          for (let i = 0; i < edgeList.length; i++) {
            const matches = edgeList[i];
            if (!matches) continue;
            const prevNet = p.nets[i];
            const curNet = p.nets[i+1];
            const batteryMatches = matches.filter(m => m && m.type === 'battery');
            batteryMatches.forEach(bm => {
              const bmeta = bm.meta || bm;
              if (bmeta.nPlus === prevNet && bmeta.nMinus === curNet) {
                Vsum -= Number(bmeta.V || 0);
              } else if (bmeta.nPlus === curNet && bmeta.nMinus === prevNet) {
                Vsum += Number(bmeta.V || 0);
              }
            });
          }

          const DEFAULT_R = 10;
          if (Rsum <= 0) Rsum = DEFAULT_R;
          const drivingV = (Math.abs(Vsum) > 1e-12) ? Vsum : (Number(vs.V || 0));
          const I = Math.abs(drivingV) / Rsum;

          let nodeVoltages = [];
          nodeVoltages[0] = Number(Vsum || vs.V || 0);
          
          for (let i = 0; i < edgeList.length; i++) {
            const matches = edgeList[i];
            if (!matches) {
              nodeVoltages[i+1] = nodeVoltages[i];
              continue;
            }

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
                resistorResults.push({
                  meta: componentMatches[0].meta,
                  idx: componentMatches[0].idx,
                  I,
                  Vdrop
                });
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
                  resistorResults.push({
                    meta: rm.meta,
                    idx: rm.idx,
                    I: I * (1 / Rv) / Gsum,
                    Vdrop: baseVdrop
                  });
                });
                
                // Process LEDs with forward voltage
                leds.forEach(led => {
                  const Vf = Number(
                    (led.meta.block && led.meta.block.dataset.forwardVoltage) || 2
                  );
                  resistorResults.push({
                    meta: led.meta,
                    idx: led.idx,
                    I: I / leds.length, // Split current among parallel LEDs
                    Vdrop: Vf
                  });
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