'use strict';
// Mindi Coat: lobby, peer-to-peer rooms and the table.
// The room creator's browser is the host: it runs the engine, plays the computer seats and sends
// every player a view with only their own cards. Others connect to it over WebRTC (PeerJS).
const M = window.Mindi, Bot = window.MindiBot;
const app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const PREFIX = 'mindicoat-v1-';
const BOT_NAMES = ['Kaka', 'Masi', 'Bhabhi', 'Dada', 'Fai', 'Mama', 'Ba', 'Motabhai'];
const TEAM = [{ name: 'Team Kesar', short: 'Kesar', color: 'var(--teamA)' }, { name: 'Team Mor', short: 'Mor', color: 'var(--teamB)' }];
const KIND_TEXT = {
  tens: 'more mindis', tricks: 'mindis split, more haath', mindikot: 'Mindi Coat! All the tens', fullcoat: 'Full Coat! Every haath', draw: 'Barabar: tens and haath split evenly',
};
const sym = s => M.SUIT_INFO[s].sym + '︎';

const clientId = store.get('mc.client') || (() => { const id = Math.random().toString(36).slice(2, 12); store.set('mc.client', id); return id; })();
let myName = store.get('mc.name') || '';
let menuN = store.get('mc.n') || 4;

// Local UI state, filled from the host's sync messages
const S = { role: null, room: null, view: null, mySeat: null, status: '', lastSeq: 0, lastHand: 0, showLast: false };
let H = null;   // host: { code, room, conns: Map(clientId -> conn), peer, timer }
let C = null;   // guest: { code, peer, conn, timer }

