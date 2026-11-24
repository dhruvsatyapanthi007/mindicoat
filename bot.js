'use strict';
// Computer player. Uses only what that seat could know: its own hand, its hidden hukum card,
// cards already played, and the trump once it's open.
(function (root) {
  const M = root.Mindi;
  const { parse, suitOf, isTen, team } = M;
  const val = c => parse(c).v;
  const byLow = cs => cs.slice().sort((a, b) => val(a) - val(b));
  const low = cs => byLow(cs)[0];
  const nonTen = cs => cs.filter(c => !isTen(c));
  const safeLow = cs => low(nonTen(cs).length ? nonTen(cs) : cs);
  const bySuit = cs => cs.reduce((g, c) => ((g[suitOf(c)] ||= []).push(c), g), {});

  // Band hukum: hide a low card of the longest suit, so that suit becomes trump
  function pickHidden(hand) {
    const g = bySuit(hand);
    const best = Object.keys(g).sort((a, b) => g[b].length - g[a].length
      || g[b].reduce((s, c) => s + val(c), 0) - g[a].reduce((s, c) => s + val(c), 0))[0];
    return safeLow(g[best]);
  }

  function botAction(st, seat, rnd = Math.random) {
    const hand = st.hands[seat];
    if (st.phase === 'hide') return { type: 'hide', card: pickHidden(hand) };
    const legal = M.legalPlays(st, seat);
    const play = card => ({ type: 'play', card });
    const n = st.n, trick = st.trick;
    const knownTrump = st.trumpOpen || (st.hidden && st.hidden.seat === seat) ? st.trump : null;
    const active = st.trumpOpen ? st.trump : null;

    // Cards this seat hasn't seen yet, for "is my card the best one left?"
    const seen = new Set([...st.played, ...trick.map(t => t.card), ...hand,
      ...(st.hidden && st.hidden.seat === seat && !st.trumpOpen ? [st.hidden.card] : [])]);
    const unseen = M.fullDeck(n).filter(c => !seen.has(c));
    const isTop = c => { const p = parse(c); return !unseen.some(u => { const q = parse(u); return q.s === p.s && q.v > p.v; }); };
    const longestSuitOf = cs => { const g = bySuit(cs); return Object.keys(g).sort((a, b) => g[b].length - g[a].length)[0]; };

    // Leading
    if (!trick.length) {
      const plain = legal.filter(c => suitOf(c) !== knownTrump);
      const tops = plain.filter(isTop);
      if (tops.length) {
        // cash a sure winner, preferring suits whose ten is still out
        const withTenOut = tops.filter(c => unseen.some(u => isTen(u) && suitOf(u) === suitOf(c)));
        return play((withTenOut.length ? withTenOut : tops).sort((a, b) => val(b) - val(a))[0]);
      }
      const pool = plain.length ? plain : legal;
      const ok = nonTen(pool);
      if (ok.length) { const s = longestSuitOf(ok); return play(low(ok.filter(c => suitOf(c) === s))); }
      return play(low(pool));
    }

    const led = M.ledSuit(st);
    const trumpAfter = c => active || (st.mode === 'cut' && suitOf(c) !== led ? suitOf(c) : null);
    const beats = c => M.winnerOf([...trick, { seat, card: c }], trumpAfter(c)) === seat;
    const winSeat = M.winnerOf(trick, active);
    const winCard = trick.find(t => t.seat === winSeat).card;
    const partnerWin = team(winSeat) === team(seat);
    const last = trick.length === n - 1;
    const hasTen = trick.some(t => isTen(t.card));
    const sure = last || (isTop(winCard) && (suitOf(winCard) === active || trick.length >= n - 2));
    const tenFirst = cs => { const t = cs.filter(c => isTen(c) && suitOf(c) !== knownTrump); return t.length ? t[0] : safeLow(cs); };

    // Following suit
    if (legal.some(c => suitOf(c) === led)) {
      if (partnerWin) return play(sure ? tenFirst(legal) : safeLow(legal));
      const winners = legal.filter(beats);
      if (winners.length) {
        if (last || hasTen) return play(low(winners));
        const topW = winners.filter(isTop);
        if (topW.length) return play(low(topW));
      }
      return play(safeLow(legal));
    }

    // Can't follow suit
    if (M.canOpen(st, seat) && !partnerWin && (hasTen || rnd() < 0.5)) return { type: 'open' };
    if (partnerWin && sure) return play(tenFirst(legal));
    if (!partnerWin) {
      let winners = legal.filter(beats);
      if (winners.length && (hasTen || last || trick.length >= n / 2 || rnd() < 0.5)) {
        if (st.mode === 'cut' && !active) {
          // this card sets the trump: cut from the longest suit
          const s = longestSuitOf(hand);
          const fromLong = winners.filter(c => suitOf(c) === s);
          if (fromLong.length) winners = fromLong;
        }
        return play(safeLow(winners));
      }
    }
    // Discard: lowest non-ten, non-trump card, from the shortest suit
    const pool = legal.filter(c => suitOf(c) !== knownTrump && !isTen(c));
    if (pool.length) {
      const g = bySuit(pool);
      const s = Object.keys(g).sort((a, b) => g[a].length - g[b].length)[0];
      return play(low(g[s]));
    }
    return play(safeLow(legal));
  }

  root.MindiBot = { botAction, pickHidden };
})(typeof window !== 'undefined' ? window : globalThis);
