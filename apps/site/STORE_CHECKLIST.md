# App store registration checklist (owner, not published)

Everything Apple (App Store Connect) and Google (Play Console) ask for, with the URL or answer
this site provides. Placeholders on the site are `[IN BRACKETS]` with a dashed yellow frame; search
the built site for `class="ph"` to find them all.

## Before submitting

- [ ] Imprint data is complete (INCEPTUM e.U., FN 400396v, ATU68207022, Brunellengasse 1/3, 1220
      Vienna, hello@daisychess.org). Still to check: any remaining `[IN BRACKETS]` placeholders
      (`class="ph"` in the built site), e.g. `[COMPETENT COURT, AUSTRIA]`, hosting provider, log
      retention (`[7 days]` journal, `[14 days]` nginx — confirm on the host), publication date.
- [ ] Remove the `draft-banner` blocks on /privacy/, /terms/, /imprint/, /app-privacy/ once reviewed.
- [ ] Have the privacy policy and terms reviewed (they are drafts, not legal advice).
- [ ] Decide the three `[OWNER: check]` items on /app-privacy/ (usage counters, sharing with node operators).
- [ ] Make sure hello@daisychess.org receives mail and is monitored (both stores require a reachable support contact).
- [ ] Repo URL: change `REPO_URL` in `apps/site/site.config.ts` once the repo is renamed.

## URLs

| Field                       | Apple                                    | Google                                          | URL                                 |
| --------------------------- | ---------------------------------------- | ----------------------------------------------- | ----------------------------------- |
| Privacy policy              | required                                 | required                                        | https://daisychess.org/privacy/     |
| Support URL                 | required                                 | (contact website)                               | https://daisychess.org/support/     |
| Marketing URL               | optional                                 | website                                         | https://daisychess.org/             |
| Account / data deletion URL | (only with accounts)                     | required ("Delete account URL" / data deletion) | https://daisychess.org/delete-data/ |
| Terms (EULA)                | optional (Apple standard EULA otherwise) | optional                                        | https://daisychess.org/terms/       |
| App privacy answers         | App Privacy section                      | Data safety form                                | https://daisychess.org/app-privacy/ |

## Contact details

- Support e-mail (both stores, shown publicly on Google Play): hello@daisychess.org
- Apple: contact name, phone and e-mail for App Review; a demo account is **not** needed (no login
  required); explain in the review notes that server analysis needs a token and that the browser
  engine works without one. If a feature needs a token for review, create a reviewer token in the portal.
- Google: developer address (shown publicly for EU traders under the DSA — decide trader status:
  a free app without monetisation is usually "not a trader").

## Content rating / age rating

- Apple age rating questionnaire: no objectionable content in all categories; **unrestricted web
  access: no** (the app opens only its own and lichess/chess.com APIs); user-generated content:
  friend games show nicknames (no chat) → answer "no" to user-generated content/messaging unless chat
  is added. Expected rating **4+**.
- Google IARC questionnaire: category "Reference, News, or Educational" or "Game → Board"; no
  violence, no gambling (chess is not simulated gambling), no user interaction beyond nicknames in a
  friend game (declare "Users can interact" if in doubt), no location sharing, no purchases. Expected
  **Everyone / PEGI 3 / USK 0**.
- Target audience (Google): 13+ or 18+ — DaisyChess is **not directed at children**; choosing an
  under-13 audience triggers the Families policy.

## Export compliance (encryption)

- Uses only standard encryption via the OS (HTTPS/TLS, WSS). Apple: answer "Yes, uses encryption"
  → "only exempt encryption (standard protocols)" → no documentation; set
  `ITSAppUsesNonExemptEncryption = false` in Info.plist. Google: no export questionnaire beyond the
  standard declaration.

## Other declarations

- Ads: **No ads** (Google "Contains ads": no). In-app purchases: none. Price: free.
- Google "App access": see the paste-ready text below.
- Google Data safety: see /app-privacy/ (encrypted in transit: yes; deletion request: yes).
- Apple App Privacy: "Data Not Linked to You" per /app-privacy/; Tracking: no; no ATT prompt.
- Licences: the app bundles GPL-3.0 code (chessground, Stockfish WASM). Decision, mitigation and
  the EULA rationale: docs/DECISIONS.md ADR-022 §3. The app's Settings → About → Licences shows
  version, commit, the link to the `mobile-v<version>` tag and the full GPL text offline. The
  Google Play description must also say "free software, GPL-3.0-or-later, source:
  https://github.com/refaustria/daisychess".