/* ---------------- helpers ---------------- */
function toast(msg, ms = 2400) {
  const t = document.getElementById('toast');
  t.innerHTML = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
const genCode = () => Array.from({ length: 5 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('');
const cleanName = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 16);
const shareUrl = code => `${location.origin}${location.pathname}#join=${code}`;
// Copy text: the Clipboard API, then the older execCommand route (works where clipboard permission is denied)
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
  document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  ta.remove(); return ok;
}
const seatName = (room, i) => (room.seats[i] ? room.seats[i].name : `Seat ${i + 1}`);

function cardHtml(id, cls = '', attrs = '') {
  const c = M.parse(id), info = M.SUIT_INFO[c.s];
  return `<div class="card ${info.red ? 'red' : ''} ${c.r === '10' ? 'ten' : ''} ${cls}" ${attrs} aria-label="${c.r} of ${info.name}">
    <span class="tl">${c.r}<i>${sym(c.s)}</i></span><span class="mid">${sym(c.s)}</span></div>`;
}
const backHtml = (cls = '') => `<div class="card back ${cls}"></div>`;

/* ---------------- host ---------------- */
function newRoom(n, offline) {
  const seats = Array(n).fill(null);
  seats[0] = { kind: 'human', id: clientId, name: myName, online: true };
  return { code: offline ? 'SOLO' : genCode(), n, offline: !!offline, seats, started: false, nextMode: 'band',
    game: null, handNo: 0, series: { points: [0, 0], hands: [] } };
}
function hostStart(room) {
  H = { code: room.code, room, conns: new Map(), peer: null, timer: null };
  S.role = 'host';
  if (!room.offline) openHostPeer(false);
  hostChanged();
}
function openHostPeer(resuming) {
  if (typeof Peer === 'undefined') { S.status = "Couldn't load the online connection library. Check your internet and reload."; render(); return; }
  S.status = resuming ? 'Reopening the room…' : 'Opening the room…';
  const peer = new Peer(PREFIX + H.code, { debug: 0 });
  H.peer = peer;
  peer.on('open', () => { S.status = ''; render(); });
  peer.on('connection', conn => {
    conn.on('data', msg => hostOnMessage(conn, msg));
    conn.on('close', () => hostDrop(conn));
    conn.on('error', () => hostDrop(conn));
  });
  peer.on('disconnected', () => setTimeout(() => { if (H && H.peer === peer && !peer.destroyed) peer.reconnect(); }, 2000));
  peer.on('error', err => {
    if (!H || H.peer !== peer) return;
    if (err.type === 'unavailable-id') {
      peer.destroy();
      if (resuming || H.room.started) { S.status = 'Waiting for the old room link to free up…'; setTimeout(() => H && openHostPeer(true), 4000); }
      else { H.code = H.room.code = genCode(); openHostPeer(false); }
    } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      S.status = 'Lost the connection to the room server. Retrying…';
      setTimeout(() => { if (H && H.peer === peer && !peer.destroyed) peer.reconnect(); }, 3000);
    }
    render();
  });
}
function hostDrop(conn) {
  if (!H) return;
  const id = conn._id;
  if (id && H.conns.get(id) === conn) {
    H.conns.delete(id);
    const s = H.room.seats.find(x => x && x.kind === 'human' && x.id === id);
    if (s) s.online = false;
    hostChanged();
  }
}
function hostOnMessage(conn, msg) {
  if (!H || !msg || typeof msg !== 'object') return;
  const room = H.room;
  if (msg.t === 'hello') {
    const id = String(msg.id || '').slice(0, 40), name = cleanName(msg.name) || 'Player';
    if (!id) return;
    const old = H.conns.get(id);
    if (old && old !== conn) { old._id = null; old.close(); }
    conn._id = id;
    H.conns.set(id, conn);
    let i = room.seats.findIndex(s => s && s.kind === 'human' && s.id === id);
    if (i < 0 && !room.started) {
      i = room.seats.findIndex(s => !s);
      if (i >= 0) room.seats[i] = { kind: 'human', id, name, online: true };
    }
    if (i >= 0) { room.seats[i].online = true; room.seats[i].name = name; }
    hostChanged();
    return;
  }
  if (!conn._id) return;
  if (msg.t === 'sit') return hostSit(conn._id, +msg.seat);
  if (msg.t === 'act') return hostAct(conn._id, msg.a);
}
function sendTo(id, msg) {
  if (id === clientId) return;
  const c = H.conns.get(id);
  if (c && c.open) { try { c.send(msg); } catch { /* closed */ } }
}
function hostSit(id, seat) {
  const room = H.room;
  if (!(seat >= 0 && seat < room.n)) return;
  const target = room.seats[seat];
  const from = room.seats.findIndex(s => s && s.kind === 'human' && s.id === id);
  if (target && target.kind === 'human') return;
  if (room.started && from >= 0) return;            // mid-game you keep your seat
  if (room.started && !target) return;
  const me = from >= 0 ? room.seats[from] : { kind: 'human', id, name: 'Player', online: true };
  if (from >= 0) room.seats[from] = null;
  room.seats[seat] = me;
  hostChanged();
}
function hostAct(id, a) {
  const room = H.room, g = room.game;
  const seat = room.seats.findIndex(s => s && s.kind === 'human' && s.id === id);
  if (!g || seat < 0 || !a) return;
  try { room.game = M.act(g, seat, { type: a.type, card: a.card }); }
  catch (e) { if (id === clientId) toast(esc(e.message)); else sendTo(id, { t: 'err', msg: e.message }); return; }
  hostChanged();
}
// Host-only controls
function hostToggleBot(i) {
  const room = H.room;
  if (room.started) return;
  if (!room.seats[i]) room.seats[i] = { kind: 'bot', name: BOT_NAMES[i % BOT_NAMES.length] };
  else if (room.seats[i].kind === 'bot') room.seats[i] = null;
  hostChanged();
}
function hostSetMode(mode) { H.room.nextMode = mode === 'cut' ? 'cut' : 'band'; hostChanged(); }
function hostBegin() {
  const room = H.room;
  room.seats = room.seats.map((s, i) => s || { kind: 'bot', name: BOT_NAMES[i % BOT_NAMES.length] });
  room.started = true;
  room.handNo = 1;
  room.game = M.newHand(room.n, room.n - 1, room.nextMode);
  hostChanged();
}
function hostNextHand() {
  const room = H.room, g = room.game;
  if (!g || g.phase !== 'done') return;
  room.handNo++;
  room.game = M.newHand(room.n, g.result.nextDealer, room.nextMode);
  hostChanged();
}
function hostEnd() {
  if (!H) return;
  for (const c of H.conns.values()) { try { c.send({ t: 'closed' }); } catch { /* ignore */ } }
  clearTimeout(H.timer);
  if (H.peer) H.peer.destroy();
  store.del('mc.hostRoom');
  H = null;
}

