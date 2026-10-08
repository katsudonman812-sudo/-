// 動作確認用: ボット2人(人間役)+CPUで通信込みの対戦を繰り返す
const B='http://localhost:'+(process.env.PORT||3111);
const post=async(p,b)=>(await fetch(B+'/api/'+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})).json();
async function bot(name,sess,onView){
  const res=await fetch(`${B}/api/events?room=${sess.room}&pid=${sess.pid}&token=${sess.token}`);
  const rd=res.body.getReader(),dec=new TextDecoder();let buf='';
  (async()=>{for(;;){const{value,done}=await rd.read();if(done)break;buf+=dec.decode(value);let i;
    while((i=buf.indexOf('\n\n'))>=0){const ch=buf.slice(0,i);buf=buf.slice(i+2);const m=ch.match(/^data: (.*)$/m);if(m)onView(JSON.parse(m[1]))}}})();
}
(async()=>{
  const a=await post('create',{name:'A'}),b=await post('join',{room:a.room,name:'B'});
  let leak=0,games=0,errors=0,last=null,starts=0;
  const play=(s,isA)=>v=>{
    last=v;
    if(v.P)for(let i=0;i<v.P.length;i++)if(i!=v.mi&&v.hand&&v.P[i].hand)leak++; // 他人の手札が含まれていないか
    if(v.pr&&v.pr.p==v.mi&&v.pr.opts!==undefined){const len=v.pr.opts?v.pr.opts.length:v.P[v.pr.from].n;
      post('act',{room:s.room,pid:s.pid,token:s.token,type:'choose',n:v.pr.n,v:Math.random()*len|0})}
    if(v.ph=='over'&&isA&&!v._d){v._d=1;games++;
      if(games<25)setTimeout(()=>post('act',{room:s.room,pid:s.pid,token:s.token,type:'start'}),50)
      else{console.log('games finished:',games,'leak:',leak);process.exit(0)}}
  };
  bot('A',a,play(a,true));bot('B',b,play(b,false));
  await new Promise(r=>setTimeout(r,300));
  await post('act',{room:a.room,pid:a.pid,token:a.token,type:'start'});
  setTimeout(()=>{console.log('TIMEOUT games',games,last&&last.ph,last&&last.msg);process.exit(1)},90000);
})();
