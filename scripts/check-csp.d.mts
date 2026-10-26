// Types for check-csp.mjs (imported by apps/web/src/nginxCsp.test.ts).
export const EXPECTED: Record<string, string>;
export interface ConfSpec {
  file: string;
  maps?: string[];
  uses?: string[] | null;
  /** The file must define the puzzle CORS map `$daisychess_app_cors`. */
  corsMap?: boolean;
  /** The vhost must carry the puzzle locations (ADR-023 §5). */
  puzzles?: boolean;
}
export const APP_CORS_VAR: string;
export const EXPECTED_CORS_ORIGINS: string[];
export const PUZZLE_LOCATIONS: Record<string, string>;
export const REPO_FILES: ConfSpec[];
export function checkConf(
  name: string,
  conf: string,
  spec: Omit<ConfSpec, 'file'>,
): { errors: string[]; ok: string[] };
