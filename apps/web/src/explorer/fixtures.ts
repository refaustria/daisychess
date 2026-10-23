/** Explorer API response fixtures (shapes per lichess-org/api OpenAPI spec), shared by tests. */
export const MASTERS_START = {
  white: 1000,
  draws: 1200,
  black: 800,
  opening: null,
  moves: [
    { uci: 'e2e4', san: 'e4', averageRating: 2400, white: 500, draws: 500, black: 400, game: null, opening: null },
    { uci: 'd2d4', san: 'd4', averageRating: 2410, white: 400, draws: 600, black: 300, game: null, opening: null },
    { uci: 'g1f3', san: 'Nf3', averageRating: 2420, white: 100, draws: 100, black: 100, game: null, opening: null },
  ],
  topGames: [
    {
      uci: 'e2e4',
      id: 'mAsTer01',
      winner: 'white',
      white: { name: 'Carlsen, M.', rating: 2882 },
      black: { name: 'Caruana, F.', rating: 2820 },
      year: 2019,
      month: '2019-06',
    },
    {
      uci: 'd2d4',
      id: 'mAsTer02',
      winner: null,
      white: { name: 'Anand, V.', rating: 2780 },
      black: { name: 'Kramnik, V.', rating: 2790 },
      year: 2008,
    },
  ],
};

export const LICHESS_E4 = {
  white: 50,
  draws: 5,
  black: 45,
  opening: { eco: 'B00', name: "King's Pawn" },
  moves: [
    { uci: 'e7e5', san: 'e5', averageRating: 1900, white: 30, draws: 3, black: 27, game: null, opening: null },
    { uci: 'c7c5', san: 'c5', averageRating: 1950, white: 20, draws: 2, black: 18, game: null, opening: null },
  ],
  topGames: [],
  recentGames: [
    {
      uci: 'e7e5',
      id: 'liGame01',
      winner: 'black',
      speed: 'blitz',
      white: { name: 'alice', rating: 1800 },
      black: { name: 'bob', rating: 1850 },
      year: 2024,
      month: '2024-03',
    },
  ],
};

export const EMPTY = { white: 0, draws: 0, black: 0, opening: null, moves: [], topGames: [] };

/** Castling is encoded king-to-rook by the explorer. */
export const CASTLING = {
  white: 3,
  draws: 0,
  black: 1,
  opening: null,
  moves: [{ uci: 'e1h1', san: 'O-O', averageRating: 2500, white: 3, draws: 0, black: 1, game: null, opening: null }],
  topGames: [],
};

export const MASTERS_PGN =
  '[Event "Test"]\n[White "Carlsen, M."]\n[Black "Caruana, F."]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 1-0\n';

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function htmlResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(`<html><head><title>${status}</title></head></html>`, {
    status,
    headers: { 'content-type': 'text/html', ...headers },
  });
}
