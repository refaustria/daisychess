import { fakeEnginePids } from './helpers.js';

/** Fails the run if any fake engine process outlived the test suite. */
export default function setup(): () => Promise<void> {
  return async () => {
    // Give processes that were SIGKILLed at the very end a moment to be reaped.
    for (let i = 0; i < 50; i++) {
      if ((await fakeEnginePids()).length === 0) {
        console.log('[global-setup] no fake-engine processes left behind');
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const pids = await fakeEnginePids();
    throw new Error(`fake-engine processes left behind after tests: ${pids.join(', ')}`);
  };
}
