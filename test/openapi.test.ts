import SwaggerParser from '@apidevtools/swagger-parser';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openApiSpec } from '../src/openapi';
import { safeNext } from '../src/ui';

describe('OpenAPI spec', () => {
  const spec = openApiSpec('https://ob.test', 'Outbound');

  it('is a valid OpenAPI 3.0 document', async () => {
    await SwaggerParser.validate(structuredClone(spec) as never);
  });

  it('documents every /api route in index.ts, and nothing that does not exist', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const routes = [...src.matchAll(/^api\.(get|post|put|patch|delete)\('([^']+)'/gm)].map(([, m, p]) => `${m.toUpperCase()} ${p.replace(/:(\w+)/g, '{$1}').replace('{tid}', '{template_id}')}`);
    const documented = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`));
    expect(routes.length).toBeGreaterThan(50);
    expect(routes.filter((r) => !documented.includes(r))).toEqual([]);
    expect(documented.filter((d) => !routes.includes(d))).toEqual([]);
  });

  it('points at this deployment and uses the passcode as a bearer token', () => {
    expect(spec.servers).toEqual([{ url: 'https://ob.test/api' }]);
    expect(spec.components.securitySchemes.passcode).toMatchObject({ type: 'http', scheme: 'bearer' });
  });
});

describe('sign-in return path', () => {
  it.each([
    ['/api-docs', '/api-docs'],
    ['//evil.com', '/'],
    ['/\\\\evil.com', '/'],
    ['https://evil.com', '/'],
    [undefined, '/'],
  ])('safeNext(%j) = %j', (v, want) => expect(safeNext(v)).toBe(want));
});