function publicRoom(room) {
  return {
    code: room.code, n: room.n, offline: room.offline, started: room.started, nextMode: room.nextMode,
    handNo: room.handNo, series: room.series,
    seats: room.seats.map(s => s && { kind: s.kind, name: s.name, online: s.kind === 'bot' || s.online, id: s.kind === 'human' ? s.id : null }),
  };
}
function syncFor(id) {
  const room = H.room;
  const seat = room.seats.findIndex(s => s && s.kind === 'human' && s.id === id);
  return { t: 'sync', room: publicRoom(room), mySeat: seat < 0 ? null : seat, view: room.game ? M.viewFor(room.game, seat < 0 ? null : seat) : null };
}
function hostChanged() {
  if (!H) return;
  const room = H.room;
  store.set('mc.hostRoom', { room, savedAt: Date.now() });
  for (const id of H.conns.keys()) sendTo(id, syncFor(id));
  applySync(syncFor(clientId));
  hostSchedule();
}
// Runs computer seats, lets a dropped player's turn pass after a grace period, and collects tricks
function hostSchedule() {
  clearTimeout(H.timer);
  const room = H.room, g = room.game;
  if (!g || g.phase === 'done') return;
  if (g.phase === 'collect') {
    H.timer = setTimeout(() => {
      room.game = M.collect(room.game);
      if (room.game.phase === 'done') {
        const r = room.game.result;
        if (r.winner != null) room.series.points[r.winner] += r.points;
        room.series.hands.push({ no: room.handNo, mode: room.game.mode, winner: r.winner, kind: r.kind, tens: r.tens, tricks: r.tricks, points: r.points });
      }
      hostChanged();
    }, 1500);
    return;
  }
  const seat = g.phase === 'hide' ? g.leader : g.turn;
  const s = room.seats[seat];
  const auto = s.kind === 'bot' || (!s.online && s.id !== clientId);
  if (!auto) return;
  H.timer = setTimeout(() => {
    try { room.game = M.act(room.game, seat, Bot.botAction(room.game, seat)); } catch (e) { console.error(e); return; }
    hostChanged();
  }, s.kind === 'bot' ? (g.phase === 'hide' ? 1100 : 750) : 15000);
}

/* ---------------- guest ---------------- */
function guestJoin(code) {
  if (typeof Peer === 'undefined') { toast("Couldn't load the online connection library. Check your internet."); return; }
  guestLeave();
  C = { code, peer: null, conn: null, timer: null };
  S.role = 'guest'; S.room = null; S.view = null; S.status = `Connecting to room ${code}…`;
  store.set('mc.lastJoin', { code, at: Date.now() });
  history.replaceState(null, '', '#join=' + code);
  render();
  const peer = new Peer({ debug: 0 });
  C.peer = peer;
  peer.on('open', () => guestConnect());
  peer.on('disconnected', () => setTimeout(() => { if (C && C.peer === peer && !peer.destroyed) peer.reconnect(); }, 2000));
  peer.on('error', err => {
    if (!C || C.peer !== peer) return;
    S.status = err.type === 'peer-unavailable'
      ? `Can't reach room ${code}. Check the code; if the host's screen is off, it will reconnect when they're back. Retrying…`
      : 'Connection problem. Retrying…';
    render();
    guestRetry();
  });
}
function guestConnect() {
  if (!C) return;
  if (C.conn && C.conn.open) return;
  const conn = C.peer.connect(PREFIX + C.code, { reliable: true });
  C.conn = conn;
  conn.on('open', () => { S.status = ''; conn.send({ t: 'hello', id: clientId, name: myName }); render(); });
  conn.on('data', msg => {
    if (msg && msg.t === 'sync') applySync(msg);
    else if (msg && msg.t === 'err') toast(esc(msg.msg));
    else if (msg && msg.t === 'closed') { guestLeave(); S.role = null; render(); toast('The host closed the room'); }
  });
  conn.on('close', () => { if (C && C.conn === conn) { S.status = 'Lost the host. Reconnecting…'; render(); guestRetry(); } });
}
function guestRetry() {
  if (!C) return;
  clearTimeout(C.timer);
  C.timer = setTimeout(() => {
    if (!C) return;
    if (C.peer.disconnected && !C.peer.destroyed) C.peer.reconnect();
    if (!(C.conn && C.conn.open)) guestConnect();
  }, 3000);
}
function guestLeave() {
  if (!C) return;
  clearTimeout(C.timer);
  try { C.conn && C.conn.close(); } catch { /* ignore */ }
  try { C.peer && C.peer.destroy(); } catch { /* ignore */ }
  C = null;
}

/* ---------------- shared actions ---------------- */
function doAct(a) { if (S.role === 'host') hostAct(clientId, a); else if (C && C.conn && C.conn.open) C.conn.send({ t: 'act', a }); }
function doSit(seat) { if (S.role === 'host') hostSit(clientId, seat); else if (C && C.conn && C.conn.open) C.conn.send({ t: 'sit', seat }); }
function leave() {
  if (S.role === 'host') {
    if (!S.room.offline && !confirm('Close this room for everyone?')) return;
    hostEnd();
  } else guestLeave();
  Object.assign(S, { role: null, room: null, view: null, mySeat: null, status: '' });
  history.replaceState(null, '', location.pathname);
  render();
}

