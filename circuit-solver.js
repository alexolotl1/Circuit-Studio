// Minimal CircuitSolver library
// Provides solveMNA(N, resistors, vSources, diodes)
// resistors: [{n1,n2,R}]
// vSources: [{nPlus,nMinus,V}]
// diodes: [{n1,n2,Is,nVt,Vf}]
(function(global){
  const CircuitSolver = {
    solveMNA: function(N, resistors, vSources, diodes, opts={}){
      // opts: maxIter, tol, damping
      const maxIter = opts.maxIter || 50;
      const tol = opts.tol || 1e-6;
      const damping = (opts.damping==null)?0.6:opts.damping;
      const M = vSources.length;

      function solveLinear(Ain, zin){
        const n = Ain.length;
        const A = Array.from({length:n}, (_,i)=>Array.from(Ain[i]));
        const z = Array.from(zin);
        for (let i=0;i<n;i++){
          let maxRow=i; let maxVal=Math.abs(A[i][i]);
          for (let r=i+1;r<n;r++){ const v=Math.abs(A[r][i]); if (v>maxVal){ maxVal=v; maxRow=r; } }
          if (maxVal < 1e-18) throw new Error('Singular matrix');
          if (maxRow!==i){ const tmp=A[i]; A[i]=A[maxRow]; A[maxRow]=tmp; const tz=z[i]; z[i]=z[maxRow]; z[maxRow]=tz; }
          const pivot = A[i][i];
          for (let r=i+1;r<n;r++){
            const factor = A[r][i] / pivot;
            if (!isFinite(factor)) continue;
            for (let c=i;c<n;c++) A[r][c] -= factor * A[i][c];
            z[r] -= factor * z[i];
          }
        }
        const x = Array(n).fill(0);
        for (let i=n-1;i>=0;i--){ let s=z[i]; for (let j=i+1;j<n;j++) s -= A[i][j]*x[j]; x[i]=s/A[i][i]; }
        return x;
      }

      // initial guess
      let Vguess = Array(N).fill(0);
      let x=null;
      for (let iter=0; iter<maxIter; iter++){
        // build conductance matrix and RHS
        const G = Array.from({length:N},()=>Array(N).fill(0));
        const I = Array(N).fill(0);
        // resistors
        resistors.forEach(r=>{
          if (r.n1==null || r.n2==null) return;
          const g = 1/(r.R||1e-12);
          if (r.n1 !== r.n2){ G[r.n1][r.n1]+=g; G[r.n2][r.n2]+=g; G[r.n1][r.n2]-=g; G[r.n2][r.n1]-=g; }
          else G[r.n1][r.n1]+=g;
        });
        // diodes linearization
        diodes.forEach(d=>{
          if (d.n1==null || d.n2==null) return;
          const v1 = Vguess[d.n1]||0; const v2 = Vguess[d.n2]||0; const Vd = v1 - v2;
          const Is = (d.Is==null)?1e-12:d.Is; const nVt = (d.nVt==null)?0.026:d.nVt;
          const Icalc = Is * (Math.exp(Vd / nVt) - 1);
          const Gd = (Is / nVt) * Math.exp(Vd / nVt);
          const Ieq = Icalc - Gd * Vd;
          if (d.n1 !== d.n2){ G[d.n1][d.n1]+=Gd; G[d.n2][d.n2]+=Gd; G[d.n1][d.n2]-=Gd; G[d.n2][d.n1]-=Gd; I[d.n1] -= Ieq; I[d.n2] += Ieq; }
          else { G[d.n1][d.n1]+=Gd; I[d.n1] -= Ieq; }
        });

        // voltage sources
        const B = Array.from({length:N},()=>Array(M).fill(0));
        const E = vSources.map(v=>v.V||0);
        vSources.forEach((vs,j)=>{ if (vs.nPlus!=null) B[vs.nPlus][j]=1; if (vs.nMinus!=null) B[vs.nMinus][j]=-1; });

        const dim = N + M; const A = Array.from({length:dim},()=>Array(dim).fill(0)); const z = Array(dim).fill(0);
        for (let i=0;i<N;i++) for (let j=0;j<N;j++) A[i][j]=G[i][j];
        for (let i=0;i<N;i++) for (let j=0;j<M;j++) A[i][N+j]=B[i][j];
        for (let i=0;i<M;i++) for (let j=0;j<N;j++) A[N+i][j]=B[j][i];
        for (let i=0;i<N;i++) z[i]=I[i];
        for (let i=0;i<M;i++) z[N+i]=E[i];

        try { x = solveLinear(A,z); } catch(e){ return { success:false, reason:'linear-solve-failed' }; }
        const Vnew = x.slice(0,N);
        // damping update for next iteration
        let maxDiff = 0;
        for (let i=0;i<N;i++){ const vOld = Vguess[i]||0; const vN = Vnew[i]||0; const vUpd = damping * vN + (1-damping) * vOld; maxDiff = Math.max(maxDiff, Math.abs(vUpd - vOld)); Vguess[i]=vUpd; }
        if (maxDiff < tol) break;
      }

      if (!x) return { success:false };
      const V = x.slice(0,N); const J = x.slice(N);
      // compute branch currents
      const resistorResults = resistors.map(r=>{ if (r.n1==null || r.n2==null) return {I:0}; const v1=V[r.n1]||0; const v2=V[r.n2]||0; const I=(v1-v2)/(r.R||1e-12); return {I, v1, v2}; });
      const diodeResults = diodes.map(d=>{ if (d.n1==null || d.n2==null) return {I:0}; const v1=V[d.n1]||0; const v2=V[d.n2]||0; const Vd=v1-v2; const Is=(d.Is==null)?1e-12:d.Is; const Icalc = Is*(Math.exp(Vd/(d.nVt||0.026))-1); return {I:Icalc, Vd}; });
      return { success:true, V, J, resistorResults, diodeResults };
    }
  };
  global.CircuitSolver = CircuitSolver;
})(window);
