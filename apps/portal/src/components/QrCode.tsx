import { useMemo } from 'react';
import { qrMatrix, qrPath } from '../qr';

const QUIET = 4;

/** QR code rendered client-side as an SVG path (no innerHTML, no inline style, no network). */
export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, d } = useMemo(() => {
    const m = qrMatrix(text);
    return { size: m.length + QUIET * 2, d: qrPath(m, QUIET) };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width="192" height="192" role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
