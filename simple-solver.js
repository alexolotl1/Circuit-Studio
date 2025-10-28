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
      if (current === end) {
        // Only add path if it contains useful components (resistor/LED) to avoid trivial paths
        if (edges.some(e => e && (e.type === 'resistor' || e.type === 'led'))) {
          paths.push({nets: [...path], edges: [...edges]});
        }
        return;
      }
      
      const neighbors = adj.get(current) || [];
      for (const {to, meta} of neighbors) {
        // Allow revisiting nodes to find parallel paths, but prevent immediate cycles
        if (visited.has(to) && path[path.length - 2] === to) continue;
        if (excludeBattery && meta && meta.type === 'battery' && meta.meta === excludeBattery) continue;
        
        // Track visited to prevent infinite loops, but allow parallel paths
        if (path.filter(n => n === to).length < 2) {
          visited.add(to);
          path.push(to);
          edges.push(meta);
          dfs(to, path, edges);
          edges.pop();
          path.pop();
          visited.delete(to);
        }
      }
    }
    
    visited.add(start);
    dfs(start, [start], [null]);
    return paths;
  }

  function simulate(model) {
    try {
      if (!model) return { success: false, reason: 'no-model' };
      const { netMap, resistors, vSources, diodes } = model;
      
      // Build adjacency on nets using resistors, diodes and batteries
      const adj = new Map();
      function addAdj(a, b, meta) { 
        if (a == null || b == null) return; 
        if (!adj.has(a)) adj.set(a, []); 
        adj.get(a).push({to: b, meta}); 
        if (!adj.has(b)) adj.set(b, []); 
        adj.get(b).push({to: a, meta}); 
      }
      
      resistors.forEach((r, idx) => addAdj(r.n1, r.n2, { type: 'resistor', idx, meta: r }));
      diodes.forEach((d, idx) => addAdj(d.n1, d.n2, { type: 'led', idx, meta: d }));
      vSources.forEach((v, idx) => addAdj(v.nPlus, v.nMinus, { type: 'battery', idx, meta: v }));

      const resistorResults = [];
      const diodeResults = [];

      // Find all possible paths for each voltage source
      vSources.forEach(vs => {
        if (vs.nPlus == null || vs.nMinus == null) return;
        
        // Get all paths from battery positive to negative
        const paths = findAllPaths(vs.nPlus, vs.nMinus, vs, adj);
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
            const resistorMatches = matches.filter(m => m && m.type === 'resistor');
            if (resistorMatches.length === 1) {
              Rsum += Number(resistorMatches[0].meta.R || 0);
            } else if (resistorMatches.length > 1) {
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
            const resistorMatches = matches.filter(m => m && m.type === 'resistor');

            if (resistorMatches.length) {
              let Vdrop = 0;
              if (resistorMatches.length === 1) {
                const R = Number(resistorMatches[0].meta.R || 0);
                Vdrop = I * R;
                resistorResults.push({
                  meta: resistorMatches[0].meta,
                  idx: resistorMatches[0].idx,
                  I,
                  Vdrop
                });
              } else {
                let Gsum = 0;
                resistorMatches.forEach(rm => {
                  const Rv = Number(rm.meta.R || 0) || 1e-12;
                  Gsum += 1 / Rv;
                });
                const Req = (Gsum > 0) ? (1 / Gsum) : 0;
                Vdrop = I * Req;
                resistorMatches.forEach(rm => {
                  const Rv = Number(rm.meta.R || 0) || 1e-12;
                  resistorResults.push({
                    meta: rm.meta,
                    idx: rm.idx,
                    I: I * (1 / Rv) / Gsum,
                    Vdrop: Vdrop * (1 / Rv) / Gsum
                  });
                });
              }
              nodeVoltages[i+1] = nodeVoltages[i] - Vdrop;
              continue;
            }

            const diodeMatches = matches.filter(m => m && m.type === 'led');
            if (diodeMatches.length) {
              const candidates = diodeMatches.filter(dm => dm.meta && (
                (dm.meta.n1 === prevNet && dm.meta.n2 === curNet) ||
                (dm.meta.n1 === curNet && dm.meta.n2 === prevNet)
              ));
              const Vavailable = nodeVoltages[i];
              if (candidates.length) {
                const forwardOriented = candidates.filter(dm =>
                  dm.meta.n1 === prevNet && dm.meta.n2 === curNet
                );
                const used = forwardOriented.length ? forwardOriented : candidates;
                const Vf = Number(
                  (used[0] && used[0].meta.Vf) ||
                  (diodeMatches[0] && diodeMatches[0].meta.block &&
                   diodeMatches[0].meta.block.dataset &&
                   diodeMatches[0].meta.block.dataset.forwardVoltage) ||
                  2
                );

                if (Vavailable >= Vf) {
                  const Iper = I / used.length;
                  used.forEach(dm => {
                    diodeResults.push({
                      meta: dm.meta,
                      idx: dm.idx,
                      I: Iper,
                      Vd: Vf,
                      forward: true
                    });
                  });

                  diodeMatches
                    .filter(dm => !used.includes(dm))
                    .forEach(dm => {
                      diodeResults.push({
                        meta: dm.meta,
                        idx: dm.idx,
                        I: 0,
                        Vd: 0,
                        forward: false
                      });
                    });
                  nodeVoltages[i+1] = nodeVoltages[i] - Vf;
                  continue;
                } else {
                  diodeMatches.forEach(dm => {
                    diodeResults.push({
                      meta: dm.meta,
                      idx: dm.idx,
                      I: 0,
                      Vd: 0,
                      forward: false
                    });
                  });
                  for (let k = 0; k < resistorResults.length; k++) {
                    if (resistorResults[k]) resistorResults[k].I = 0;
                  }
                  return;
                }
              }
            }

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

      return {
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
    } catch(e) {
      console.error('SimpleSolver simulate error', e);
      return { success: false, reason: 'exception' };
    }
  }

  return { simulate };
})();