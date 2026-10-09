'use strict';
// サボりゲーム サーバー(依存パッケージなし / Node.js 18+)
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
const ROBOTS = ['ASIMO', 'AIBO', 'QRIO', 'Pepper', 'Kirobo', 'HRP-4', 'PARO', 'LOVOT', 'Palro', 'HAL', 'Atlas', 'Spot', 'Digit', 'Optimus', 'Sophia', 'NAO', 'iCub', 'Valkyrie', 'Robonaut', 'Talos', 'BigDog', 'Cheetah', 'Unitree', 'Roomba', 'Baxter', 'Sawyer', 'Stretch'];
const ord = c => c.j ? 99 : c.t;
const nm = c => c.j ? '😴サボり' : T[c.t].e + T[c.t].n;
const clean = s => String(s || '').replace(/[<>&"'`]/g, '').trim().slice(0, 12);

const cleanKey = s => String(s || '').replace(/[\s<>&"'`\/\\?#%]/g, '').slice(0, 12).toUpperCase();

function mkRoom(key) {
  let code = key;
  if (!code) do { code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[rnd(24)]).join(''); } while (rooms.has(code));
  const r = { code, pl: [], S: null, pending: null, pn: 0, last: Date.now() };
  rooms.set(code, r);
  return r;
}
function addPlayer(r, name) {
  const p = { id: crypto.randomBytes(4).toString('hex'), token: crypto.randomBytes(12).toString('hex'), name: clean(name) || '名無しの労働者', res: null };
  r.pl.push(p);
  return p;
}
function view(r, pid) {
  const S = r.S;
  const v = { code: r.code, me: pid, host: r.pl[0] && r.pl[0].id, ph: S ? S.ph : 'lobby', lobby: r.pl.map(p => ({ id: p.id, name: p.name, on: !!p.res })) };
  if (!S) return v;
  const mi = S.P.findIndex(x => x.id === pid);
  v.P = S.P.map((x, i) => ({ name: x.name, cpu: x.cpu, n: S.hands[i].length }));
  v.mi = mi; v.hand = mi >= 0 ? S.hands[mi].map(c => { const f = S.fresh[mi].get(c); return f ? { ...c, g: f.l } : c; }) : [];
  v.out = S.out; v.turn = S.turn; v.phase = S.phase; v.known = S.known; v.msg = S.msg; v.hl = S.hl; v.log = S.log; v.loser = S.loser;
  v.pr = S.prompt ? (S.prompt.p === mi ? S.prompt : { p: S.prompt.p, from: S.prompt.from }) : null;
  v.pl = mi >= 0 ? S.pl[mi] : []; v.last = S.last;
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
// デバッグ用: 手札・CPU人数・最初の手番を指定して配る(ひとりで遊ぶときだけ使える)
function debugDeal(spec) {
  const cpuN = Math.min(5, Math.max(1, parseInt(spec.cpu) || 2)), n = 1 + cpuN;
  const lab = p => (p === 0 ? '自分' : 'CPU席' + p);
  const deck = [];
  T.forEach((t, i) => { for (let x = 0; x < t.c; x++) deck.push({ t: i }); });
  deck.push({ j: 1 });
  const take = (name, p) => {
    let k;
    if (['サボり', 'joker', 'ジョーカー', '😴'].includes(name)) k = deck.findIndex(c => c.j);
    else {
      const ti = T.findIndex(t => t.n === name || t.k === name);
      if (ti < 0) throw new Error(`${lab(p)}の手札: 「${name}」というカードはありません(使える名前: ${T.map(t => t.n).join('、')}、サボり)`);
      k = deck.findIndex(c => c.t === ti);
    }
    if (k < 0) throw new Error(`${lab(p)}の手札: 「${name}」の枚数が足りません(カードの総枚数を超えています)`);
    return deck.splice(k, 1)[0];
  };
  const lists = spec.hands || [], sizes = spec.sizes || [], hands = [];
  for (let p = 0; p < n; p++) {
    const toks = String(lists[p] || '').split(/[,、，\s]+/).filter(Boolean);
    hands.push(toks.length ? toks.flatMap(tok => { const m = tok.match(/^(.*?)(?:[×xX*＊]?(\d+))?$/); return Array.from({ length: m[2] ? +m[2] : 1 }, () => m[1]); }).map(nm_ => take(nm_, p)) : null);
  }
  const sz = p => { const v = parseInt(sizes[p]); return v >= 0 ? v : -1; };
  const rest = shuf(deck);
  for (let p = 0; p < n; p++) {
    if (hands[p] && sz(p) >= 0) {
      if (sz(p) < hands[p].length) throw new Error(`${lab(p)}: 手札の指定(${hands[p].length}枚)が枚数(${sz(p)}枚)を超えています`);
      while (hands[p].length < sz(p) && rest.length) hands[p].push(rest.pop());
    } else if (!hands[p] && sz(p) >= 0) hands[p] = rest.splice(0, sz(p));
  }
  const auto = []; for (let p = 0; p < n; p++) if (!hands[p]) { hands[p] = []; auto.push(p); }
  if (auto.length) while (rest.length) hands[auto[rest.length % auto.length]].push(rest.pop());
  if (!hands.some(h => h.some(c => c.j))) { const j = rest.findIndex(c => c.j); if (j >= 0) hands[rnd(n)].push(rest.splice(j, 1)[0]); }
  hands.forEach((h, p) => { if (!h.length) throw new Error(`${lab(p)}の手札が0枚です`); });
  const first = parseInt(spec.first); return { n, hands, first: first >= 0 && first < n ? first : 0 };
}

function startGame(r, hs, dbg) {
  const D = dbg ? debugDeal(dbg) : null;
  const P = hs.map(h => ({ id: h.id, name: h.name, cpu: 0 })), cn = shuf(ROBOTS.slice()).map(n => '🤖' + n); // CPU名: 実在ロボットの名前からランダム(重複なし)
  let k = 0;
  while (P.length < (D ? D.n : 3)) P.push({ id: 'cpu' + k, name: cn[k++], cpu: 1 });
  if (hs.length === 1 && !D) shuf(P); // ひとり用: 席順(=手番)をランダムにする
  let hands;
  if (D) hands = D.hands;
  else {
    const d = [];
    T.forEach((t, i) => { for (let x = 0; x < t.c; x++) d.push({ t: i }); });
    d.push({ j: 1 }); shuf(d);
    hands = P.map(() => []);
    d.forEach((c, i) => hands[i % P.length].push(c));
  }
  const S = r.S = { ph: 'play', P, hands, out: P.map(() => 0), skip: P.map(() => 0), nopair: P.map(() => 0), pl: P.map(() => []), fresh: P.map(() => new Map()), seq: 0, tseq: 0, last: null, log: [], turn: D ? D.first : 0, known: -1, msg: '', hl: null, prompt: null, loser: -1 };
  r.pending = null;
  const hd = p => S.hands[p], cpu = p => S.P[p].cpu, PN = p => S.P[p].name;
  const alive = () => S.P.map((_, i) => i).filter(i => !S.out[i]);
  const nxt = i => { const n = S.P.length; let j = (i + 1) % n; while (S.out[j]) j = (j + 1) % n; return j; };
  const live = () => !r.dead && r.S === S;
  const lg = t => { S.log.push(t); if (S.log.length > 80) S.log.shift(); };
  const pm = (p, t) => { const a = S.pl[p]; a.push(t); if (a.length > 40) a.shift(); };
  const tag = (p, c, l) => S.fresh[p].set(c, { l, s: ++S.seq });
  const srt = () => {}; // 手札は自動で並び替えない(位置から残業が分からないように。並び替えは本人が行う)
  const mv = (c, f) => { S.fresh[f].delete(c); if (c.j && S.known === f) S.known = -1; };
  const give = (f, to, i, l) => { const c = hd(f).splice(i, 1)[0]; mv(c, f); hd(to).push(c); tag(to, c, l); return c; };
  const chk = () => { let s = ''; S.P.forEach((_, p) => { if (!hd(p).length && !S.out[p]) { S.out[p] = 1; s += ` ${PN(p)}は定時退社!🎉`; } }); return s; };
  async function upd(m, ms = 0) {
    if (m != null) S.msg = m;
    srt();
    push(r);
    if (ms) await wait(ms);
  }
  function choose(p, msg, opts, from = -1, hi = null, ex = []) {
    const n = ++r.pn;
    return new Promise(res => {
      const len = opts ? opts.length : hd(from).length;
      const fin = v => { if (!r.pending || r.pending.n !== n) return; clearTimeout(r.pending.tm); r.pending = null; S.prompt = null; res(v); };
      const pl = r.pl.find(x => x.id === S.P[p].id);
      r.pending = { n, tm: 0, fin: v => fin(Number.isInteger(v) && v >= 0 && v < len ? v : rnd(len)) };
      r.pending.arm = ms => { clearTimeout(r.pending.tm); r.pending.tm = setTimeout(() => fin(rnd(len)), ms); };
      r.pending.arm(pl && pl.res ? 60000 : 3000);
      S.prompt = { p, n, msg, opts, from, hi, ex };
      upd(msg);
    });
  }
  async function pick(p, msg, flt = () => 1, ex = []) {
    srt();
    const idx = [];
    hd(p).forEach((c, i) => { if (flt(c) && !ex.includes(i)) idx.push(i); });
    if (cpu(p)) { const b = idx.find(i => hd(p)[i].j); return b !== undefined && Math.random() < .7 ? b : idx[rnd(idx.length)]; }
    const r2 = await choose(p, msg, idx.map(i => nm(hd(p)[i])), -1, idx, ex);
    return idx[r2];
  }
  function exch(a, t, ia, ib, l) {
    const A = ia.map(i => hd(a)[i]), B = ib.map(i => hd(t)[i]);
    S.hands[a] = hd(a).filter(c => !A.includes(c)); S.hands[t] = hd(t).filter(c => !B.includes(c));
    A.forEach(c => mv(c, a)); B.forEach(c => mv(c, t)); hd(t).push(...A); hd(a).push(...B); A.forEach(c => tag(t, c, l)); B.forEach(c => tag(a, c, l));
    const j = l => l.map(nm).join('・');
    pm(a, `${l}: ${PN(t)}に ${j(A)} を渡し、${j(B)} を受け取った`); pm(t, `${l}: ${PN(a)}に ${j(B)} を渡し、${j(A)} を受け取った`);
  }
  async function over(l) { S.ph = 'over'; S.loser = l; S.prompt = null; S.msg = ''; lg(`🏁 ゲーム終了: ${PN(l)}が残業に…`); await upd(); }
  async function run() {
    lg('ゲーム開始!');
    await upd('配り終わり!最後にサボり😴を持っていたら負け', 1500);
    while (S.ph === 'play' && live()) {
      if (alive().length < 2) { await over(alive()[0]); break; }
      const a = S.turn;
      if (S.skip[a]) { S.skip[a] = 0; lg(`${PN(a)}は1回休み`); await upd(`${PN(a)}は1回休み…`, 1400); S.turn = nxt(a); continue; }
      lg(`▶ ${PN(a)}のターン`); S.tseq = S.seq;
      const f = nxt(a); let i;
      S.phase = ''; await upd(`${PN(a)}のターン`, 1000); S.phase = '労働'; // ターン開始を1秒表示してから「労働」へ
      if (cpu(a)) i = rnd(hd(f).length);
      else i = await choose(a, `${PN(f)}の手札から1枚引こう`, null, f);
      S.hl = { p: f, i }; await upd(null, 600);
      const c = hd(f).splice(i, 1)[0]; S.hl = null; mv(c, f); hd(a).push(c); tag(a, c, '引いた'); pm(a, `🃏 ${PN(f)}から ${nm(c)} を引いた`); pm(f, `🃏 ${PN(a)}に ${nm(c)} を引かれた`);
      const dm = `${PN(a)}が${PN(f)}から1枚引いた` + chk(); lg(dm); await upd(dm, 900);
      S.phase = '行動';
      if (S.nopair[a]) { S.nopair[a] = 0; lg(`${PN(a)}は賄賂で1回休み(ペアを出せない)`); await upd(`${PN(a)}は1回休み…ペアは出せない`, 1200); }
      else await playPhase(a);
      S.fresh[a].forEach((f, c) => { if (f.s <= S.tseq) S.fresh[a].delete(c); });
      if (S.ph !== 'play') break;
      S.turn = nxt(a);
    }
  }
  async function playPhase(a) {
    for (;;) {
      const cnt = {};
      hd(a).forEach(c => { if (!c.j) cnt[c.t] = (cnt[c.t] || 0) + 1; });
      const ps = Object.keys(cnt).filter(t => cnt[t] > 1).map(Number);
      if (S.out[a] || alive().length < 2 || !live()) return;
      if (!ps.length && cpu(a)) return;
      let t;
      if (cpu(a)) { await wait(700); t = ps[rnd(ps.length)]; }
      else {
        const r2 = await choose(a, ps.length ? 'ペアを出す?(1ターン1ペアまで)' : '出せるペアがありません',  ps.map(t => T[t].e + T[t].n + 'を出す').concat(['パス']));
        if (r2 >= ps.length) return; t = ps[r2];
      }
      if (!await use(a, t)) return;
    }
  }
  async function use(a, t) {
    S.phase = '効果処理';
    let k = 2; S.hands[a] = hd(a).filter(c => { if (!c.j && c.t === t && k > 0) { k--; return false; } return true; });
    const kind = T[t].k; S.last = { p: a, t }; lg(`${PN(a)}が${T[t].e}${T[t].n}のペアを出した`);
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
    if (k === 'sabori') m = 'ノルマ…何も起きない📈';
    else if (k === 'meet') { const y = hd(t).some(c => c.j); m += y ? '「…サボりカード、持ってます😅」(申告)' : '申告なし(サボりは持っていない)'; if (y) S.known = t; else if (S.known === t) S.known = -1; }
    else if (k === 'kiro') {
      const i = cpu(a) ? rnd(hd(t).length) : await choose(a, `${PN(t)}の手札から公開するカードを1枚選ぼう`, null, t);
      S.hl = { p: t, i }; await upd(null, 700); S.hl = null; const c = hd(t)[i];
      if (c.j) { lg(`　→ ${PN(t)}の手札を公開…サボりカード発覚!😴`); await upd(m + '手札を公開…サボりカード発覚!😴', 1500); return over(t); }
      if (T[c.t].k === 'boss') { give(t, a, i, '社長で公開'); pm(a, `🔍 社長: ${PN(t)}の${nm(c)}が公開され、受け取った`); pm(t, `🔍 社長: ${nm(c)}が公開され、${PN(a)}に渡った`); m += `手札を公開: ${nm(c)} → 上司命令なので${PN(a)}に渡った`; }
      else m += `手札を公開: ${nm(c)}(セーフ)`;
    }
    else if (k === 'boss') {
      if (!hd(a).length) m += '渡せる手札がなかった';
      else { const i = await pick(a, '渡すカードを選ぼう'); const c = give(a, t, i, '上司命令'); pm(a, `😡 上司命令: ${PN(t)}に ${nm(c)} を渡した`); pm(t, `😡 上司命令: ${PN(a)}から ${nm(c)} を渡された`); m += '上司命令で1枚押し付けた😡'; }
    }
    else if (k === 'love') {
      if (!hd(a).length) m += '渡せる手札がなかった';
      else { const ca = hd(a)[await pick(a, '渡すカードを選ぼう(お互い任意・同時に交換)')]; const cb = hd(t)[await pick(t, '相手に渡すカードを選ぼう(同時に交換)')]; exch(a, t, [hd(a).indexOf(ca)], [hd(t).indexOf(cb)], '💕交換'); m += 'お互い1枚ずつ交換💕'; }
    }
    else if (k === 'newbie') {
      const nn = Math.min(2, hd(a).length);
      if (!nn) m += '渡せる手札がなかった';
      else {
        const ia = [];
        for (let x = 0; x < nn; x++) ia.push(await pick(a, `渡すカードを選ぼう(${x + 1}/${nn}枚目)`, () => 1, ia));
        const cas = ia.map(k => hd(a)[k]); const cj = hd(t)[await pick(t, '相手に渡すカードを1枚選ぼう(同時に交換)')]; exch(a, t, cas.map(c => hd(a).indexOf(c)), [hd(t).indexOf(cj)], '🐣交換'); m += `新人教育!${nn}枚と1枚を同時に交換🐣`;
      }
    }
    else if (k === 'bribe') {
      if (!hd(a).some(c => !c.j)) m += '渡せるカードがなかった';
      else { const i = await pick(a, '賄賂にするカードを選ぼう(サボり以外)', c => !c.j); const c = give(a, t, i, '賄賂'); pm(a, `💰 賄賂: ${PN(t)}に ${nm(c)} を渡した`); pm(t, `💰 賄賂: ${PN(a)}から ${nm(c)} を受け取った(1回休み)`); S.nopair[t] = 1; m += `賄賂を渡した💰 ${PN(t)}は1回休み(次の番はペアを出せない)`; }
    }
    else if (k === 'joho') {
      const ops = alive().filter(p => p !== a);
      for (const o of ops) if (hd(o).length) { const i = await pick(o, `${PN(a)}に渡すカードを選ぼう`); const c = give(o, a, i, '情報共有'); pm(a, `📢 情報共有: ${PN(o)}から ${nm(c)} を受け取った`); pm(o, `📢 情報共有: ${PN(a)}に ${nm(c)} を渡した`); }
      await upd('📢情報共有!相手全員が1枚ずつ渡した', 800);
      for (const o of ops) if (hd(a).length) { const i = await pick(a, `${PN(o)}に渡すカードを選ぼう`); const c = give(a, o, i, '情報共有'); pm(o, `📢 情報共有: ${PN(a)}から ${nm(c)} を渡された`); pm(a, `📢 情報共有: ${PN(o)}に ${nm(c)} を渡した`); }
      m = '📢情報共有!全員が1枚ずつ渡し合った';
    }
    else if (k === 'energy') { m = '⚡エナドリ!もう一度労働フェーズ'; if (hd(a).some(c => c.j)) { S.known = a; m += ' …サボりカードを持っていると申告😰'; } }
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
        const key = cleanKey(b.key);
        if (key && key.length < 3) return json(res, { error: 'キーワードは3〜12文字で入力してください(空欄ならランダム)' });
        if (key && rooms.has(key)) return json(res, { error: 'そのキーワードはすでに使われています。別のキーワードにしてください' });
        const r = mkRoom(key), p = addPlayer(r, b.name);
        return json(res, { room: r.code, pid: p.id, token: p.token });
      }
      if (u.pathname === '/api/join') {
        const key = cleanKey(b.room);
        let r = rooms.get(key);
        if (!r && b.create) { // 同じ名前の部屋がなければ、その名前で作る
          if (key.length < 3) return json(res, { error: '部屋の名前は3〜12文字で入力してください' });
          if (rooms.size > 500) return json(res, { error: 'サーバーが混み合っています' });
          r = mkRoom(key);
        }
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
          try { startGame(r, r.pl.slice(0, 6), r.pl.length === 1 ? b.debug : null); } catch (e) { return json(res, { error: e.message }); }
        } else if (b.type === 'choose' && S && S.ph === 'play' && r.pending && S.prompt && S.prompt.n === b.n && S.P[S.prompt.p].id === p.id) {
          r.pending.fin(b.v);
        } else if (b.type === 'order' && S && S.ph === 'play') {
          const i = S.P.findIndex(x => x.id === p.id), h = i >= 0 && S.hands[i], q = S.prompt;
          const lock = (q && q.from === i) || (S.hl && S.hl.p === i);
          const ok = h && !lock && Array.isArray(b.perm) && b.perm.length === h.length && new Set(b.perm).size === h.length && b.perm.every(k => Number.isInteger(k) && k >= 0 && k < h.length);
          if (!ok) return json(res, { error: 'locked' });
          if (q && q.p === i && q.hi) { const nw = k => b.perm.indexOf(k); q.hi.forEach((k, j) => { q.hi[j] = nw(k); }); (q.ex || []).forEach((k, j) => { q.ex[j] = nw(k); }); } // 選択中の番号も追従させる
          const nh = b.perm.map(k => h[k]); h.splice(0, h.length, ...nh); push(r);
        } else if (b.type === 'leave') removePlayer(r, p.id);
        return json(res, { ok: true });
      }
    }
    res.writeHead(404); res.end('not found');
  } catch (e) { console.error(e); try { res.writeHead(500); res.end('error'); } catch (e2) {} }
}).listen(PORT, () => console.log('サボりゲーム server on :' + PORT));

setInterval(() => { for (const r of rooms.values()) for (const p of r.pl) if (p.res) p.res.write(': ping\n\n'); }, 15000);
setInterval(() => { const now = Date.now(); for (const r of [...rooms.values()]) if (now - r.last > 3600e3 && !r.pl.some(p => p.res)) { r.dead = true; rooms.delete(r.code); } }, 60000);

process.on('unhandledRejection', e => console.error('unhandled', e && e.stack || e));
process.on('uncaughtException', e => console.error('uncaught', e && e.stack || e));

module.exports = { startGame, rooms, mkRoom, addPlayer };
