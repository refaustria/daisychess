/** Injected by vite-plugin-stockfish.ts (`define`). */
declare const __STOCKFISH_ENGINE__: {
  version: string;
  /** Directory relative to the Vite base URL, with trailing slash. */
  dir: string;
  builds: { 'lite-single': string; lite: string; full: string };
  /** Download size in bytes per build (script + `.wasm`). */
  sizes: { 'lite-single': number; lite: number; full: number };
  /** Memory-cap worker shim for the multi-threaded builds (ADR-015). */
  memoryShim: string;
};
