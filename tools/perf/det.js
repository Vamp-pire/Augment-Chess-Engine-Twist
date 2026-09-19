const fs=require("fs"),path=require("path");const root=path.join(__dirname,"..","..");
const lines=fs.readFileSync(path.join(root,"selfplay-data.merged-engine-16cards-local-2026-09-15.jsonl"),"utf8").split("\n").filter(Boolean);
for(const idx of [6380]){const rec=JSON.parse(lines[idx]);
for(const [nm,e] of [["orig",require("./engine-orig.js")],["new",require(path.join(root,process.env.ENG||"engine-merged.js"))]]){const out=[];
for(let k=0;k<5;k++){const s=e.cloneState({});s.board=rec.board.map(r=>r.map(p=>p?{type:p.t,color:p.c,moved:true}:null));s.mode="play";s.turn=rec.turn;
 s.deckSlots={white:rec.deckSlots?.white||[],black:rec.deckSlots?.black||[]};s.captures={white:[],black:[]};s.aiSearchNoCards=true;e.setWorkerBoardDimensions(s);
 const a=e.generateActions(s,rec.turn);const r=e.searchBestAction(s,a,rec.turn,2,60000);out.push(r.score+"n"+r.nodes+":"+r.action.type+JSON.stringify(r.action.from||"")+JSON.stringify(r.action.move||""));}
console.log(idx,nm,[...new Set(out)].join(" | "));}}
