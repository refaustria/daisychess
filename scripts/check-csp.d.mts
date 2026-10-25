// Types for check-csp.mjs (imported by apps/web/src/nginxCsp.test.ts).
export const EXPECTED: Record<string, string>;
export interface ConfSpec {
  file: string;
  maps?: string[];
  uses?: string[] | null;
}
export const REPO_FILES: ConfSpec[];
export function checkConf(
  name: string,
  conf: string,
  spec: Omit<ConfSpec, 'file'>,
): { errors: string[]; ok: string[] };
