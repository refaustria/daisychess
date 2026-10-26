// Vite/Vitest `?raw` imports (test fixtures only; the package itself reads no files).
declare module '*?raw' {
  const text: string;
  export default text;
}
