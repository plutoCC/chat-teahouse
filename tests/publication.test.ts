import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectPublicFile} from '../scripts/check-publication.js';

test('publication policy excludes private artifacts even if force-added to Git',()=>{
  for(const path of ['data/teahouse.sqlite','output/playwright/live.png','.test-artifacts/report.md','docs/VALIDATION.md','docs/desktop-preview.jpg','.env','src/data/context.ts','scripts/history.jsonl','secrets.enc.json'])assert.ok(inspectPublicFile(path,Buffer.from('private fixture')).length,path);
  assert.ok(inspectPublicFile('src/link.ts',Buffer.from('outside'), '120000').length);
  assert.ok(inspectPublicFile('src/file.ts',Buffer.from([0,1,2])).length);
  assert.deepEqual(inspectPublicFile('src/App.tsx',Buffer.from('export const name="demo";')),[]);
});

test('publication policy reports locations without echoing possible credentials or private paths',()=>{
  const samples=['sk-'+ 'a'.repeat(40),'github_'+'pat_'+'b'.repeat(48),'-----BEGIN '+'PRIVATE KEY-----','C:'+String.fromCharCode(92)+'Users'+String.fromCharCode(92)+'fixture-account'+String.fromCharCode(92)+'file'];
  for(const sample of samples){const findings=inspectPublicFile('README.md',Buffer.from('Example\n'+sample));assert.ok(findings.length);assert.equal(findings[0].line,2);assert.ok(!JSON.stringify(findings).includes(sample));}
});