/* ---------------- events -> toasts ---------------- */
function applySync(msg) {
  const prevHand = S.room ? S.room.handNo : 0;
  S.room = msg.room; S.mySeat = msg.mySeat; S.view = msg.view;
  if (S.room.handNo !== prevHand) { S.lastSeq = 0; S.showLast = false; }
  if (S.view) {
    for (const e of S.view.events) if (e.seq > S.lastSeq) announce(e);
    S.lastSeq = S.view.events.length ? S.view.events[S.view.events.length - 1].seq : 0;
  }
  render();
}
function announce(e) {
  const nm = i => esc(i === S.mySeat ? 'You' : seatName(S.room, i));
  const suit = s => `<b class="${M.SUIT_INFO[s].red ? 'red' : ''}">${sym(s)} ${M.SUIT_INFO[s].name}</b>`;
  if (e.type === 'open') toast(e.forced ? `Hukum opens: ${suit(e.suit)}` : `${nm(e.seat)} opened the hukum: ${suit(e.suit)}`, 3200);
  else if (e.type === 'cut') toast(`${nm(e.seat)} cut! ${suit(e.suit)} is hukum`, 3200);
  else if (e.type === 'trick' && e.tens.length) toast(`${nm(e.seat)} took ${e.tens.length > 1 ? e.tens.length + ' mindis' : 'a mindi'} for ${TEAM[M.team(e.seat)].short} 🎯`);
  else if (e.type === 'done') petals();
}
function petals() {
  const cols = ['#e8761a', '#f2a516', '#f7b733', '#c0262d', '#ffd166'];
  for (let i = 0; i < 50; i++) {
    const p = document.createElement('div');
    p.className = 'petal';
    p.style.left = Math.random() * 100 + 'vw';
    p.style.background = cols[i % cols.length];
    p.style.animationDuration = 2.6 + Math.random() * 2.4 + 's';
    p.style.animationDelay = Math.random() * 1 + 's';
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 6500);
  }
}

/* ---------------- screens ---------------- */
function render() {
  if (!S.role) return renderMenu();
  if (!S.room) return renderConnecting();
  if (!S.room.started) return renderLobby();
  return renderTable();
}

function brand() {
  return `<div class="brand"><span class="logo">♠</span><div><div class="title">Mindi Coat</div><div class="gu">મીંડી કોટ</div></div></div>`;
}

function renderMenu() {
  const saved = store.get('mc.hostRoom');
  const resumable = saved && saved.room && Date.now() - saved.savedAt < 12 * 3600e3 ? saved.room : null;
  const join = (location.hash.match(/join=([A-Z0-9]{5})/i) || [])[1] || '';
  app.innerHTML = `
    <div class="menu">
      ${brand()}
      <div class="panel">
        <label class="lbl" for="nm">Your name <span class="gu">તમારું નામ</span></label>
        <input id="nm" maxlength="16" value="${esc(myName)}" placeholder="e.g. Asha" autocomplete="nickname">
        ${join ? `<div class="joinbox"><div>Join room <b class="code">${esc(join.toUpperCase())}</b></div><button class="btn primary big" id="joinLink">Join game</button></div>` : ''}
        <div class="lbl" style="margin-top:16px">Players</div>
        <div class="seg" id="nseg">${[4, 6, 8].map(n => `<button type="button" data-n="${n}" aria-pressed="${menuN === n}">${n}</button>`).join('')}</div>
        <div class="row">
          <button class="btn primary big" id="create">Create a room</button>
          <button class="btn big" id="solo">Practise vs computer</button>
        </div>
        <div class="lbl" style="margin-top:18px">Join a friend's room</div>
        <div class="row">
          <input id="code" maxlength="5" placeholder="CODE" value="${esc(join.toUpperCase())}" autocapitalize="characters" class="codein">
          <button class="btn" id="join">Join</button>
        </div>
        ${resumable ? `<div class="resume">You were hosting <b>${resumable.offline ? 'a practice game' : 'room ' + esc(resumable.code)}</b>. <button class="btn" id="resume">Resume</button> <button class="btn ghost" id="forget">Forget</button></div>` : ''}
      </div>
      <details class="panel rules">
        <summary>How to play <span class="gu">રમવાની રીત</span></summary>
        <ul>
          <li>Two teams; partners sit opposite. Follow the suit led if you can. Highest hukum (trump) wins, else the highest card of the suit led.</li>
          <li><b>Band hukum</b>: the first player hides one card face down; its suit is hukum. When you can't follow suit you may <i>open</i> it.</li>
          <li><b>Cut hukum</b>: no hukum at first; the first card played off-suit sets it.</li>
          <li>Capture the <b>mindis</b> (tens). More mindis wins the hand; if they split evenly, more haath (tricks) wins.</li>
          <li>Points: win <b>${M.POINTS.win}</b> · Mindi Coat (all tens) <b>${M.POINTS.mindikot}</b> · Full Coat (every haath) <b>${M.POINTS.fullcoat}</b>.</li>
          <li>6 players: the 2s are removed (8 cards each). 8 players: two decks (13 each); of two equal cards the first played wins.</li>
        </ul>
      </details>
    </div>`;
  const nm = document.getElementById('nm');
  const needName = () => { myName = cleanName(nm.value); store.set('mc.name', myName); if (!myName) { nm.focus(); toast('Enter your name first'); } return !!myName; };
  app.querySelectorAll('#nseg [data-n]').forEach(b => b.onclick = () => { menuN = +b.dataset.n; store.set('mc.n', menuN); renderMenu(); });
  nm.oninput = () => { myName = cleanName(nm.value); store.set('mc.name', myName); };
  document.getElementById('create').onclick = () => { if (needName()) hostStart(newRoom(menuN, false)); };
  document.getElementById('solo').onclick = () => {
    if (!needName()) return;
    const room = newRoom(menuN, true);
    hostStart(room);
    hostBegin();
  };
  const doJoin = code => { code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); if (code.length !== 5) return toast('Room codes have 5 letters'); if (needName()) guestJoin(code); };
  document.getElementById('join').onclick = () => doJoin(document.getElementById('code').value);
  document.getElementById('code').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(e.target.value); });
  if (join) document.getElementById('joinLink').onclick = () => doJoin(join);
  if (resumable) {
    document.getElementById('resume').onclick = () => {
      const room = resumable;
      room.seats.forEach(s => { if (s && s.kind === 'human') s.online = s.id === clientId; });
      H = { code: room.code, room, conns: new Map(), peer: null, timer: null };
      S.role = 'host';
      if (!room.offline) openHostPeer(true);
      hostChanged();
    };
    document.getElementById('forget').onclick = () => { store.del('mc.hostRoom'); renderMenu(); };
  }
}

