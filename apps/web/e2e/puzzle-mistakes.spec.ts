import { expect, test } from '@playwright/test';

// White to move, Ra8# is mate; the user "played" Rb2 instead.
const FEN = '6k1/5ppp/8/8/8/8/8/RR4K1 w - - 0 1';

test('puzzles: "Your mistakes" lists stored puzzles, asks the side once and trains a due puzzle', async ({
  page,
}) => {
  await page.route('**/puzzles/v1/**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();

  // Seed the puzzles database (same schema as puzzlesDb.ts, version 1).
  await page.evaluate(
    async ({ fen }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open('daisychess-puzzles', 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          d.createObjectStore('shards', { keyPath: 'file' }).createIndex('usedAt', 'usedAt');
          d.createObjectStore('meta', { keyPath: 'key' });
          d.createObjectStore('games', { keyPath: 'gameKey' }).createIndex(
            'reviewedAt',
            'reviewedAt',
          );
          const m = d.createObjectStore('mistakes', { keyPath: 'id' });
          m.createIndex('createdAt', 'createdAt');
          m.createIndex('gameKey', 'gameKey');
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const tx = db.transaction(['games', 'mistakes'], 'readwrite');
      const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      tx.objectStore('games').put({
        gameKey: 'g1',
        startFen: start,
        moves: [],
        headers: { White: 'Alice', Black: 'Bob', Date: '2026.10.01' },
        source: 'pgn',
        userSide: 'white',
        reviewedAt: 1,
      });
      tx.objectStore('games').put({
        gameKey: 'g2',
        startFen: start,
        moves: [],
        headers: { White: 'Carl', Black: 'Dora' },
        source: 'pgn',
        reviewedAt: 2,
      });
      tx.objectStore('mistakes').put({
        id: 'm:e2e',
        puzzle: {
          id: 'm:e2e',
          fen,
          moves: ['a1a8'],
          themes: [],
          openings: [],
          source: 'mistake',
          noIntro: true,
        },
        gameKey: 'g1',
        ply: 7,
        playedUci: 'b1b2',
        classification: 'blunder',
        evalBeforeWhite: { mate: 1 },
        evalAfterWhite: { cp: 20 },
        createdAt: 1000,
        schedule: { due: 0, interval: 0, ease: 2.5, reps: 0 },
      });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { fen: FEN },
  );

  await page.getByRole('tab', { name: 'Puzzles' }).click();
  await page.getByRole('button', { name: 'Your mistakes' }).click();
  await expect(page.getByTestId('mistakes-stats')).toContainText('1 due · 1 total');
  await expect(page.getByTestId('mistakes-list')).toContainText('Alice vs Bob');
  await expect(page.getByTestId('mistakes-list')).toContainText('you played Rb2, best Ra8#');

  // Ask-once side prompt.
  await expect(page.getByTestId('mistakes-side-prompt')).toContainText(
    'Which side did you play in Carl vs Dora?',
  );
  await page.getByRole('button', { name: 'Skip Carl vs Dora' }).click();
  await expect(page.getByTestId('mistakes-side-prompt')).toHaveCount(0);

  // Train the due puzzle by typing the move.
  await page.getByRole('button', { name: 'Train due' }).click();
  await expect(page.getByTestId('mistakes-session')).toContainText('your move', {
    timeout: 10_000,
  });
  await page.getByLabel('Move, e.g. Nf3').fill('Ra8#');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByTestId('mistakes-session')).toContainText('finished', { timeout: 10_000 });
  await expect(page.getByTestId('mistakes-stats')).toContainText('0 due · 1 total');
});
