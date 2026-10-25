import qrcode from 'qrcode-generator';

/** Dark modules of a QR code for `text` (error correction M); rows of booleans, no quiet zone. */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const rows: boolean[][] = [];
  for (let r = 0; r < n; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

/** SVG path data (one `M x y h w v1 h-w z` per horizontal run of dark modules). */
export function qrPath(matrix: boolean[][], quiet = 4): string {
  const parts: string[] = [];
  matrix.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x++;
      parts.push(`M${start + quiet} ${y + quiet}h${x - start}v1h${start - x}z`);
    }
  });
  return parts.join('');
}
