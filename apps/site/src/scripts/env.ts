// Small capability checks shared by the entry scripts.

export function prefersReducedMotion(win: Pick<Window, 'matchMedia'> = window): boolean {
  return typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** True when a WebGL (1 or 2) context can be created. The probe canvas is discarded. */
export function hasWebGL(doc: Pick<Document, 'createElement'> = document): boolean {
  try {
    const c = doc.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}
