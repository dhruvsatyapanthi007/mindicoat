'use strict';
// Mindi Coat (Mendikot) rules engine.
// Pure state transitions: no DOM, no network. The host, the computer players and the tests share it.
//
// Seats go 0..n-1; play moves to seat+1 (drawn counter-clockwise). Partners sit opposite:
// even seats are team 0, odd seats team 1.
(function (root) {
  const SUITS = ['S', 'H', 'C', 'D'];
  const SUIT_INFO = {
    S: { sym: '♠', name: 'Kali', gu: 'કાળી', red: false },
    H: { sym: '♥', name: 'Laal', gu: 'લાલ', red: true },
    C: { sym: '♣', name: 'Fallai', gu: 'ફલ્લાઈ', red: false },
    D: { sym: '♦', name: 'Charkat', gu: 'ચરકટ', red: true },
  };
  const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  // Series points for winning a hand
  const POINTS = { win: 1, mindikot: 3, fullcoat: 5 };

  // Card ids look like "10H0": rank, suit, deck copy (0 or 1 for two decks)
  const parse = id => {
    const m = /^(10|[2-9JQKA])([SHCD])(\d)$/.exec(id);
    return { r: m[1], s: m[2], d: +m[3], v: RANKS.indexOf(m[1]) };
  };
  const suitOf = id => parse(id).s;
  const isTen = id => parse(id).r === '10';
  const team = seat => seat % 2;

  function layout(n) {
    if (n === 4) return { decks: 1, drop: [], perHand: 13 };
    if (n === 6) return { decks: 1, drop: ['2'], perHand: 8 };   // 48 cards, the 2s removed
    if (n === 8) return { decks: 2, drop: [], perHand: 13 };     // two decks, 104 cards
    throw new Error('Mindi Coat needs 4, 6 or 8 players');
  }
  function fullDeck(n) {
    const { decks, drop } = layout(n);
    const out = [];
    for (let d = 0; d < decks; d++) for (const s of SUITS) for (const r of RANKS) if (!drop.includes(r)) out.push(r + s + d);
    return out;
  }
  function shuffle(a, rnd = Math.random) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function sortHand(h) {
    return [...h].sort((a, b) => {
      const A = parse(a), B = parse(b);
      return SUITS.indexOf(A.s) - SUITS.indexOf(B.s) || B.v - A.v || A.d - B.d;
    });
  }
  const clone = st => JSON.parse(JSON.stringify(st));
  function ev(st, e) {
    st.seq = (st.seq || 0) + 1;
    st.events.push({ ...e, seq: st.seq });
    if (st.events.length > 40) st.events.shift();
  }

  // mode: 'band' (one card hidden face down as trump) or 'cut' (first card off-suit sets trump)
  function newHand(n, dealer, mode, rnd) {
    const L = layout(n);
    const deck = shuffle(fullDeck(n), rnd);
    const hands = Array.from({ length: n }, (_, i) => sortHand(deck.slice(i * L.perHand, (i + 1) * L.perHand)));
    const leader = (dealer + 1) % n;
    return {
      n, mode, dealer, leader, turn: leader, hands, perHand: L.perHand, totalTens: 4 * L.decks,
      phase: mode === 'band' ? 'hide' : 'play',   // hide -> play -> collect -> play ... -> done
      trick: [], trump: null, trumpOpen: false, hidden: null, trumpBy: null,
      tricks: [0, 0], tens: [[], []], played: [], lastTrick: null, trickNo: 1, result: null,
      events: [], seq: 0,
    };
  }

  const ledSuit = st => (st.trick.length ? suitOf(st.trick[0].card) : null);

  function legalPlays(st, seat) {
    if (st.phase !== 'play' || st.turn !== seat || seat == null) return [];
    const h = st.hands[seat];
    const led = ledSuit(st);
    if (!led) return h.slice();
    const follow = h.filter(c => suitOf(c) === led);
    return follow.length ? follow : h.slice();
  }

  // Band hukum: a player who can't follow suit may ask for the hidden trump to be opened
  function canOpen(st, seat) {
    return st.mode === 'band' && st.phase === 'play' && !st.trumpOpen && st.hidden != null && seat != null
      && st.turn === seat && st.trick.length > 0 && !st.hands[seat].some(c => suitOf(c) === ledSuit(st));
  }

  function openTrump(st, seat, forced) {
    st.trumpOpen = true;
    st.trumpBy = seat;
    st.hands[st.hidden.seat] = sortHand([...st.hands[st.hidden.seat], st.hidden.card]);
    ev(st, { type: 'open', seat, suit: st.trump, card: st.hidden.card, holder: st.hidden.seat, forced: !!forced });
  }
  // The hukum holder plays one card short. If they're out of cards on their turn, the hidden card comes back.
  function autoOpen(st) {
    if (st.mode === 'band' && !st.trumpOpen && st.hidden && st.turn === st.hidden.seat && st.hands[st.turn].length === 0) {
      openTrump(st, st.turn, true);
    }
  }

  // Highest trump wins, else highest card of the suit led. With two decks, the first of two equal cards wins.
  function winnerOf(trick, trump) {
    let best = 0;
    for (let i = 1; i < trick.length; i++) {
      const c = parse(trick[i].card), b = parse(trick[best].card);
      if ((trump && c.s === trump && b.s !== trump) || (c.s === b.s && c.v > b.v)) best = i;
    }
    return trick[best].seat;
  }

  // Player actions: {type:'hide', card} | {type:'open'} | {type:'play', card}. Returns a new state or throws.
  function act(prev, seat, a) {
    const st = clone(prev);
    if (a.type === 'hide') {
      if (st.phase !== 'hide' || seat !== st.leader) throw new Error("It isn't your turn to choose the hukum");
      const i = st.hands[seat].indexOf(a.card);
      if (i < 0) throw new Error("That card isn't in your hand");
      st.hands[seat].splice(i, 1);
      st.hidden = { seat, card: a.card };
      st.trump = suitOf(a.card);
      st.phase = 'play';
      ev(st, { type: 'hidden', seat });
      return st;
    }
    if (a.type === 'open') {
      if (!canOpen(st, seat)) throw new Error("You can open the hukum only when you can't follow suit");
      openTrump(st, seat, false);
      return st;
    }
    if (a.type === 'play') {
      if (!legalPlays(st, seat).includes(a.card)) throw new Error("You can't play that card now");
      const led = ledSuit(st);
      st.hands[seat].splice(st.hands[seat].indexOf(a.card), 1);
      if (st.mode === 'cut' && !st.trump && led && suitOf(a.card) !== led) {
        st.trump = suitOf(a.card); st.trumpOpen = true; st.trumpBy = seat;
        ev(st, { type: 'cut', seat, suit: st.trump });
      }
      st.trick.push({ seat, card: a.card });
      ev(st, { type: 'play', seat, card: a.card });
      if (st.trick.length === st.n) { st.phase = 'collect'; st.turn = null; }
      else { st.turn = (seat + 1) % st.n; autoOpen(st); }
      return st;
    }
    throw new Error('Unknown action');
  }

  // Host calls this after everyone has seen the full trick
  function collect(prev) {
    const st = clone(prev);
    if (st.phase !== 'collect') throw new Error('No trick to collect');
    const w = winnerOf(st.trick, st.trumpOpen ? st.trump : null), t = team(w);
    const tens = st.trick.map(x => x.card).filter(isTen);
    st.tricks[t]++;
    st.tens[t].push(...tens);
    st.played.push(...st.trick.map(x => x.card));
    st.lastTrick = { cards: st.trick, winner: w, tens };
    ev(st, { type: 'trick', seat: w, tens, trickNo: st.trickNo });
    st.trick = [];
    if (st.hands.every(h => h.length === 0)) finish(st);
    else { st.trickNo++; st.phase = 'play'; st.leader = st.turn = w; autoOpen(st); }
    return st;
  }

  function finish(st) {
    const a = st.tens[0].length, b = st.tens[1].length;
    const w = a > b ? 0 : b > a ? 1 : st.tricks[0] > st.tricks[1] ? 0 : st.tricks[1] > st.tricks[0] ? 1 : null;
    let kind = 'draw';
    if (w != null) {
      kind = st.tricks[w] === st.perHand ? 'fullcoat'
        : st.tens[w].length === st.totalTens ? 'mindikot'
        : st.tens[w].length > st.tens[1 - w].length ? 'tens' : 'tricks';
    }
    const points = w == null ? 0 : POINTS[kind] || POINTS.win;
    // Losing side keeps dealing: if the dealer's team won, the deal passes to the next player
    const nextDealer = w != null && w === team(st.dealer) ? (st.dealer + 1) % st.n : st.dealer;
    st.phase = 'done';
    st.turn = null;
    st.result = { winner: w, kind, points, tens: [a, b], tricks: st.tricks.slice(), nextDealer };
    ev(st, { type: 'done', winner: w, kind });
  }

  // What one seat may see (seat null = spectator)
  function viewFor(st, seat) {
    const own = seat != null && st.hidden && st.hidden.seat === seat;
    return {
      n: st.n, mode: st.mode, dealer: st.dealer, leader: st.leader, turn: st.turn, phase: st.phase,
      perHand: st.perHand, totalTens: st.totalTens, trickNo: st.trickNo,
      hand: seat != null ? st.hands[seat] : [], counts: st.hands.map(h => h.length),
      trick: st.trick, lastTrick: st.lastTrick, tricks: st.tricks, tens: st.tens,
      trump: st.trumpOpen || own ? st.trump : null, trumpOpen: st.trumpOpen, trumpBy: st.trumpBy,
      hiddenSeat: st.hidden ? st.hidden.seat : null, hiddenCard: own ? st.hidden.card : null,
      legal: legalPlays(st, seat), canOpen: canOpen(st, seat),
      mustHide: st.phase === 'hide' && seat === st.leader,
      result: st.result, events: st.events,
    };
  }

  root.Mindi = {
    SUITS, SUIT_INFO, RANKS, POINTS, parse, suitOf, isTen, team, layout, fullDeck, shuffle, sortHand,
    newHand, legalPlays, canOpen, winnerOf, act, collect, viewFor, ledSuit,
  };
})(typeof window !== 'undefined' ? window : globalThis);
