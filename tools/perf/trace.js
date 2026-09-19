const fs=require("fs"),path=require("path");const root=path.join(__dirname,"..","..");
const lines=fs.readFileSync(path.join(root,"data","experiments","selfplay-data.merged-engine-16cards-local-2026-09-15.jsonl"),"utf8").split("\n").filter(Boolean);
const rec=JSON.parse(lines[+process.argv[2]||10092]);const out={};
for(const [nm,e] of [["orig",require("./engine-orig.js")],["new",require(path.join(root,process.env.ENG||"engine-merged.js"))]]){
 const s=e.cloneState({});s.board=rec.board.map(r=>r.map(p=>p?{type:p.t,color:p.c,moved:true}:null));s.mode="play";s.turn=rec.turn;
 s.deckSlots={white:rec.deckSlots?.white||[],black:rec.deckSlots?.black||[]};s.captures={white:[],black:[]};s.aiSearchNoCards=true;e.setWorkerBoardDimensions(s);
 const log=[];const a=e.generateActions(s,rec.turn);
 const r=e.searchBestAction(s,a,rec.turn,2,60000,{evalFn:(st,c)=>{const v=e.evaluateState(st,c);if(log.length===1)console.log(nm,JSON.stringify(e.evaluateStateComponents(st,c)));log.push(JSON.stringify(st.board.map(r=>r.map(p=>p?p.type[0]+p.color[0]:"."))).length+":"+JSON.stringify(st.board)+"|"+c+"|"+v);return v;}});
 out[nm]=log;console.log(nm,r.nodes,r.score,log.length);}
const A=out.orig,B=out.new;let i=0;while(i<A.length&&A[i]===B[i])i++;console.log("first diff at",i);if(i<A.length){console.log(A[i].slice(-200));console.log(B[i]&&B[i].slice(-200));}
