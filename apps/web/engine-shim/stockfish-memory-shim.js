/* global self, importScripts */
/**
 * ChessLab: worker shim for the multi-threaded Stockfish builds on memory-constrained devices
 * (docs/DECISIONS.md, ADR-015). Shipped next to the engine files by vite-plugin-stockfish.ts.
 *
 * `stockfish-19-lite.js` creates its shared memory with
 * `new WebAssembly.Memory({ initial: 2048, maximum: 32768, shared: true })` (128 MiB / 2 GiB) and
 * offers no option to change it. Shared memories cannot move, so engines may reserve the maximum
 * up front (WebKit does); several 2 GiB reservations are what iOS Safari answers with
 * "RangeError: Out of memory". This shim lowers `maximum` to `?maxPages=` (64 KiB pages) and then
 * runs the unchanged engine script `?engine=` with `importScripts`.
 *
 * URL: stockfish-memory-shim.js?engine=stockfish-19-lite.js&maxPages=8192#<absolute .wasm URL>
 * The engine finds its .wasm through the hash and starts its pthread workers from
 * `self.location.href`, i.e. from this shim with the same query: each pthread runs the shim too
 * (it only receives the memory, so the patch is a no-op there).
 */
(function () {
  'use strict';
  var params = new URLSearchParams(self.location.search);
  var engine = params.get('engine') || '';
  var maxPages = Number(params.get('maxPages'));
  if (!/^stockfish-[\w.-]+\.js$/.test(engine)) {
    throw new Error('stockfish-memory-shim: invalid engine "' + engine + '"');
  }
  if (maxPages > 0 && Number.isFinite(maxPages)) {
    var Memory = WebAssembly.Memory;
    var Capped = function (descriptor) {
      var d = descriptor;
      if (d && typeof d.maximum === 'number' && d.maximum > maxPages) {
        d = Object.assign({}, d, { maximum: Math.max(maxPages, d.initial || 0) });
      }
      var memory = new Memory(d);
      // Diagnostics (console, e2e): the engine's memory and its effective maximum in pages.
      self.__chesslabMemory = { memory: memory, maximum: d && d.maximum };
      return memory;
    };
    Capped.prototype = Memory.prototype;
    WebAssembly.Memory = Capped;
  }
  importScripts(new URL(engine, self.location.href).href);
})();
