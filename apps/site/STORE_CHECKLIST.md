# App store registration checklist (owner, not published)

Everything Apple (App Store Connect) and Google (Play Console) ask for, with the URL or answer
this site provides. Placeholders on the site are `[IN BRACKETS]` with a dashed yellow frame; search
the built site for `class="ph"` to find them all.

## Before submitting

- [ ] Fill the remaining placeholders (owner name, Vienna address and hello@daisychess.org are in
      already, from docs/PRIVACY.md): `[COMPETENT COURT, AUSTRIA]`, imprint street/phone/legal form/
      register/UID/trade, hosting provider, log retention (`[7 days]` journal, `[14 days]` nginx —
      confirm on the host), publication date.
- [ ] Remove the `draft-banner` blocks on /privacy/, /terms/, /imprint/, /app-privacy/ once reviewed.
- [ ] Have the privacy policy and terms reviewed (they are drafts, not legal advice).
- [ ] Decide the three `[OWNER: check]` items on /app-privacy/ (usage counters, sharing with node operators).
- [ ] Make sure hello@daisychess.org receives mail and is monitored (both stores require a reachable support contact).
- [ ] Repo URL: change `REPO_URL` in `apps/site/site.config.ts` once the repo is renamed.

## URLs

| Field | Apple | Google | URL |
|---|---|---|---|
| Privacy policy | required | required | https://daisychess.org/privacy/ |
| Support URL | required | (contact website) | https://daisychess.org/support/ |
| Marketing URL | optional | website | https://daisychess.org/ |
| Account / data deletion URL | (only with accounts) | required ("Delete account URL" / data deletion) | https://daisychess.org/delete-data/ |
| Terms (EULA) | optional (Apple standard EULA otherwise) | optional | https://daisychess.org/terms/ |
| App privacy answers | App Privacy section | Data safety form | https://daisychess.org/app-privacy/ |

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
- Google "App access": all functionality available without special access (token only for server analysis).
- Google Data safety: see /app-privacy/ (encrypted in transit: yes; deletion request: yes).
- Apple App Privacy: "Data Not Linked to You" per /app-privacy/; Tracking: no; no ATT prompt.
- Licences: the app bundles GPL-3.0 code (chessground, maybe Stockfish). App Store distribution of
  GPL code is contested (FSF position) — see PLAN M26-0 before bundling an engine.

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
