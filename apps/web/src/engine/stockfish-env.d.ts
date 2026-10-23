/** Injected by vite-plugin-stockfish.ts (`define`). */
declare const __STOCKFISH_ENGINE__: {
  version: string;
  /** Directory relative to the Vite base URL, with trailing slash. */
  dir: string;
  builds: { 'lite-single': string; lite: string };
};
