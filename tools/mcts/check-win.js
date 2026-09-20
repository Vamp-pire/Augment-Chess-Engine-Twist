// synthetic: white rook can capture the black king in one move -> MCTS must play it
const fs=require("fs"),path=require("path");const root=path.join(__dirname,"..","..");const e=require(path.join(root,"engine-merged.js"));
const { createMctsSearch } = require("./mcts.js");
const lines=fs.readFileSync(path.join(root,"data","experiments","selfplay-data.merged-engine-16cards-local-2026-09-15.jsonl"),"utf8").split("\n").filter(Boolean);
const rec=JSON.parse(lines[3]);const s=e.cloneState({});
const R=rec.board.length,C=rec.board[0].length;
s.board=rec.board.map(r=>r.map(()=>null));
let wk,bk;rec.board.forEach((r,i)=>r.forEach((p,j)=>{if(p&&p.t==="king"){if(p.c==="white")wk=[i,j];else bk=[i,j];}}));
const P=(t,c)=>({type:t,color:c,moved:true});
s.board[wk[0]][wk[1]]=P("king","white");s.board[bk[0]][bk[1]]=P("king","black");
const rr=bk[0]===0?R-1:0; // rook on the king's column, other end
const rowStep=bk[0]===0?1:1;
s.board[rr===bk[0]?1:rr][bk[1]===wk[1]?(bk[1]+1)%C:bk[1]]=P("rook","white");
s.mode="play";s.turn="white";s.deckSlots={white:[],black:[]};s.captures={white:[],black:[]};s.aiSearchNoCards=false;s.turnsTaken={white:10,black:10};s.actionsRemaining=1;s.moveCount=20;s.castlingCanceled={white:true,black:true};e.setWorkerBoardDimensions(s);
const a=e.generateActions(s,"white");
console.log("king",wk,bk,"actions",a.length,"decisive",a.filter(x=>e.actionDecisivelyWins(s,x,"white")).length);
const r=createMctsSearch({sims:50}).search(s,a,"white",{});
console.log("chosen",JSON.stringify(r.action).slice(0,120),"score",r.score,"wins?",e.actionDecisivelyWins(s,r.action,"white"));
