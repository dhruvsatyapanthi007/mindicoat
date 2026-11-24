# ♠ Mindi Coat · મીંડી કોટ

Play **Mindi Coat** (Mendikot) with friends on your phones, or practise against computer players.
No server and no account needed: the room creator's browser runs the game and everyone else connects to it peer-to-peer.

## Play

- **Create a room**: pick 4, 6 or 8 players and share the 5-letter code or the invite link. Friends open the link on their phones.
  Partners sit opposite (same column in the lobby); empty seats get computer players.
- **Practise vs computer**: you plus computer players, works offline too.
- **Install it as an app**: open the site on your phone, then *Share → Add to Home Screen* (iPhone) or *Install app* (Android/Chrome).
  It opens full screen with its own icon.

## Rules used

- Two teams; follow the suit led if you can. Highest hukum (trump) wins the haath (trick), else the highest card of the suit led.
- **Hukum, chosen each hand by the host:**
  - *Band hukum*: the first player hides one card face down; its suit is hukum. A player who can't follow suit may open it,
    and the card goes back to its owner. If its owner runs out of cards first, it opens automatically.
  - *Cut hukum*: no hukum at first; the first card played off-suit sets it.
- Capture the **mindis** (tens). More mindis wins the hand; if they're split evenly, more haath wins (6 players can draw).
- **Points:** win 1 · **Mindi Coat** (all the tens) 3 · **Full Coat** (every haath) 5.
- The losing side keeps the deal: if the dealer's team wins, the deal passes to the next player.
- 4 players: 52 cards, 13 each. 6 players: the 2s are removed, 8 each. 8 players: two decks, 13 each; of two equal cards the first played wins.

## How it works

| File | What it is |
| --- | --- |
| `engine.js` | Rules engine: dealing, legal moves, hukum, tricks, scoring. Pure functions shared by everything else |
| `bot.js` | Computer player; it only uses what that seat could know |
| `app.js` | Lobby, rooms over WebRTC ([PeerJS](https://peerjs.com), MIT), and the table |
| `index.html` | Page and styles |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installable app (PWA) and offline support |
| `tests.html` | Rules tests: unit checks plus 2,400 simulated hands across 4/6/8 players and both hukum modes |
| `fonts/` | Rozha One, Mukta, Mukta Vaani (SIL Open Font License) |

Notes:
- The host's tab holds the game. If the host closes it, they can **Resume** from the menu and friends reconnect on their own;
  a player who drops out also gets their seat back by reopening the link. A dropped player's turn is auto-played after 15 seconds.
- Connections use PeerJS's free public connection broker. A few strict networks (some offices or schools) can block peer-to-peer.

Run locally: `python3 -m http.server 8770`, then open http://localhost:8770 (and `/tests.html` for the tests).
