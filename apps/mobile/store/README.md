# Store assets (M26-7)

Google Play: nothing here is uploaded automatically; the owner uploads by hand after review. App Store:
`.github/workflows/store-metadata.yml` (`scripts/asc-metadata.mjs`) uploads the Apple texts, `app-store.json`
settings and the `iphone-6.9` / `ipad-13` screenshots (deploy/README.md, App Store metadata).

| What                                                                                       | Where                                                                                                                         | How it is made                                                                                                                                             |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS app icon 1024 (opaque, no alpha)                                                       | `ios/App/App/Assets.xcassets/AppIcon.appiconset/`, `store/app-store-icon-1024.png`                                            | `node scripts/render-assets.mjs`                                                                                                                           |
| Android adaptive icon (foreground, monochrome, ivory background colour) and legacy mipmaps | `android/app/src/main/res/mipmap-*`, `values/ic_launcher_background.xml`                                                      | same                                                                                                                                                       |
| Splash light + dark                                                                        | iOS `Splash.imageset` (luminosity appearances), Android `drawable-*` and `drawable-*night*`, `values-night/splash_colors.xml` | same                                                                                                                                                       |
| Play icon 512 (32-bit PNG), Play feature graphic 1024x500                                  | `store/play-icon-512.png`, `store/play-feature-graphic-1024x500.png`                                                          | same                                                                                                                                                       |
| Screenshots                                                                                | `store/screenshots/<size>/NN-<scene>-<theme>.png`                                                                             | `node scripts/store-screenshots.mjs` (needs `pnpm --filter @daisychess/web build:mobile`, `pnpm --filter @daisychess/server build`, engines in `engines/`) |
| Listing texts (English)                                                                    | `store/listing.en.json`                                                                                                       | by hand; limits checked in `test/store.test.ts`                                                                                                            |

Both scripts use Playwright/Chromium from `apps/web`, are deterministic where possible and need no image tools.
Run from `apps/mobile` (or give the full path). Options of the screenshot script: `--size`, `--scene`, `--theme`, `--out`.

Screenshot sizes (pixels): `play-phone` 1080x2160, `play-tablet-7` 1200x1920, `play-tablet-10` 2560x1600 (Google Play),
`iphone-6.9` 1320x2868, `ipad-13` 2064x2752 (App Store). Per size: 6 screenshots (reviewed game with arrows,
review summary, play vs Maia, openings trainer, puzzles, dark review) (5 light, 1 dark), each a marketing frame: caption, the app screen with rounded corners and a soft shadow.

Content notes: the game is invented (players "Alex" and "Sam"); Maia is a real local engine server with a dummy token;
the opening explorer needs a lichess login, so its responses are mocked (illustrative numbers, no games or players).
Replace by a real capture if the owner prefers.
