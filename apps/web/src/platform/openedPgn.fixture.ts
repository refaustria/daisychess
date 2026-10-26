// Test fixture: a database-style export (CRLF line ends) with three games.
/** Three games, the way a database export looks (CRLF line ends, UTF-8 BOM). */
export const MULTI_GAME_PGN = [
  '[Event "Round 1"]\r\n[White "Anand, Viswanathan"]\r\n[Black "Kramnik, Vladimir"]\r\n[Result "1-0"]\r\n\r\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0\r\n',
  '[Event "Round 2"]\r\n[White "Carlsen, Magnus"]\r\n[Black "Nepomniachtchi, Ian"]\r\n[Result "1/2-1/2"]\r\n\r\n1. d4 d5 2. c4 e6 1/2-1/2\r\n',
  '[Event "Round 3"]\r\n[White "Müller"]\r\n[Black "Ding, Liren"]\r\n[Result "0-1"]\r\n\r\n1. c4 e5 2. Nc3 Nf6 0-1\r\n',
].join('\r\n');
