// @vitest-environment node
// The nginx configs carry exactly the policies of csp.config.mjs (scripts/check-csp.mjs, ADR-021).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkConf, EXPECTED, REPO_FILES } from '../../../scripts/check-csp.mjs';
import { APP_HOST, HUB_CSP, LEGACY_CSP, PRODUCTION_CSP } from '../csp.config.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (f: string) => readFileSync(join(repo, f), 'utf8');

describe('nginx CSP check', () => {
  it('covers the production vhosts, the shared conf.d file and the docker image', () => {
    expect(REPO_FILES.map((f) => f.file).sort()).toEqual([
      'deploy/nginx/c.referee.at.conf',
      'deploy/nginx/daisychess-common.conf',
      'deploy/nginx/hub.daisychess.org.conf',
      'deploy/nginx/play.daisychess.org.conf',
      'docker/nginx.web.conf',
    ]);
  });

  for (const spec of REPO_FILES) {
    it(`${spec.file} passes`, () => {
      expect(checkConf(spec.file, read(spec.file), spec).errors).toEqual([]);
    });
  }

  it('the app policy allows the engine WebSocket of the new host only', () => {
    expect(APP_HOST).toBe('play.daisychess.org');
    expect(PRODUCTION_CSP).toContain('wss://play.daisychess.org');
    expect(PRODUCTION_CSP).not.toContain('referee');
    expect(LEGACY_CSP).toContain("connect-src 'none'");
    expect(LEGACY_CSP).not.toContain('unsafe');
    expect(HUB_CSP).toContain("default-src 'none'");
  });

  const common = read('deploy/nginx/daisychess-common.conf');
  const commonSpec = REPO_FILES.find((f) => f.file.endsWith('daisychess-common.conf'))!;
  const playSpec = REPO_FILES.find((f) => f.file.endsWith('play.daisychess.org.conf'))!;

  it('fails on a drifted policy and prints the expected line', () => {
    const drifted = common.replace('wss://play.daisychess.org', 'wss://c.referee.at');
    const { errors } = checkConf('x', drifted, commonSpec);
    expect(errors.join('\n')).toMatch(/\$daisychess_csp differs/);
    expect(errors.join('\n')).toContain(`expected: default "${EXPECTED.daisychess_csp}";`);
  });

  it('fails on a missing map', () => {
    const missing = common.replace(/map \$host \$daisychess_legacy_csp \{[^}]*\}/, '');
    expect(checkConf('x', missing, commonSpec).errors.join('\n')).toMatch(
      /no `map \$host \$daisychess_legacy_csp/,
    );
  });

  it('fails when a vhost location with its own add_header forgets the CSP', () => {
    const play = read(playSpec.file);
    const broken = play.replace(
      /(location \/assets\/ \{[\s\S]*?)\n\s*add_header Content-Security-Policy \$daisychess_csp always;/,
      '$1',
    );
    expect(broken).not.toBe(play);
    expect(checkConf('x', broken, playSpec).errors.join('\n')).toMatch(
      /without Content-Security-Policy/,
    );
  });

  it('fails when a vhost uses a foreign policy or declares a map (duplicate in nginx)', () => {
    const play = read(playSpec.file);
    expect(
      checkConf(
        'x',
        play.split('$daisychess_portal_csp').join('$daisychess_legacy_csp'),
        playSpec,
      ).errors.join('\n'),
    ).toMatch(/is not one of/);
    expect(
      checkConf(
        'x',
        `map $host $daisychess_csp {\n default "${PRODUCTION_CSP}";\n}\n${play}`,
        playSpec,
      ).errors.join('\n'),
    ).toMatch(/belong in daisychess-common.conf/);
  });

  it('checks extra (live) files for known variables and correct values', () => {
    expect(checkConf('live', read('deploy/nginx/c.referee.at.conf'), {}).errors).toEqual([]);
    expect(
      checkConf('live', 'add_header Content-Security-Policy "default-src *" always;', {}).errors,
    ).toHaveLength(1);
  });
});
