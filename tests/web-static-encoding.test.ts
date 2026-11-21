import assert from 'node:assert/strict';
import {test} from 'node:test';
import {brotliDecompressSync,gunzipSync} from 'node:zlib';
import {representationEtag,selectStaticRepresentation} from '../apps/web/src/static-encoding.ts';

const css=Buffer.from('.card{background:#123456;color:white;padding:12px}\\n'.repeat(600));

test('compresses public CSS via Brotli and reuses cached representation',()=>{
  const a=selectStaticRepresentation(css,'text/css; charset=utf-8','gzip, br');
  const b=selectStaticRepresentation(css,'text/css; charset=utf-8','br');
  assert.equal(a.encoding,'br');
  assert.equal(a.vary,true);
  assert.strictEqual(a.body,b.body);
  assert.deepEqual(brotliDecompressSync(a.body),css);
  assert.ok(a.body.byteLength<css.byteLength/2);
});

test('honours quality values, disabled encodings, and gzip fallback',()=>{
  const gzip=selectStaticRepresentation(css,'text/css; charset=utf-8','br;q=0, gzip;q=1');
  assert.equal(gzip.encoding,'gzip');
  assert.deepEqual(gunzipSync(gzip.body),css);
  const identity=selectStaticRepresentation(css,'text/css; charset=utf-8','br;q=0,gzip;q=0');
  assert.equal(identity.encoding,undefined);
  assert.strictEqual(identity.body,css);
  assert.equal(identity.vary,true);
  const preference=selectStaticRepresentation(css,'text/css; charset=utf-8','br;q=0.4,gzip;q=0.8');
  assert.equal(preference.encoding,'gzip');
});

test('only public, sufficiently large text assets use negotiation',()=>{
  assert.equal(selectStaticRepresentation(css,'image/webp','br').vary,false);
  assert.equal(selectStaticRepresentation(Buffer.from('hi'),'text/css','br').vary,false);
  assert.equal(selectStaticRepresentation(css,'application/json','br').vary,false);
  assert.equal(selectStaticRepresentation(css,'text/javascript; charset=utf-8','br').encoding,'br');
});

test('uses different strong ETags for different wire representations',()=>{
  const tag='"deadbeef"';
  assert.equal(representationEtag(tag,undefined),tag);
  assert.equal(representationEtag(tag,'br'),'"deadbeef-br"');
  assert.equal(representationEtag(tag,'gzip'),'"deadbeef-gzip"');
  assert.notEqual(representationEtag(tag,'br'),representationEtag(tag,'gzip'));
});