function renderConnecting() {
  app.innerHTML = `<div class="menu">${brand()}<div class="panel center"><div class="spinner"></div><p>${esc(S.status || 'Connecting…')}</p>
    <button class="btn" id="cancel">Cancel</button></div></div>`;
  document.getElementById('cancel').onclick = leave;
}

function renderLobby() {
  const room = S.room, host = S.role === 'host';
  const seatCard = i => {
    const s = room.seats[i], mine = i === S.mySeat;
    let body, act = '';
    if (!s) {
      body = '<span class="muted">Empty</span>';
      if (S.mySeat !== i) act += `<button class="btn sm" data-sit="${i}">Sit here</button>`;
      if (host) act += `<button class="btn sm ghost" data-bot="${i}">+ Computer</button>`;
    } else if (s.kind === 'bot') {
      body = `<b>${esc(s.name)}</b> <span class="muted">🤖 computer</span>`;
      if (host) act += `<button class="btn sm ghost" data-bot="${i}">Remove</button>`;
      if (!mine) act += `<button class="btn sm" data-sit="${i}">Sit here</button>`;
    } else {
      body = `<b>${esc(s.name)}</b>${mine ? ' <span class="chip">You</span>' : ''}${i === 0 && !mine ? ' <span class="chip">Host</span>' : ''}${s.online ? '' : ' <span class="muted">(offline)</span>'}`;
    }
    return `<div class="seat-slot ${mine ? 'me' : ''}"><span class="num">${i + 1}</span><div class="who">${body}</div><div class="acts">${act}</div></div>`;
  };
  const humans = room.seats.filter(s => s && s.kind === 'human').length;
  app.innerHTML = `
    <div class="menu wide">
      <header class="bar">${brand()}<span class="spacer"></span><button class="btn ghost" id="leave">${host ? 'Close room' : 'Leave'}</button></header>
      ${S.status ? `<div class="status">${esc(S.status)}</div>` : ''}
      <div class="panel">
        <div class="code-row">
          <div><div class="lbl">Room code</div><div class="bigcode">${esc(room.code)}</div></div>
          <div class="row">
            <button class="btn" id="copy">Copy invite link</button>
            ${navigator.share ? '<button class="btn" id="share">Share…</button>' : ''}
          </div>
        </div>
        <input class="invite-link" id="invlink" readonly value="${esc(shareUrl(room.code))}" aria-label="Invite link">
        <p class="hint">Friends open the link (or this site and type the code) on their phone. Partners sit opposite: seats in the same column are a team.</p>
      </div>
      <div class="teams">
        ${[0, 1].map(t => `<div class="panel team t${t}"><h2><span class="tdot"></span>${TEAM[t].name}</h2>
          ${Array.from({ length: room.n }, (_, i) => i).filter(i => i % 2 === t).map(seatCard).join('')}</div>`).join('')}
      </div>
      <div class="panel">
        ${host ? `<div class="lbl">Hukum for the first hand</div>${modeSeg(room.nextMode)}
          <div class="row" style="margin-top:14px"><button class="btn primary big" id="start">Start game</button>
          <span class="hint">${humans} player${humans === 1 ? '' : 's'} joined; empty seats get computer players.</span></div>`
        : `<p class="center muted">Waiting for the host to start… Hukum for the first hand: <b>${room.nextMode === 'band' ? 'Band hukum' : 'Cut hukum'}</b></p>`}
      </div>
    </div>`;
  document.getElementById('leave').onclick = leave;
  const inv = document.getElementById('invlink');
  inv.onclick = () => inv.select();
  document.getElementById('copy').onclick = async () => {
    if (await copyText(shareUrl(room.code))) toast('Invite link copied');
    else { inv.focus(); inv.select(); toast('Couldn’t copy automatically: the link is selected, copy it from the box'); }
  };
  const sh = document.getElementById('share');
  if (sh) sh.onclick = () => navigator.share({ title: 'Mindi Coat', text: `Join my Mindi Coat room ${room.code}`, url: shareUrl(room.code) }).catch(() => {});
  app.querySelectorAll('[data-sit]').forEach(b => b.onclick = () => doSit(+b.dataset.sit));
  app.querySelectorAll('[data-bot]').forEach(b => b.onclick = () => hostToggleBot(+b.dataset.bot));
  wireModeSeg();
  const st = document.getElementById('start'); if (st) st.onclick = hostBegin;
}
const modeSeg = mode => `<div class="seg mode" id="modeseg">
  <button type="button" data-mode="band" aria-pressed="${mode === 'band'}">Band hukum<small>one card hidden</small></button>
  <button type="button" data-mode="cut" aria-pressed="${mode === 'cut'}">Cut hukum<small>first cut sets it</small></button></div>`;
