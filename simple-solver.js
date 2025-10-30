// Simple, naive path-based circuit solver for teaching/demo purposes.
// It intentionally avoids matrix math and uses path finding / Ohm's law on series paths
// to estimate currents and voltages. This is best-effort and not a full circuit solver.

window.SimpleSolver = (function() {
  'use strict';

  // Find edge-disjoint BFS paths between start and end in adjacency map
  function findEdgeDisjointPaths(start, end, adjMap, maxPaths = 8) {
    if (start == null || end == null) return [];
    const s = String(start), e = String(end);
    const paths = [];
    const removed = new Set(); // set of meta objects removed (object identity)

    for (let pcount = 0; pcount < maxPaths; pcount++) {
      const q = [s];
      const seen = new Set([s]);
      const prev = new Map();
      let found = false;

      while (q.length && !found) {
        const cur = q.shift();
        const neighbors = adjMap.get(cur) || [];
        for (const nbr of neighbors) {
          const to = nbr.to;
          const via = nbr.meta;
          if (removed.has(via)) continue;
          if (seen.has(to)) continue;
          seen.add(to);
          prev.set(to, { prev: cur, via });
          if (to === e) { found = true; break; }
          q.push(to);
        }
      }

      if (!found) break;

      // Reconstruct path from prev map
      const nets = [];
      const edges = [];
      let node = e;
      while (node !== s) {
        const info = prev.get(node);
        if (!info) break;
        nets.unshift(node);
        edges.unshift(info.via);
        node = info.prev;
      }
      nets.unshift(s);

      paths.push({ nets: nets.slice(), edges: edges.slice() });
      edges.forEach(em => removed.add(em));
    }

    return paths;
  }

  function simulate(model) {
    try {
      if (!model) return { success: false, reason: 'no-model' };
      const { netMap, resistors, vSources } = model; // LEDs are represented in resistors with meta.type='led'

      // First pass: identify logic gate inputs and their voltage states
      const logicStates = new Map(); // Maps net number to voltage state
      const gateOutputs = new Map(); // Maps gate block to output net

      // Helper: can this net reach any battery positive terminal (ignoring R)
      function reachableToVPlus(startNet) {
        if (startNet == null) return false;
        const q = [startNet];
        const seen = new Set([startNet]);
        while (q.length) {
          const cur = q.shift();
          // direct battery plus
          if (vSources.some(vs => vs.nPlus === cur)) return true;
          // traverse any resistor edge
          for (const r of resistors) {
            if (r == null) continue;
            if (r.n1 === cur && r.n2 != null && !seen.has(r.n2)) { seen.add(r.n2); q.push(r.n2); }
            if (r.n2 === cur && r.n1 != null && !seen.has(r.n1)) { seen.add(r.n1); q.push(r.n1); }
          }
        }
        return false;
      }

      // Helper to check if a net is powered
      function isNetPowered(net) {
        if (net == null) return false;
        // Direct connection to voltage source
        if (vSources.some(vs => vs.nPlus === net)) return true;
        // Or reachable via component connectivity to a battery plus
        return reachableToVPlus(net);
      }

      // Process logic gates first. Logic gates are represented as special resistor-like
      // entries (script.js places gate data in resistor.meta.type === 'and'/'or').
      const logicGates = resistors.filter(r => r && r.meta && (r.meta.type === 'and' || r.meta.type === 'or'));
      logicGates.forEach(gate => {
        if (!gate) return;
        const block = gate.block || (gate.meta && gate.meta.block);
        if (!block) return;
        const type = block.dataset.type;

        // input nets are stored on the resistor entry's n1/n2 (script.js uses that convention)
        const input1Net = gate.n1;
        const input2Net = gate.n2;
        // outputNet may be present either at top-level (gate.outputNet) or under meta
        const outputNet = gate.outputNet != null ? gate.outputNet : (gate.meta && gate.meta.outputNet != null ? gate.meta.outputNet : null);

        const input1Powered = isNetPowered(input1Net);
        const input2Powered = isNetPowered(input2Net);

        if (input1Net != null) logicStates.set(input1Net, input1Powered);
        if (input2Net != null) logicStates.set(input2Net, input2Powered);

        let outputPowered = false;
        if (type === 'and') outputPowered = input1Powered && input2Powered;
        else if (type === 'or') outputPowered = input1Powered || input2Powered;

        // If output is powered, add a low-resistance tie from the gate output net to an existing
        // battery positive net so the rest of the solver sees a resistive path (avoids path-skipping).
        if (outputPowered && outputNet != null) {
          // pick a battery plus net if available
          let plusNet = null;
          if (vSources && vSources.length) {
            for (const vs of vSources) { if (vs && vs.nPlus != null) { plusNet = vs.nPlus; break; } }
          }
          // fallback: choose any other net from netMap (not ideal, but ensures connectivity)
          if (plusNet == null && netMap && netMap.size) {
            for (const k of netMap.keys()) { if (k !== outputNet) { plusNet = k; break; } }
          }
          if (plusNet != null) {
            // add a tiny resistor connecting output to plusNet so it behaves like a driven high
            resistors.push({ n1: outputNet, n2: plusNet, R: 1e-3, meta: { type: 'logic-drive', block } });
          }
        }
        // Also update visual dataset on block if available (best-effort)
        try { block.dataset.outputPowered = outputPowered ? 'true' : 'false'; block.classList[outputPowered ? 'add' : 'remove']('powered'); } catch (e) {}
      });

      if (window.CT_DEBUG) {
        console.debug('SimpleSolver: Input model:', {
          nets: netMap ? netMap.size : 0,
          resistors: resistors ? resistors.map(r => ({ n1: r.n1, n2: r.n2, R: r.R, type: r.meta?.type || 'resistor' })) : [],
          vSources: vSources ? vSources.map(v => ({ plus: v.nPlus, minus: v.nMinus, V: v.V })) : [],
          logicStates: Array.from(logicStates.entries())
        });
      }

      // Build adjacency on nets using resistors and batteries
      const adj = new Map();
      function addAdj(a, b, meta) {
        if (a == null || b == null) return;
        const ka = String(a), kb = String(b);
        if (!adj.has(ka)) adj.set(ka, []);
        adj.get(ka).push({ to: kb, meta });
        if (!adj.has(kb)) adj.set(kb, []);
        adj.get(kb).push({ to: ka, meta });
      }

      resistors.forEach((r, idx) => addAdj(r.n1, r.n2, { type: r.meta && r.meta.type === 'led' ? 'led' : 'resistor', idx, meta: r }));
      vSources.forEach((v, idx) => addAdj(v.nPlus, v.nMinus, { type: 'battery', idx, meta: v }));

      const resistorResults = [];
      const diodeResults = [];
      const pathSummaries = [];

      // For each voltage source, find paths and distribute current across them
      vSources.forEach(vs => {
        if (vs.nPlus == null || vs.nMinus == null) return;
        const paths = findEdgeDisjointPaths(vs.nPlus, vs.nMinus, adj, 6);
        if (window.CT_DEBUG) console.debug('SimpleSolver: Found paths:', paths);
        if (!paths || paths.length === 0) return;

        const OPEN_R_THRESHOLD = 1e9;

        // Build pathInfos: edge matches + Rsum for each path
        const pathInfos = [];
        paths.forEach(p => {
          if (!p || !p.nets || p.nets.length < 2) return;
          const Vb = Number(vs.V || 0);

          const edgeList = [];
          for (let i = 1; i < p.nets.length; i++) {
            const a = p.nets[i-1], b = p.nets[i];
            const neighbors = adj.get(a) || [];
            const matches = neighbors.filter(nbr => nbr.to === b).map(nbr => nbr.meta);
            const validMatches = matches.filter(m => !(m && (Number(m.meta && m.meta.R || 0) > OPEN_R_THRESHOLD)));
            edgeList.push(validMatches.length ? validMatches : null);
          }

          // If a segment has no matches (only wires/sources), synthesize a tiny resistor
          // so the solver can still compute a current for logic-driven paths.
          const SYNTH_R = 1e-3; // 1 milliohm tie
          for (let si = 0; si < edgeList.length; si++) {
            if (edgeList[si] == null) {
              // create a synthetic resistor meta connecting the two nets in this segment
              const a = p.nets[si];
              const b = p.nets[si+1];
              const fakeMeta = { type: 'resistor', idx: -1, meta: { n1: a, n2: b, R: SYNTH_R } };
              edgeList[si] = [ fakeMeta ];
              if (window && window.CT_DEBUG) {
                try { console.debug('SimpleSolver: inserted synthetic resistor for open segment', { a, b, SYNTH_R }); } catch(e){}
              }
            }
          }

          let Rsum = 0;
          let compCount = 0;
          edgeList.forEach(matches => {
            if (!matches) return;
            const componentMatches = matches.filter(m => m && (m.type === 'resistor' || m.type === 'led'));
            if (componentMatches.length === 1) {
              compCount += 1;
              const isLED = componentMatches[0].type === 'led';
              Rsum += isLED ? 10 : Number(componentMatches[0].meta.R || 0);
            } else if (componentMatches.length > 1) {
              compCount += componentMatches.length;
              let Gsum = 0;
              const regularResistors = componentMatches.filter(m => m.type === 'resistor');
              regularResistors.forEach(rm => { const Rv = Number(rm.meta.R || 0) || 1e-12; Gsum += 1 / Rv; });
              const Req = (Gsum > 0) ? (1 / Gsum) : 0;
              Rsum += Req;
            }
          });

          // If the path contains no resistive components (only wires or sources), skip it
          if (compCount === 0) {
            if (window && window.CT_DEBUG) {
              try { console.debug('SimpleSolver: skipping path with no resistive components', { nets: p.nets.slice(), edgeList }); } catch(e){}
            }
            return;
          }

          if (Rsum <= 0 || !isFinite(Rsum)) Rsum = 1e-6;
          pathInfos.push({ p, edgeList, Rsum, Vb });
        });

        if (!pathInfos.length) return;

        // Conductance proportional split
        let GsumAll = 0;
        pathInfos.forEach(pi => { pi.G = 1 / pi.Rsum; if (!isFinite(pi.G)) pi.G = 1e12; GsumAll += pi.G; });
        if (GsumAll <= 0) GsumAll = 1e-12;

        pathInfos.forEach((pi, pidx) => {
          const p = pi.p;
          const edgeList = pi.edgeList;
          const Vb = pi.Vb;
          const I = (Vb * (pi.G / GsumAll));

          // Debug: report which path index, Rsum and assigned I
          if (window && window.CT_DEBUG) {
            try { console.debug('SimpleSolver: path start', { pathIndex: pidx, Rsum: Number(pi.Rsum), assignedI: Number(I), Vb: Number(Vb) }); } catch(e){}
          }

          pathSummaries.push({ nets: p.nets.slice(), edgeList: edgeList.map(matches => matches ? matches.map(m => ({ type: m.type, idx: m.idx })) : null), Rsum: pi.Rsum, I });

          const seenInPath = new Set();
          const nodeVoltages = [];
          nodeVoltages[0] = Vb;

          for (let i = 0; i < edgeList.length; i++) {
            const matches = edgeList[i];
            if (!matches) continue;
            const componentMatches = matches.filter(m => m && (m.type === 'resistor' || m.type === 'led'));

            if (componentMatches.length) {
              let Vdrop = 0;
                  if (componentMatches.length === 1) {
                const component = componentMatches[0];
                const key = component.meta && component.meta.block ? component.meta.block.dataset.id : `${component.meta && component.meta.n1}_${component.meta && component.meta.n2}`;
                if (!seenInPath.has(key)) {
                  seenInPath.add(key);
                  const isLED = component.type === 'led';
                  if (isLED) {
                    const Vf = Number((component.meta.block && component.meta.block.dataset.forwardVoltage) || 2);
                    Vdrop = Vf;
                  } else {
                    const R = Number(component.meta.R || 0);
                    Vdrop = I * R;
                  }
                  let Vdval = Number(Vdrop.toFixed ? Vdrop.toFixed(6) : Vdrop);
                  if (Math.abs(Vdval) < 1e-6) Vdval = 0;
                  // Debug: log I / component info before pushing result
                      if (window && window.CT_DEBUG) {
                        try {
                          console.debug('SimpleSolver: pushing single-component result', { pathIndex: pidx, pathRsum: Number(pi.Rsum), pathI: Number(I), componentMeta: component.meta, idx: component.idx, computedVdrop: Number(Vdval) });
                        } catch (e) {}
                      }
                      resistorResults.push({ meta: componentMatches[0].meta, idx: componentMatches[0].idx, I, Vdrop: Vdval });
                      if (window && window.CT_DEBUG) try { console.debug('SimpleSolver: added resistorResult', { block: componentMatches[0].meta && componentMatches[0].meta.block && componentMatches[0].meta.block.dataset && componentMatches[0].meta.block.dataset.id, idx: componentMatches[0].idx, I, Vdrop }); } catch(e){}
                }
              } else {
                let Gsum = 0;
                const regularResistors = componentMatches.filter(m => m.type === 'resistor');
                const leds = componentMatches.filter(m => m.type === 'led');

                regularResistors.forEach(rm => { const Rv = Number(rm.meta.R || 0) || 1e-12; Gsum += 1 / Rv; });
                const Req = (Gsum > 0) ? (1 / Gsum) : 0;
                const baseVdrop = I * Req;

                regularResistors.forEach(rm => {
                  const key = rm.meta && rm.meta.block ? rm.meta.block.dataset.id : `${rm.meta && rm.meta.n1}_${rm.meta && rm.meta.n2}`;
                  if (seenInPath.has(key)) return; seenInPath.add(key);
                  const Rv = Number(rm.meta.R || 0) || 1e-12;
                  const rr = { meta: rm.meta, idx: rm.idx, I: (I * (1 / Rv) / Gsum), Vdrop: Number(baseVdrop.toFixed ? baseVdrop.toFixed(6) : baseVdrop) };
                  if (window && window.CT_DEBUG) {
                    try { console.debug('SimpleSolver: pushing parallel resistor result', { pathIndex: pidx, pathRsum: Number(pi.Rsum), pathI: Number(I), branchR: Number(Rv), computedI: Number(rr.I) }); } catch(e){}
                  }
                  resistorResults.push(rr);
                  if (window && window.CT_DEBUG) try { console.debug('SimpleSolver: added parallel resistorResult', { block: rm.meta && rm.meta.block && rm.meta.block.dataset && rm.meta.block.dataset.id, idx: rm.idx, rr }); } catch(e){}
                });

                leds.forEach(led => {
                  const key = led.meta && led.meta.block ? led.meta.block.dataset.id : `${led.meta && led.meta.n1}_${led.meta && led.meta.n2}`;
                  if (seenInPath.has(key)) return; seenInPath.add(key);
                  const Vf = Number((led.meta.block && led.meta.block.dataset.forwardVoltage) || 2);
                  const rr = { meta: led.meta, idx: led.idx, I: (I / leds.length), Vdrop: Number(Vf.toFixed ? Vf.toFixed(6) : Vf) };
                  if (window && window.CT_DEBUG) {
                    try { console.debug('SimpleSolver: pushing parallel LED result', { pathIndex: pidx, pathRsum: Number(pi.Rsum), pathI: Number(I), ledsCount: leds.length, computedI: Number(rr.I) }); } catch(e){}
                  }
                  resistorResults.push(rr);
                  if (window && window.CT_DEBUG) try { console.debug('SimpleSolver: added parallel LED result', { block: led.meta && led.meta.block && led.meta.block.dataset && led.meta.block.dataset.id, idx: led.idx, rr }); } catch(e){}
                });

                Vdrop = Math.max(baseVdrop, leds.length > 0 ? 2 : 0);
              }
              nodeVoltages[i+1] = nodeVoltages[i] - Vdrop;
              continue;
            }

            nodeVoltages[i+1] = nodeVoltages[i];
          }

          if (window && window.CT_DEBUG) {
            const pathInfo = {
              nets: p.nets.slice(),
              edges: edgeList.map(matches => matches ? matches.map(m => ({ type: m.type, metaSummary: { n1: m.meta && m.meta.n1, n2: m.meta && m.meta.n2, R: m.meta && m.meta.R, V: m.meta && m.meta.V } })) : null),
              Rsum: pi.Rsum,
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

      // Deduplicate results (prefer larger absolute current)
      const rrMap = new Map();
      resistorResults.forEach(r => {
        const key = r.meta && r.meta.block ? r.meta.block.dataset.id : `${r.meta && r.meta.n1}_${r.meta && r.meta.n2}`;
        if (!rrMap.has(key)) rrMap.set(key, r);
        else {
          const existing = rrMap.get(key);
          const ei = Math.abs(existing.I || 0);
          const ni = Math.abs(r.I || 0);
          if (ni > ei) rrMap.set(key, r);
        }
      });

      const drMap = new Map();
      diodeResults.forEach(d => {
        const key = d.meta && d.meta.block ? d.meta.block.dataset.id : `${d.meta && d.meta.n1}_${d.meta && d.meta.n2}`;
        if (!drMap.has(key)) drMap.set(key, d);
        else {
          const existing = drMap.get(key);
          const ei = Math.abs(existing.I || 0);
          const ni = Math.abs(d.I || 0);
          if (ni > ei) drMap.set(key, d);
        }
      });

      const results = {
        success: true,
        resistorResults: Array.from(rrMap.values()).map(r => ({ meta: r.meta, idx: r.idx, I: r.I, Vdrop: r.Vdrop })),
        diodeResults: Array.from(drMap.values()).map(d => ({ meta: d.meta, idx: d.idx, I: d.I, Vd: d.Vd, forward: d.forward }))
      };

      if (window.CT_DEBUG) {
        console.debug('SimpleSolver: Final results:', { resistorResults: results.resistorResults.map(r => ({ n1: r.meta?.n1, n2: r.meta?.n2, I: r.I, Vdrop: r.Vdrop })) });
      }

      return results;
    } catch(e) {
      console.error('SimpleSolver simulate error', e);
      return { success: false, reason: 'exception' };
    }
  }

  return { simulate };
})();