## App Store Connect: custom EULA (paste verbatim)

App Information → License Agreement → "Edit" → "Custom License Agreement":

```
DaisyChess is free software. It is licensed under the GNU General Public License, version 3 or
(at your option) any later version (GPL-3.0-or-later). You may use, study, modify and
redistribute it under the terms of that licence. The complete corresponding source code of every
release is public at https://github.com/refaustria/daisychess (the release for app version X.Y.Z
is the tag "mobile-vX.Y.Z"). The full licence text and the notices of the third-party components
(for example Stockfish and chessground, both GPL) are included in the app under Settings, About,
Licences, and work offline.

Nothing in Apple's Media Services Terms and Conditions, the Apple Developer Program License
Agreement or the App Store usage rules, and nothing in this notice, restricts the rights that the
GNU General Public License grants you. If a term of the App Store conflicts with the GPL, the GPL
prevails for your use of this software, to the extent permitted by law.

DaisyChess is provided without warranty, to the extent permitted by law, as set out in sections
15 and 16 of the GPL. Provider: INCEPTUM e.U., Brunellengasse 1/3, 1220 Vienna, Austria
(owner: Bojan Savicevic), hello@daisychess.org. Privacy policy: https://daisychess.org/privacy/.
```

## App Review notes (App Store Connect → App Review Information → Notes; paste verbatim)

```
DaisyChess is a free chess analysis app: board, move list, game review with accuracy and an
evaluation graph, an openings trainer and play against the engine. No account is needed and
there is no login screen; a demo account is therefore not provided.

The app works fully offline with the bundled Stockfish engine (WebAssembly, single-threaded).
Optional stronger analysis runs on our server (Settings, "Server analysis"). That feature needs
an access token. A review token that works for this review:

    <REVIEW_TOKEN>

Enter it in Settings, "Server analysis" (or open the link
https://play.daisychess.org/#setup-token=<REVIEW_TOKEN> on the device). Without the token
everything else, including engine analysis, review and the trainer, still works offline.

"Connect lichess" (Settings) is an optional import of the user's own public games from
lichess.org via OAuth in the system browser. It is not an account of this app (the app has no
accounts, no registration and no own login), so Sign in with Apple (guideline 4.8) does not
apply. The app collects no personal data for tracking, has no ads, no analytics SDKs, no
in-app purchases and no subscriptions, and does not use the App Tracking Transparency framework.

The app is free software under GPL-3.0-or-later; the source of this build is public at
https://github.com/refaustria/daisychess (tag mobile-v<VERSION>). Encryption: standard HTTPS/WSS
only (ITSAppUsesNonExemptEncryption = false). Contact: hello@daisychess.org.
```

## Google Play: App access (Policy → App content → App access; paste verbatim)

Choose "All or some functionality in my app is restricted" only if you want the reviewers to test
server analysis; otherwise choose "All functionality is available without special access". The
recommended instruction text (one instruction set, name "Server analysis token"):

```
No login or account is needed; all main functionality (board, offline engine analysis, game
review, openings trainer) works without any access. Optional server analysis needs an access token:
open Settings, "Server analysis", and paste this token: <REVIEW_TOKEN>
(or open https://play.daisychess.org/#setup-token=<REVIEW_TOKEN> on the device).
"Connect lichess" is optional and is not an account of this app. No ads, no purchases.
```

`<REVIEW_TOKEN>` is created by the owner in the portal (a dedicated, revocable token for
reviewers; revoke it after the review).

## Store listing assets

- App icon: 1024×1024 (Apple, no transparency) and 512×512 (Google) from `apps/web/public/brand/daisy.svg`
  (render with `apps/web/scripts/render-brand.mjs`, white or ivory background).
- Google feature graphic 1024×500 (adapt `apps/site/tools/og.html`).
- Screenshots (both light and dark if possible):
  - iPhone 6.9" (1320×2868 or 1290×2796) — at least 3: board with eval bar and lines; review with
    accuracy and graph; openings trainer drill; play vs Maia with clocks; friend game link.
  - iPad 13" (2064×2752 or 2048×2732) — same set, landscape board + panel.
  - Android phone (16:9 or 9:16, min 1080 px) — 4–8 screenshots; 7" and 10" tablet sets.
- Short description (Google, 80 chars): "Free chess analysis: Stockfish, game review, openings trainer. No ads."
- Promotional text / subtitle (Apple, 30 chars): "Chess analysis, no ads".
- Keywords (Apple, 100 chars): chess,stockfish,analysis,review,openings,trainer,maia,pgn,lichess,board