function wireModeSeg() { app.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => hostSetMode(b.dataset.mode)); }

// Seat positions around the felt: you at the bottom, the next player to your right (counter-clockwise)
function seatPos(rel, n, rx, ry) {
  const a = (90 - rel * 360 / n) * Math.PI / 180;
  return { x: 50 + rx * Math.cos(a), y: 50 + ry * Math.sin(a) };
}

function renderTable() {
  const room = S.room, v = S.view, host = S.role === 'host';
  const me = S.mySeat ?? 0, n = room.n;
  const rel = i => (i - me + n) % n;
  const trumpKnown = v.trump;
  const isMyTurn = v.turn === S.mySeat && v.phase === 'play';
  const ledSuit = v.trick.length ? M.parse(v.trick[0].card).s : null;
  const showTrick = S.showLast && v.lastTrick && !v.trick.length ? v.lastTrick.cards : v.trick;
  const wide = innerWidth >= 700;

  // Hukum indicator
  let hukum;
  if (v.trumpOpen) hukum = `<span class="hk open ${M.SUIT_INFO[v.trump].red ? 'red' : ''}">${sym(v.trump)} ${M.SUIT_INFO[v.trump].name}</span>`;
  else if (v.mode === 'band') hukum = v.hiddenSeat == null ? '<span class="hk muted">being chosen…</span>'
    : `<span class="hk">${v.hiddenCard ? `hidden: <b class="${M.SUIT_INFO[v.trump].red ? 'red' : ''}">${sym(v.trump)} ${M.SUIT_INFO[v.trump].name}</b> (yours)` : `hidden with ${esc(v.hiddenSeat === S.mySeat ? 'you' : seatName(room, v.hiddenSeat))}`}</span>`;
  else hukum = '<span class="hk muted">not cut yet</span>';

  const others = Array.from({ length: n }, (_, i) => i).filter(i => i !== S.mySeat);
  const seatsHtml = others.map(i => {
    const p = seatPos(rel(i), n, wide ? 42 : 35, 40), s = room.seats[i], t = M.team(i);
    const turn = (v.phase === 'play' && v.turn === i) || (v.phase === 'hide' && v.leader === i);
    return `<div class="pseat t${t} ${turn ? 'turn' : ''} ${s.online ? '' : 'off'}" style="left:${p.x}%;top:${p.y}%">
      <div class="pname">${esc(s.name)}${s.kind === 'bot' ? ' 🤖' : ''}</div>
      <div class="pinfo">${M.team(i) === M.team(me) && S.mySeat != null ? '<span class="pt">partner</span>' : ''}<span class="cnt" title="Cards left">${v.counts[i]} cards</span>${i === v.dealer ? '<span class="dl" title="Dealer">D</span>' : ''}${v.hiddenSeat === i && !v.trumpOpen ? '<span class="hidhk" title="Holds the hidden hukum"></span>' : ''}${s.online ? '' : '<span class="muted">offline</span>'}</div>
    </div>`;
  }).join('');
  const seenCards = renderTable.seen || new Set();
  renderTable.seen = new Set(showTrick.map(t => t.card));
  const trickHtml = showTrick.map((t, k) => {
    const p = seatPos(rel(t.seat), n, n === 8 ? 24 : 20, n === 8 ? 25 : 23);
    const win = S.showLast && v.lastTrick && t.seat === v.lastTrick.winner;
    return `<div class="tcard ${win ? 'win' : ''} ${seenCards.has(t.card) ? '' : 'fresh'}" style="left:${p.x}%;top:${p.y}%;z-index:${k + 1}">${cardHtml(t.card)}</div>`;
  }).join('');

  let centerMsg = '';
  if (v.phase === 'hide') centerMsg = v.mustHide ? 'Choose a card to hide as <b>hukum</b> ↓' : `${esc(seatName(room, v.leader))} is choosing the hukum…`;
  else if (v.phase === 'play' && !v.trick.length && !S.showLast) centerMsg = v.turn === S.mySeat ? 'Your lead' : `${esc(seatName(room, v.turn))} to lead`;

  // My hand
  const hand = v.hand;
  const cw = Math.min(64, Math.max(44, Math.floor(innerWidth / 8.5)));
  const avail = Math.min(innerWidth, 980) - 24;
  const step = hand.length > 1 ? Math.min(cw + 4, (avail - cw) / (hand.length - 1)) : cw;
  const handHtml = hand.map(c => {
    const legal = (isMyTurn && v.legal.includes(c)) || v.mustHide;
    return cardHtml(c, `${legal ? 'legal' : ''} ${(isMyTurn || v.mustHide) && !legal ? 'dim' : ''}`, `data-card="${c}" style="margin-left:${(step - cw).toFixed(1)}px"`);
  }).join('');

  let prompt = '';
  if (S.mySeat == null) prompt = 'You are watching';
  else if (v.mustHide) prompt = '<b>Band hukum:</b> tap a card to hide it. Its suit will be hukum.';
  else if (isMyTurn) prompt = ledSuit && v.legal.some(c => M.parse(c).s === ledSuit) ? `Your turn: follow <b class="${M.SUIT_INFO[ledSuit].red ? 'red' : ''}">${sym(ledSuit)} ${M.SUIT_INFO[ledSuit].name}</b>` : ledSuit ? `Your turn: no ${sym(ledSuit)}, play any card${v.canOpen ? ' or open the hukum' : ''}` : 'Your turn: lead any card';
  else if (v.phase === 'play') prompt = `Waiting for ${esc(seatName(room, v.turn))}…`;

  const teamBox = t => `<div class="tbox t${t}">
    <div class="tname"><span class="tdot"></span>${TEAM[t].short}${t === M.team(me) && S.mySeat != null ? ' (you)' : ''}</div>
    <div class="tstat"><span title="Haath (tricks)">${v.tricks[t]} haath</span>
      <span class="mindis">${v.tens[t].length ? v.tens[t].map(c => `<span class="mini ${M.SUIT_INFO[M.parse(c).s].red ? 'red' : ''}">10${sym(M.parse(c).s)}</span>`).join('') : '<span class="muted">no mindi</span>'}</span></div>
    <div class="pts">${room.series.points[t]} pts</div></div>`;

  app.innerHTML = `
    <div class="game">
      <header class="gbar">
        <button class="btn ghost sm" id="leave">✕</button>
        <div class="ginfo"><b>${room.offline ? 'Practice' : 'Room ' + esc(room.code)}</b> · Hand ${room.handNo} · ${v.mode === 'band' ? 'Band' : 'Cut'} hukum</div>
        <div class="hukum">Hukum <span class="gu">હુકમ</span>: ${hukum}</div>
      </header>
      ${S.status ? `<div class="status">${esc(S.status)}</div>` : ''}
      <div class="felt n${n}">
        <div class="rangoli"></div>
        ${seatsHtml}
        ${trickHtml}
        ${centerMsg ? `<div class="cmsg">${centerMsg}</div>` : ''}
        ${v.lastTrick && v.phase === 'play' ? `<button class="btn sm ghost lastbtn" id="last">${S.showLast ? 'Hide last haath' : 'Last haath'}</button>` : ''}
      </div>
      <div class="mebar ${isMyTurn || v.mustHide ? 'myturn' : ''}">
        <div class="mename t${M.team(me)}"><span class="tdot"></span>${esc(S.mySeat != null ? room.seats[S.mySeat].name : 'Spectator')}${S.mySeat === v.dealer ? ' <span class="dl">D</span>' : ''}</div>
        <div class="prompt">${prompt}</div>
        ${v.canOpen ? '<button class="btn primary" id="open">Open hukum <span class="gu">હુકમ ખોલો</span></button>' : ''}
      </div>
      <div class="hand" style="--cw:${cw}px">${handHtml || (S.mySeat != null && v.phase !== 'done' ? '<span class="muted">No cards</span>' : '')}</div>
      <div class="scores">${teamBox(0)}${teamBox(1)}</div>
      ${v.phase === 'done' ? resultHtml(room, v, host) : ''}
    </div>`;

  document.getElementById('leave').onclick = leave;
  const lb = document.getElementById('last'); if (lb) lb.onclick = () => { S.showLast = !S.showLast; render(); };
  const ob = document.getElementById('open'); if (ob) ob.onclick = () => doAct({ type: 'open' });
  app.querySelectorAll('.hand [data-card]').forEach(el => el.onclick = () => {
    if (v.mustHide) return doAct({ type: 'hide', card: el.dataset.card });
    if (isMyTurn && v.legal.includes(el.dataset.card)) { S.showLast = false; doAct({ type: 'play', card: el.dataset.card }); }
    else if (isMyTurn) toast(`Follow ${sym(ledSuit)} ${M.SUIT_INFO[ledSuit].name} if you can`);
  });
  if (v.phase === 'done') {
    wireModeSeg();
    const nb = document.getElementById('next'); if (nb) nb.onclick = hostNextHand;
  }
}

