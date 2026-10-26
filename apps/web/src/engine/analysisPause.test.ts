import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAnalysisStore } from '../store/analysisStore';
import { analysisPaused, pauseAnalysis, resetAnalysisPause } from './analysisPause';

const original = useAnalysisStore.getState().setEnabled;

beforeEach(() => {
  resetAnalysisPause();
  useAnalysisStore.setState({
    enabled: true,
    setEnabled: (enabled: boolean) => useAnalysisStore.setState({ enabled }),
  });
});

afterEach(() => {
  resetAnalysisPause();
  useAnalysisStore.setState({ enabled: false, setEnabled: original });
});

const enabled = () => useAnalysisStore.getState().enabled;

describe('pauseAnalysis', () => {
  it('switches the analysis off and back on at release', () => {
    const release = pauseAnalysis(() => true);
    expect(enabled()).toBe(false);
    expect(analysisPaused()).toBe(true);
    release();
    expect(enabled()).toBe(true);
    expect(analysisPaused()).toBe(false);
  });

  it('does not switch on what was off before', () => {
    useAnalysisStore.setState({ enabled: false });
    const release = pauseAnalysis(() => true);
    release();
    expect(enabled()).toBe(false);
  });

  it('reverts an attempt to switch on while active, and restores it later', () => {
    useAnalysisStore.setState({ enabled: false });
    let active = true;
    const release = pauseAnalysis(() => active);
    useAnalysisStore.getState().setEnabled(true);
    expect(enabled()).toBe(false);
    active = false;
    useAnalysisStore.getState().setEnabled(true);
    expect(enabled()).toBe(true);
    useAnalysisStore.getState().setEnabled(false);
    release();
    // The user wanted it on during the pause: restored.
    expect(enabled()).toBe(true);
  });

  it('restores only when the last holder releases; release is idempotent', () => {
    const a = pauseAnalysis(() => true);
    const b = pauseAnalysis(() => true);
    a();
    a();
    expect(enabled()).toBe(false);
    expect(analysisPaused()).toBe(true);
    b();
    expect(enabled()).toBe(true);
  });

  it('stops watching after the release', () => {
    const release = pauseAnalysis(() => true);
    release();
    useAnalysisStore.getState().setEnabled(false);
    useAnalysisStore.getState().setEnabled(true);
    expect(enabled()).toBe(true);
  });
});
