# DaisyChess privacy notice

This notice explains in plain language what data DaisyChess handles, for players of the web app and for people who run or use community engine nodes. It applies to the hub run at **play.daisychess.org** (web app and operator portal; community nodes connect to hub.daisychess.org). 

## 1. Who is responsible

Data controller: **INCEPTUM e.U. (owner Bojan Savicevic)**, **Brunellengasse 1/3, 1220 Vienna, Austria**, contact: **hello@daisychess.org**.

## 2. The short version

- DaisyChess is free, has **no ads and no tracking**: no analytics, no third-party trackers, no fingerprinting, no data sales.
- The web app keeps your settings in your own browser. You do not need an account to play or analyse in the browser.
- If you analyse on a **server** or a **community node**, the chess positions you send are processed there. On a community node the **node operator can see those positions** (see section 5).
- Operators of nodes log in with lichess; the hub stores their lichess id and username.
- IP addresses are not stored in the hub's application logs. The web server's access log does contain them for a limited time (section 4).

## 3. What the hub stores

| Data | Whose | Purpose | How long |
|---|---|---|---|
| lichess user id and username, first and last login time | node operators | Identify the operator, show the operator name next to a node, administration | Until the operator deletes the account in the portal |
| Nodes: name, pool settings, hashed node secret, last seen time, version, architecture | operators | Routing and portal | Until the node or the account is deleted |
| Tokens: id, label chosen by the operator, hashed secret, which nodes it may use, expiry, last used time, number of uses | operators (and the people they give tokens to, indirectly) | Access control and routing | Until revoked/deleted; pool tokens expire after a default period |
| Usage counters per token, node and day (searches, sessions, engine seconds) | token holders (pseudonymous) | Fair-use budget and the operator's usage view | 90 days (`USAGE_RETENTION_DAYS`) |
| Spot-check results (node id, time, agreed yes/no) | nodes | Quality control of the shared pool | 24 hours |
| Portal login sessions | operators | Keep you logged in | 30 days or until logout |
| Game reviews and position evaluations in the review store | nobody in particular | Re-use of finished analyses | Until evicted by the size limit |
| Application log (journal): token id, node id, connection id, error events, a **daily-salted hash** of the client address | players, operators | Operating and debugging the service | See the retention row below |
| Web server access log: client IP address, time, request path (no query string, no body), status, `Origin` and User-Agent | everyone who visits | Security (abuse detection, fail2ban) | Stock log rotation, **14 days by default on the current host (deploy README)**

Notes:

- Token labels are free text written by the operator. Please do not put real names in them.
- **Reviews** contain moves and evaluations only, keyed by a hash of the game. They contain no player names, PGN headers or addresses. Anyone who knows a game can look up its review; do not rely on reviews being secret.
- **Application logs** do not contain raw IP addresses, tokens or secrets. The salted hash changes every day and cannot be reversed to an address; it only lets the operator see that several events came from the same address on the same day. Chess positions (FEN) are logged only if the server is run at debug level, which is not the default. The server logs into its own journal namespace, which deletes entries after 7 days.
- **Rooms** ("play a friend") live in server memory only: nicknames and moves of a game disappear when the room expires (minutes to hours).
- The hub does **not** store e-mail addresses, passwords or payment data. There are none.
- Backups of the hub database contain the operator data above and are kept for 7 days.

## 4. Where your IP address appears

Every web server records the address of the connection. Here: the nginx access log (security purposes, legitimate interest under Art. 6(1)(f) GDPR) and, hashed with a daily salt, the application log. IP addresses are used to limit abuse (per-address session and connection limits) and to ban abusive clients. They are not passed to node operators.

## 5. Community nodes: who sees what

When you analyse on a **community node**, the hub relays your search to the machine of a volunteer operator.

- The operator's node **receives the chess positions (FEN strings) and search settings** you analyse (including the moves of a game under review, one position at a time). That is inherent in how the service works. A position can be personal: a game in progress, your opening preparation. If you do not want a stranger's machine to see it, use the in-browser engine, your own node or the hub's own engines.
- The node does **not** receive your IP address, name, lichess account, PGN headers or token. For shared-pool searches the node cannot tell who you are; for tokens issued by the operator it can see the token's id and label.
- The app shows which node and operator a search runs on, and shows a notice before your first search on a shared-pool node.
- Operators agree in the [terms](./TERMS.md) not to log, keep or misuse positions. The hub cannot technically prevent a dishonest operator from doing so. The hub checks result quality (spot-checks), not privacy.
- **Pool privacy notice (as shown in the app):** "Searches in the shared pool run on volunteers' computers. The operator of that computer can see the positions you analyse, but not who you are."

## 6. lichess login and imports

- **Operator portal:** you log in with lichess (OAuth with PKCE). The hub receives the lichess access token **once**, asks lichess who you are (your user id and username), then **discards the token**; the portal also revokes it at lichess. The token is not stored.
- **Web app (optional):** if you log in with lichess in the app to import your games, the token stays in your browser and is sent only to lichess.
- Importing games from lichess or chess.com sends the username you type to those services' public APIs from your browser; their privacy policies apply.

## 7. Cookies and local storage

- The portal sets **one cookie**, `__Host-dc_portal`: a login session identifier, HttpOnly, Secure, SameSite=Strict, valid up to 30 days. It is strictly necessary for the login, so no consent banner is required. The web app and the player side set no cookies.
- The web app uses your browser's **localStorage / IndexedDB** for settings (theme, board, engine choices, access token for the server, review cache). It never leaves your device unless you use a feature that says so (for example a setup link you copy yourself). Clear it in your browser's site settings.

## 8. Sharing and processors

Data is not sold or shared for advertising. The hub is hosted on a virtual server rented from Nessus GmbH, Austria (hosting provider, acting as processor). lichess receives the one login call described above. Node operators receive positions as described in section 5. Disclosure to authorities only where legally required.

## 9. Your rights

Under the GDPR you may request **access**, **rectification**, **erasure**, **restriction**, **portability** and you may **object** to processing based on legitimate interest. Operators can delete their account, nodes and tokens themselves in the portal, which removes the lichess id and username from the live database (backups are overwritten within 7 days). For other requests write to **hello@daisychess.org**. Because logs and counters are pseudonymous, we may ask for the token id or the approximate time to find your data. You may also complain to the Austrian data protection authority (Datenschutzbehörde, <https://www.dsb.gv.at>).

## 10. Children

DaisyChess is a general-purpose chess tool and not aimed at children; it collects no data about age.

## 11. Changes

We will update this notice when the service changes and note the date here: **Last updated: 2026-10-26**.
