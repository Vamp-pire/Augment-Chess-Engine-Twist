// node tools/perf/trace-many.js [N=60] [depth=2] : compare every evaluateStateComponents result seen during searches (old vs new)
const fs=require("fs"),path=require("path");const root=path.join(__dirname,"..","..");
const N=+process.argv[2]||60,D=+process.argv[3]||2,START=+process.argv[4]||0;
const lines=fs.readFileSync(path.join(root,"selfplay-data.merged-engine-16cards-local-2026-09-15.jsonl"),"utf8").split("\n").filter(Boolean);
const engs=[require("./engine-orig.js"),require(path.join(root,process.env.ENG||"engine-merged.js"))];
const step=Math.floor(lines.length/N);let evals=0,bad=0,searchDiff=0;
for(let n=0;n<N;n++){const idx=START+n*step+7;if(idx>=lines.length)break;const rec=JSON.parse(lines[idx]);const logs=[],res=[];
 for(const e of engs){const s=e.cloneState({});s.board=rec.board.map(r=>r.map(p=>p?{type:p.t,color:p.c,moved:true}:null));s.mode="play";s.turn=rec.turn;
  s.deckSlots={white:rec.deckSlots?.white||[],black:rec.deckSlots?.black||[]};s.captures={white:[],black:[]};s.aiSearchNoCards=n%2===0;e.setWorkerBoardDimensions(s);
  const log=[];const t=Date.now();let r;
  try{const a=e.generateActions(s,rec.turn);r=e.searchBestAction(s,a,rec.turn,D,20000,{evalFn:(st,c)=>{log.push(JSON.stringify(e.evaluateStateComponents(st,c)));return e.evaluateState(st,c);}});}catch(x){r={err:x.message}}
  log.slow=Date.now()-t>15000;logs.push(log);res.push(JSON.stringify([r.score,r.nodes]));}
 if(logs[0].slow||logs[1].slow)continue;
 const m=Math.min(logs[0].length,logs[1].length);evals+=m;
 if(logs[0].length!==logs[1].length)searchDiff++;
 for(let i=0;i<m;i++)if(logs[0][i]!==logs[1][i]){bad++;if(bad<4)console.log("EVALDIFF idx",idx,i,logs[0][i].slice(0,250),"\n   ",logs[1][i].slice(0,250));break;}}
console.log(`evals compared ${evals}, mismatching searches ${bad}, eval-count differences ${searchDiff}`);