function resultHtml(room, v, host) {
  const r = v.result, me = S.mySeat;
  const mine = me != null && r.winner === M.team(me);
  const head = r.winner == null ? 'Barabar! (draw)' : `${TEAM[r.winner].name} jitya!`;
  const big = r.kind === 'mindikot' || r.kind === 'fullcoat';
  const hist = room.series.hands.slice(-6).reverse().map(h => `<tr><td>#${h.no}</td><td>${h.mode === 'band' ? 'Band' : 'Cut'}</td>
    <td>${h.winner == null ? 'Draw' : TEAM[h.winner].short}</td><td>${h.kind === 'mindikot' ? 'Mindi Coat' : h.kind === 'fullcoat' ? 'Full Coat' : h.kind === 'draw' ? '–' : h.tens.join('–') + ' mindi'}</td><td>${h.points ? '+' + h.points : ''}</td></tr>`).join('');
  return `<div class="overlay"><div class="result panel ${big ? 'big' : ''}">
    <div class="rhead t${r.winner ?? ''}">${head}</div>
    <div class="rkind">${big ? '🎉 ' : ''}${KIND_TEXT[r.kind]}${r.points ? ` · <b>+${r.points}</b> point${r.points > 1 ? 's' : ''}` : ''}</div>
    ${me != null && r.winner != null ? `<div class="muted">${mine ? 'Shabash! Your team won this hand.' : 'Arere! Next one is yours.'}</div>` : ''}
    <div class="rgrid">
      ${[0, 1].map(t => `<div class="t${t}"><div class="tname"><span class="tdot"></span>${TEAM[t].short}</div><div><b>${r.tens[t]}</b> mindi · <b>${r.tricks[t]}</b> haath</div><div class="pts">${room.series.points[t]} pts total</div></div>`).join('')}
    </div>
    <table class="hist"><thead><tr><th>Hand</th><th>Hukum</th><th>Won</th><th>How</th><th>Pts</th></tr></thead><tbody>${hist}</tbody></table>
    <div class="muted" style="margin:8px 0">Next dealer: <b>${esc(seatName(room, r.nextDealer))}</b></div>
    ${host ? `<div class="lbl">Hukum for the next hand</div>${modeSeg(room.nextMode)}<button class="btn primary big" id="next" style="margin-top:12px;width:100%">Deal next hand</button>`
      : `<p class="muted">Waiting for the host to deal (next: <b>${room.nextMode === 'band' ? 'Band' : 'Cut'} hukum</b>)…</p>`}
  </div></div>`;
}

/* ---------------- boot ---------------- */
window.addEventListener('resize', () => { if (S.room && S.room.started) render(); });
window.addEventListener('hashchange', () => { if (!S.role) render(); });
// Hosts keep the game in this tab; warn before closing it by accident
window.addEventListener('beforeunload', e => { if (S.role === 'host' && S.room && !S.room.offline && S.room.started) { e.preventDefault(); e.returnValue = ''; } });
render();
// A guest whose page reloaded mid-game goes straight back to their seat
(() => {
  const code = (location.hash.match(/join=([A-Z0-9]{5})/i) || [])[1];
  const last = store.get('mc.lastJoin');
  if (code && myName && last && last.code === code.toUpperCase() && Date.now() - last.at < 6 * 3600e3) guestJoin(code.toUpperCase());
})();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
