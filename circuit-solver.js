// Minimal CircuitSolver library
// Provides solveMNA(N, resistors, vSources, diodes)
// resistors: [{n1,n2,R}]
// vSources: [{nPlus,nMinus,V}]
// diodes: [{n1,n2,Is,nVt,Vf}]
(function(global){
  const CircuitSolver = {
    solveMNA: function(numNodes, resistorList, voltageSourceList, diodeList, options={}){
      // ensure arrays are defined
      resistorList = resistorList || [];
      voltageSourceList = voltageSourceList || [];
      diodeList = diodeList || [];
      // options: maxIter, tol, damping
      const maxIter = options.maxIter || 50;
      const tol = options.tol || 1e-6;
      const damping = (options.damping==null)?0.6:options.damping;
      const numVoltageSources = voltageSourceList.length;

      function solveLinear(matrixIn, rhsIn){
        const dim = matrixIn.length;
        if (dim === 0) return [];
        const mat = Array.from({length:dim}, (_,i)=>Array.from(matrixIn[i]));
        const vec = Array.from(rhsIn);
        for (let i=0;i<dim;i++){
          // partial pivoting: find max row in column i
          let maxRow=i; let maxVal=Math.abs(mat[i][i]);
          for (let r=i+1;r<dim;r++){ const v=Math.abs(mat[r][i]); if (v>maxVal){ maxVal=v; maxRow=r; } }
          // if the largest pivot in this column is extremely small, consider matrix singular
          if (maxVal < 1e-18) throw new Error('Singular matrix');
          if (maxRow!==i){ const tmp=mat[i]; mat[i]=mat[maxRow]; mat[maxRow]=tmp; const tv=vec[i]; vec[i]=vec[maxRow]; vec[maxRow]=tv; }
          const pivot = mat[i][i];
          if (!isFinite(pivot) || Math.abs(pivot) < 1e-18) throw new Error('Singular pivot');
          for (let r=i+1;r<dim;r++){
            const factor = mat[r][i] / pivot;
            if (!isFinite(factor)) continue;
            for (let c=i;c<dim;c++) mat[r][c] -= factor * mat[i][c];
            vec[r] -= factor * vec[i];
          }
        }
        const solution = Array(dim).fill(0);
        for (let i=dim-1;i>=0;i--){
          let s=vec[i];
          for (let j=i+1;j<dim;j++) s -= mat[i][j]*solution[j];
          const denom = mat[i][i];
          if (!isFinite(denom) || Math.abs(denom) < 1e-18) throw new Error('Singular pivot during back-substitution');
          solution[i]=s/denom;
        }
        return solution;
      }

      // initial guess
      let voltageGuess = Array(numNodes).fill(0);
      let solutionVector = null;
      for (let iter=0; iter<maxIter; iter++){
        // build conductance matrix and RHS
        const conductance = Array.from({length:numNodes},()=>Array(numNodes).fill(0));
        const currentVec = Array(numNodes).fill(0);
        // resistors
        resistorList.forEach(r=>{
          if (r.n1==null || r.n2==null) return;
          const g = 1/(r.R||1e-12);
          if (r.n1 !== r.n2){ conductance[r.n1][r.n1]+=g; conductance[r.n2][r.n2]+=g; conductance[r.n1][r.n2]-=g; conductance[r.n2][r.n1]-=g; }
          else conductance[r.n1][r.n1]+=g;
        });
        // diodes linearization
        diodeList.forEach(diode=>{
          if (diode.n1==null || diode.n2==null) return;
          const v1 = voltageGuess[diode.n1]||0; const v2 = voltageGuess[diode.n2]||0; const Vd = v1 - v2;
          const Is = (diode.Is==null)?1e-12:diode.Is; const nVt = (diode.nVt==null || diode.nVt===0)?0.026:diode.nVt;
          // clamp diode exponential argument to avoid overflow/underflow
          const diodeExpArg = Math.max(-40, Math.min(40, Vd / nVt));
          const diodeExp = Math.exp(diodeExpArg);
          let diodeIcalc = Is * (diodeExp - 1);
          let diodeG = (Is / nVt) * diodeExp;
          // cap conductance to a large but finite value to avoid ill-conditioning
          const MAX_G = 1e12;
          if (!isFinite(diodeG) || diodeG > MAX_G) diodeG = Math.min(diodeG, MAX_G);
          const diodeIeq = diodeIcalc - diodeG * Vd;
          if (diode.n1 !== diode.n2){ conductance[diode.n1][diode.n1]+=diodeG; conductance[diode.n2][diode.n2]+=diodeG; conductance[diode.n1][diode.n2]-=diodeG; conductance[diode.n2][diode.n1]-=diodeG; currentVec[diode.n1] -= diodeIeq; currentVec[diode.n2] += diodeIeq; }
          else { conductance[diode.n1][diode.n1]+=diodeG; currentVec[diode.n1] -= diodeIeq; }
        });

        // voltage sources
        const Bmatrix = Array.from({length:numNodes},()=>Array(numVoltageSources).fill(0));
        const Evector = voltageSourceList.map(v=>v.V||0);
        voltageSourceList.forEach((vs,j)=>{ if (vs.nPlus!=null) Bmatrix[vs.nPlus][j]=1; if (vs.nMinus!=null) Bmatrix[vs.nMinus][j]=-1; });

        const totalDim = numNodes + numVoltageSources; const A = Array.from({length:totalDim},()=>Array(totalDim).fill(0)); const z = Array(totalDim).fill(0);
        for (let i=0;i<numNodes;i++) for (let j=0;j<numNodes;j++) A[i][j]=conductance[i][j];
        for (let i=0;i<numNodes;i++) for (let j=0;j<numVoltageSources;j++) A[i][numNodes+j]=Bmatrix[i][j];
        for (let i=0;i<numVoltageSources;i++) for (let j=0;j<numNodes;j++) A[numNodes+i][j]=Bmatrix[j][i];
        for (let i=0;i<numNodes;i++) z[i]=currentVec[i];
        for (let i=0;i<numVoltageSources;i++) z[numNodes+i]=Evector[i];

        try { solutionVector = solveLinear(A,z); } catch(e){ return { success:false, reason:'linear-solve-failed' }; }
        const newVoltages = solutionVector.slice(0,numNodes);
        // damping update for next iteration
        let maxDiff = 0;
        for (let i=0;i<numNodes;i++){ const vOld = voltageGuess[i]||0; const vN = newVoltages[i]||0; const vUpd = damping * vN + (1-damping) * vOld; maxDiff = Math.max(maxDiff, Math.abs(vUpd - vOld)); voltageGuess[i]=vUpd; }
        if (maxDiff < tol) break;
      }

      if (!solutionVector) return { success:false };
      const nodeVoltages = solutionVector.slice(0,numNodes); const sourceCurrents = solutionVector.slice(numNodes);
      // compute branch currents
      const resistorResults = resistorList.map(r=>{ if (r.n1==null || r.n2==null) return {I:0}; const v1=nodeVoltages[r.n1]||0; const v2=nodeVoltages[r.n2]||0; const I=(v1-v2)/(r.R||1e-12); return {I, v1, v2}; });
      const diodeResults = diodeList.map(d=>{ if (d.n1==null || d.n2==null) return {I:0}; const v1=nodeVoltages[d.n1]||0; const v2=nodeVoltages[d.n2]||0; const Vd=v1-v2; const Is=(d.Is==null)?1e-12:d.Is; const Icalc = Is*(Math.exp(Vd/(d.nVt||0.026))-1); return {I:Icalc, Vd}; });
      return { success:true, V: nodeVoltages, J: sourceCurrents, resistorResults, diodeResults };
    }
  };
  global.CircuitSolver = CircuitSolver;
})(window);
