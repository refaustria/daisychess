/**
 * Splits a (possibly multi-game) PGN text into single-game strings.
 * A game starts at a `[Event` tag line; for tagless input, at a
 * blank-line-separated block that starts with move number `1.`.
 */
export function splitPgnGames(text: string): string[] {
  const src = text.replace(/\r\n?/g, '\n').trim();
  if (!src) return [];
  const lines = src.split('\n');

  if (lines.some((l) => /^\s*\[Event\s/.test(l))) {
    const games: string[][] = [];
    let cur: string[] | null = null;
    let prevIsTag = false;
    for (const line of lines) {
      const isTag = /^\s*\[/.test(line);
      // [Event] starts a new game unless it is inside the previous game's tag block.
      if (/^\s*\[Event\s/.test(line) && !prevIsTag) {
        cur = [];
        games.push(cur);
      }
      if (cur) cur.push(line);
      prevIsTag = isTag;
    }
    return games.map((g) => g.join('\n').trim()).filter(Boolean);
  }

  const blocks = src.split(/\n\s*\n/);
  const games: string[] = [];
  for (const block of blocks) {
    const b = block.trim();
    if (!b) continue;
    const tagsOnly = (t: string) => t.split('\n').every((l) => /^\s*\[/.test(l));
    const prev = games[games.length - 1];
    // Tag-only blocks open a game; the following movetext block belongs to it.
    if (prev !== undefined && tagsOnly(prev)) games[games.length - 1] = prev + '\n\n' + b;
    else if (prev === undefined || tagsOnly(b) || /^1\s*\./.test(b)) games.push(b);
    else games[games.length - 1] = prev + '\n\n' + b;
  }
  return games;
}
