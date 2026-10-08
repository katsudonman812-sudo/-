'use strict';
// 残業ゲーム サーバー(依存パッケージなし / Node.js 18+)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const T = JSON.parse(fs.readFileSync(path.join(__dirname, 'cards.json'), 'utf8'));
const FILES = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['public/index.html', 'text/html; charset=utf-8'],
  '/cards.json': ['cards.json', 'application/json; charset=utf-8'],
};
const NEED = ['meet', 'kiro', 'boss', 'love', 'newbie', 'bribe'];
const rooms = new Map();
const rnd = n => Math.random() * n | 0;
const SCALE = +process.env.WAIT_SCALE || 1; // テスト用: 演出の待ち時間を縮める(通常は1)
const wait = ms => new Promise(r => setTimeout(r, ms * SCALE));
const shuf = a => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const ord = c => c.j ? 99 : c.t;
const nm = c => c.j ? '😈残業' : T[c.t].e + T[c.t].n;
const clean = s => String(s || '').replace(/[<>&"'`]/g, '').trim().slice(0, 12);

function mkRoom() {
  let code;
  do { code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[rnd(24)]).join(''); } while (rooms.has(code));
  const r = { code, pl: [], S: null, pending: null, pn: 0, last: Date.now() };
  rooms.set(code, r);
  return r;
}
function addPlayer(r, name) {
  const p = { id: crypto.randomBytes(4).toString('hex'), token: crypto.randomBytes(12).toString('hex'), name: clean(name) || 'プレイヤー', res: null };
  r.pl.push(p);
  return p;
}
function view(r, pid) {
  const S = r.S;
  const v = { code: r.code, me: pid, host: r.pl[0] && r.pl[0].id, ph: S ? S.ph : 'lobby', lobby: r.pl.map(p => ({ id: p.id, name: p.name, on: !!p.res })) };
  if (!S) return v;
  const mi = S.P.findIndex(x => x.id === pid);
  v.P = S.P.map((x, i) => ({ name: x.name, cpu: x.cpu, n: S.hands[i].length }));
  v.mi = mi; v.hand = mi >= 0 ? S.hands[mi] : [];
  v.out = S.out; v.turn = S.turn; v.known = S.known; v.msg = S.msg; v.hl = S.hl; v.log = S.log; v.loser = S.loser;
  v.pr = S.prompt ? (S.prompt.p === mi ? S.prompt : { p: S.prompt.p }) : null;
  v.pv = mi >= 0 ? S.pv[mi] : '';
  return v;
}
function push(r) {
  r.last = Date.now();
  for (const p of r.pl) if (p.res) p.res.write('data: ' + JSON.stringify(view(r, p.id)) + '\n\n');
}
function removePlayer(r, pid) {
  const i = r.pl.findIndex(p => p.id === pid);
  if (i < 0) return;
  const p = r.pl[i];
  if (p.res) { try { p.res.end(); } catch (e) {} p.res = null; }
  r.pl.splice(i, 1);
  const S = r.S;
  if (S && S.ph === 'play') {
    const k = S.P.findIndex(x => x.id === pid);
    if (k >= 0) { S.P[k].cpu = 1; if (r.pending && S.prompt && S.prompt.p === k) r.pending.fin(-1); }
  }
  if (!r.pl.length) { r.dead = true; rooms.delete(r.code); return; }
  push(r);
}

// ---------------- ゲームエンジン ----------------
function startGame(r, hs) {
  const P = hs.map(h => ({ id: h.id, name: h.name, cpu: 0 })), cn = ['たろう', 'はなこ', 'じろう', 'さぶろう'];
  let k = 0;
  while (P.length < 3) P.push({ id: 'cpu' + k, name: cn[k++], cpu: 1 });
  const d = [];
  T.forEach((t, i) => { for (let x = 0; x < t.c; x++) d.push({ t: i }); });
  d.push({ j: 1 }); shuf(d);
  const hands = P.map(() => []);
  d.forEach((c, i) => hands[i % P.length].push(c));
  const S = r.S = { ph: 'play', P, hands, out: P.map(() => 0), skip: P.map(() => 0), pv: P.map(() => ''), log: [], turn: 0, known: -1, msg: '', hl: null, prompt: null, loser: -1 };
  r.pending = null;
  const hd = p => S.hands[p], cpu = p => S.P[p].cpu, PN = p => S.P[p].name;
  const alive = () => S.P.map((_, i) => i).filter(i => !S.out[i]);
  const nxt = i => { const n = S.P.length; let j = (i + 1) % n; while (S.out[j]) j = (j + 1) % n; return j; };
  const live = () => !r.dead && r.S === S;
  const lg = t => { S.log.push(t); if (S.log.length > 80) S.log.shift(); };
  const mv = (c, f) => { if (c.j && S.known === f) S.known = -1; };
  const give = (f, to, i) => { const c = hd(f).splice(i, 1)[0]; mv(c, f); hd(to).push(c); return c; };
  const chk = () => { let s = ''; S.P.forEach((_, p) => { if (!hd(p).length && !S.out[p]) { S.out[p] = 1; s += ` ${PN(p)}は定時退社!🎉`; } }); return s; };
  async function upd(m, ms = 0) {
    if (m != null) S.msg = m;
    S.hands.forEach((h, p) => { if (!cpu(p)) h.sort((a, b) => ord(a) - ord(b)); });
    push(r);
    if (ms) await wait(ms);
  }
  function choose(p, msg, opts, from = -1) {
    const n = ++r.pn;
    return new Promise(res => {
      const len = opts ? opts.length : hd(from).length;
      const fin = v => { if (!r.pending || r.pending.n !== n) return; clearTimeout(r.pending.tm); r.pending = null; S.prompt = null; res(v); };
      const pl = r.pl.find(x => x.id === S.P[p].id);
      r.pending = { n, tm: 0, fin: v => fin(Number.isInteger(v) && v >= 0 && v < len ? v : rnd(len)) };
      r.pending.arm = ms => { clearTimeout(r.pending.tm); r.pending.tm = setTimeout(() => fin(rnd(len)), ms); };
      r.pending.arm(pl && pl.res ? 60000 : 3000);
      S.prompt = { p, n, msg, opts, from };
      upd(msg);
    });
  }
  async function pick(p, msg, flt = () => 1, ex = []) {
    const idx = [];
    hd(p).forEach((c, i) => { if (flt(c) && !ex.includes(i)) idx.push(i); });
    if (cpu(p)) { const b = idx.find(i => hd(p)[i].j); return b !== undefined && Math.random() < .7 ? b : idx[rnd(idx.length)]; }
    const r2 = await choose(p, msg, idx.map(i => nm(hd(p)[i])));
    return idx[r2];
  }
  function exch(a, t, ia, ib) {
    const A = ia.map(i => hd(a)[i]), B = ib.map(i => hd(t)[i]);
    S.hands[a] = hd(a).filter(c => !A.includes(c)); S.hands[t] = hd(t).filter(c => !B.includes(c));
    A.forEach(c => mv(c, a)); B.forEach(c => mv(c, t)); hd(t).push(...A); hd(a).push(...B);
    const j = l => l.map(nm).join('・');
    S.pv[a] = `交換: 渡した${j(A)} / 受取${j(B)}`; S.pv[t] = `交換: 渡した${j(B)} / 受取${j(A)}`;
  }
  async function over(l) { S.ph = 'over'; S.loser = l; S.prompt = null; S.msg = ''; lg(`🏁 ゲーム終了: ${PN(l)}が残業に…`); await upd(); }
  async function run() {
    lg('ゲーム開始!');
    await upd('配り終わり!最後に残業😈を持っていたら負け', 1500);
    while (S.ph === 'play' && live()) {
      if (alive().length < 2) { await over(alive()[0]); break; }
      const a = S.turn;
      if (S.skip[a]) { S.skip[a] = 0; lg(`${PN(a)}は1回休み`); await upd(`${PN(a)}は1回休み…`, 1400); S.turn = nxt(a); continue; }
      lg(`▶ ${PN(a)}の番`);
      const f = nxt(a); let i;
      if (cpu(a)) { await upd(`${PN(a)}の番`, 800); i = rnd(hd(f).length); }
      else i = await choose(a, `${PN(f)}の手札から1枚引こう`, null, f);
      S.hl = { p: f, i }; await upd(null, 600);
      const c = hd(f).splice(i, 1)[0]; S.hl = null; mv(c, f); hd(a).push(c); S.pv[a] = `${nm(c)}を引いた`;
      const dm = `${PN(a)}が${PN(f)}から1枚引いた` + chk(); lg(dm); await upd(dm, 900);
      await playPhase(a);
      if (S.ph !== 'play') break;
      S.turn = nxt(a);
    }
  }
  async function playPhase(a) {
    for (;;) {
      const cnt = {};
      hd(a).forEach(c => { if (!c.j) cnt[c.t] = (cnt[c.t] || 0) + 1; });
      const ps = Object.keys(cnt).filter(t => cnt[t] > 1).map(Number);
      if (!ps.length || S.out[a] || alive().length < 2 || !live()) return;
      let t;
      if (cpu(a)) { await wait(700); t = ps[rnd(ps.length)]; }
      else {
        const r2 = await choose(a, 'ペアを出す?(1ターン1ペアまで)', ps.map(t => T[t].e + T[t].n + 'を出す').concat(['パス']));
        if (r2 >= ps.length) return; t = ps[r2];
      }
      if (!await use(a, t)) return;
    }
  }
  async function use(a, t) {
    let k = 2; S.hands[a] = hd(a).filter(c => { if (!c.j && c.t === t && k > 0) { k--; return false; } return true; });
    const kind = T[t].k; lg(`${PN(a)}が${T[t].e}${T[t].n}のペアを出した`);
    await upd(`${PN(a)}が${T[t].e}${T[t].n}を出した!`, 900);
    let tg = -1;
    if (NEED.includes(kind)) {
      const cand = alive().filter(p => p !== a);
      if (cand.length === 1) tg = cand[0];
      else if (cpu(a)) tg = (kind === 'kiro' && cand.includes(S.known)) ? S.known : cand[rnd(cand.length)];
      else tg = cand[await choose(a, '誰を指名する?', cand.map(PN))];
    }
    await eff(a, kind, tg);
    return kind === 'energy' && !S.out[a] && S.ph === 'play';
  }
  async function eff(a, k, t) {
    let m = t >= 0 ? `${PN(t)}を指名。` : '';
    if (k === 'sabori') m = 'サボった…何も起きない😴';
    else if (k === 'meet') { const y = hd(t).some(c => c.j); m += y ? '「…残業カード、持ってます😅」(申告)' : '申告なし(残業は持っていない)'; if (y) S.known = t; else if (S.known === t) S.known = -1; }
    else if (k === 'kiro') {
      const i = cpu(a) ? rnd(hd(t).length) : await choose(a, `${PN(t)}の手札から公開するカードを1枚選ぼう`, null, t);
      S.hl = { p: t, i }; await upd(null, 700); S.hl = null; const c = hd(t)[i];
      if (c.j) { lg(`　→ ${PN(t)}の手札を公開…残業カード発覚!😈`); await upd(m + '手札を公開…残業カード発覚!😈', 1500); return over(t); }
      m += `手札を公開: ${nm(c)}(セーフ)`;
    }
    else if (k === 'boss') {
      if (!hd(a).length) m += '渡せる手札がなかった';
      else { const i = await pick(a, '渡すカードを選ぼう'); const c = give(a, t, i); S.pv[a] = `${nm(c)}を渡した`; S.pv[t] = `上司命令: ${nm(c)}を渡された`; m += '上司命令で1枚押し付けた😡'; }
    }
    else if (k === 'love') {
      if (!hd(a).length) m += '渡せる手札がなかった';
      else { const i = await pick(a, '渡すカードを選ぼう(お互い任意・同時に交換)'), j = await pick(t, '相手に渡すカードを選ぼう(同時に交換)'); exch(a, t, [i], [j]); m += 'お互い1枚ずつ交換💕'; }
    }
    else if (k === 'newbie') {
      const nn = Math.min(2, hd(a).length);
      if (!nn) m += '渡せる手札がなかった';
      else {
        const ia = [];
        for (let x = 0; x < nn; x++) ia.push(await pick(a, `渡すカードを選ぼう(${x + 1}/${nn}枚目)`, () => 1, ia));
        const j = await pick(t, '相手に渡すカードを1枚選ぼう(同時に交換)'); exch(a, t, ia, [j]); m += `新人教育!${nn}枚と1枚を同時に交換🐣`;
      }
    }
    else if (k === 'bribe') {
      if (!hd(a).some(c => !c.j)) m += '渡せるカードがなかった';
      else { const i = await pick(a, '賄賂にするカードを選ぼう(残業以外)', c => !c.j); const c = give(a, t, i); S.pv[a] = `${nm(c)}を渡した`; S.pv[t] = `賄賂: ${nm(c)}を受け取った`; S.skip[t] = 1; m += `賄賂を渡した💰 ${PN(t)}は1回休み`; }
    }
    else if (k === 'joho') {
      const ops = alive().filter(p => p !== a);
      for (const o of ops) if (hd(o).length) { const i = await pick(o, `${PN(a)}に渡すカードを選ぼう`); const c = give(o, a, i); S.pv[a] = `情報共有: ${PN(o)}から${nm(c)}を受け取った`; }
      await upd('📢情報共有!相手全員が1枚ずつ渡した', 800);
      for (const o of ops) if (hd(a).length) { const i = await pick(a, `${PN(o)}に渡すカードを選ぼう`); const c = give(a, o, i); S.pv[o] = `情報共有: ${nm(c)}を渡された`; }
      m = '📢情報共有!全員が1枚ずつ渡し合った';
    }
    else if (k === 'energy') { m = '⚡エナドリ!もう一度労働フェーズ(カードは引かない)'; if (hd(a).some(c => c.j)) { S.known = a; m += ' …残業カードを持っていると申告😰'; } }
    else if (k === 'tabako') {
      const ti = T.findIndex(x => x.k === 'tabako'), s = [];
      S.P.forEach((_, p) => { const n = hd(p).filter(c => !c.j && c.t === ti).length; if (n) { S.hands[p] = hd(p).filter(c => c.j || c.t !== ti); s.push(`${PN(p)}${n}枚`); } });
      m = '🚬タバコ休憩!' + (s.length ? s.join('・') + 'を場に出した' : '他に持っている人はいなかった');
    }
    else if (k === 'nomikai') { S.skip[a] = 1; m = '🍻飲み会!自分は次の番、すべての行動をお休み'; }
    m += chk(); lg('　→ ' + m); await upd(m, 1500);
  }
  run().catch(e => console.error('game error', e && e.stack || e));
}

// ---------------- HTTP ----------------
function body(req) {
  return new Promise(res => {
    let s = '';
    req.on('data', d => { s += d; if (s.length > 10000) req.destroy(); });
    req.on('end', () => { try { res(JSON.parse(s || '{}')); } catch (e) { res({}); } });
    req.on('error', () => res({}));
  });
}
const json = (res, o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
const auth = (room, pid, token) => { const r = rooms.get(String(room || '').toUpperCase()); const p = r && r.pl.find(x => x.id === pid && x.token === token); return p ? { r, p } : null; };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && FILES[u.pathname]) {
      const [f, type] = FILES[u.pathname];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(__dirname, f)));
    }
    if (req.method === 'GET' && u.pathname === '/healthz') return json(res, { ok: true, rooms: rooms.size });
    if (req.method === 'GET' && u.pathname === '/api/events') {
      const a = auth(u.searchParams.get('room'), u.searchParams.get('pid'), u.searchParams.get('token'));
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      if (!a) { res.write('event: gone\ndata: {}\n\n'); return res.end(); }
      const { r, p } = a;
      if (p.res) { try { p.res.end(); } catch (e) {} }
      p.res = res; res.write('retry: 2000\n\n');
      push(r);
      req.on('close', () => {
        if (p.res !== res) return;
        p.res = null;
        const S = r.S;
        if (S && S.ph === 'play' && r.pending && S.prompt && S.P[S.prompt.p].id === p.id) r.pending.arm(3000);
        push(r);
        setTimeout(() => { if (!p.res && r.pl.includes(p) && !(S && r.S === S && S.ph === 'play')) removePlayer(r, p.id); }, 30000);
      });
      return;
    }
    if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
      const b = await body(req);
      if (u.pathname === '/api/create') {
        if (rooms.size > 500) return json(res, { error: 'サーバーが混み合っています' });
        const r = mkRoom(), p = addPlayer(r, b.name);
        return json(res, { room: r.code, pid: p.id, token: p.token });
      }
      if (u.pathname === '/api/join') {
        const r = rooms.get(String(b.room || '').toUpperCase());
        if (!r) return json(res, { error: 'ルームが見つかりません' });
        if (r.S && r.S.ph === 'play') return json(res, { error: 'ゲーム中のため参加できません。終わるまで待ってください' });
        if (r.pl.length >= 6) return json(res, { error: 'ルームが満員です(最大6人)' });
        const p = addPlayer(r, b.name); push(r);
        return json(res, { room: r.code, pid: p.id, token: p.token });
      }
      if (u.pathname === '/api/act') {
        const a = auth(b.room, b.pid, b.token);
        if (!a) return json(res, { error: 'auth' }, 403);
        const { r, p } = a, S = r.S;
        if (b.type === 'start' && r.pl[0] === p && (!S || S.ph === 'over')) {
          if (S) r.pl = r.pl.filter(x => x.res || x === p);
          startGame(r, r.pl.slice(0, 6));
        } else if (b.type === 'choose' && S && S.ph === 'play' && r.pending && S.prompt && S.prompt.n === b.n && S.P[S.prompt.p].id === p.id) {
          r.pending.fin(b.v);
        } else if (b.type === 'leave') removePlayer(r, p.id);
        return json(res, { ok: true });
      }
    }
    res.writeHead(404); res.end('not found');
  } catch (e) { console.error(e); try { res.writeHead(500); res.end('error'); } catch (e2) {} }
}).listen(PORT, () => console.log('残業ゲーム server on :' + PORT));

setInterval(() => { for (const r of rooms.values()) for (const p of r.pl) if (p.res) p.res.write(': ping\n\n'); }, 15000);
setInterval(() => { const now = Date.now(); for (const r of [...rooms.values()]) if (now - r.last > 3600e3 && !r.pl.some(p => p.res)) { r.dead = true; rooms.delete(r.code); } }, 60000);

process.on('unhandledRejection', e => console.error('unhandled', e && e.stack || e));
process.on('uncaughtException', e => console.error('uncaught', e && e.stack || e));

module.exports = { startGame, rooms, mkRoom, addPlayer };
