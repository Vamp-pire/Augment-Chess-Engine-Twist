const fs=require("fs"),path=require("path");const root=path.join(__dirname,"..","..");const e=require(path.join(root,"engine-merged.js"));
const lines=fs.readFileSync(path.join(root,"data","experiments","selfplay-data.merged-engine-16cards-local-2026-09-15.jsonl"),"utf8").split("\n").filter(Boolean);
function mk(rec){const s=e.cloneState({});s.board=rec.board.map(r=>r.map(p=>p?{type:p.t,color:p.c,moved:true}:null));s.mode="play";s.turn=rec.turn;s.deckSlots={white:rec.deckSlots?.white||[],black:rec.deckSlots?.black||[]};s.captures={white:[],black:[]};s.aiSearchNoCards=false;s.turnsTaken={white:10,black:10};s.actionsRemaining=1;s.moveCount=20;s.castlingCanceled={white:true,black:true};e.setWorkerBoardDimensions(s);return s;}
const rec=JSON.parse(lines[3]);const s=mk(rec);const c=rec.turn;
const T=(n,f,k=20)=>{const t=process.hrtime.bigint();for(let i=0;i<k;i++)f();console.log(n,(Number(process.hrtime.bigint()-t)/1e6/k).toFixed(2),"ms");};
let a;T("gen",()=>{a=e.generateActions(s,c)});console.log(a.length);
T("clone",()=>e.cloneState(s));
T("clone+apply",()=>{const n=e.cloneState(s);e.applyAction(n,JSON.parse(JSON.stringify(a[5])),c)});
T("eval",()=>e.evaluateState(s,c));
T("order",()=>a.map(x=>e.actionOrderingScore(x,s,c)));
const n=e.cloneState(s);e.applyAction(n,JSON.parse(JSON.stringify(a[5])),c);
T("safety",()=>e.rootCandidateAllowsImmediateDecisiveReply(n,c),5);
T("decWins",()=>a.forEach(x=>e.actionDecisivelyWins(s,x,c)),3);
