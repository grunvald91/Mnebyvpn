import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewCodeHash,newReviewSalt,REVIEW_CODE_PATTERN} from '../packages/web/src/review-login.ts';

const secret='review-code-unit-secret-which-is-long-enough-for-pepper';
test('review credentials use eight digits and a unique scrypt salt',()=>{
  assert.ok(REVIEW_CODE_PATTERN.test('00000000'));
  assert.ok(!REVIEW_CODE_PATTERN.test('123456'));
  assert.ok(!REVIEW_CODE_PATTERN.test('123456789'));
  const a=newReviewSalt(),b=newReviewSalt();
  assert.notEqual(a,b);
  const h1=reviewCodeHash('review@example.org','12345678',a,secret);
  const h2=reviewCodeHash('review@example.org','12345678',b,secret);
  assert.match(h1,/^[0-9a-f]{64}$/);
  assert.notEqual(h1,h2);
  assert.equal(reviewCodeHash('review@example.org','12345678',a,secret),h1);
  assert.notEqual(reviewCodeHash('other@example.org','12345678',a,secret),h1);
  assert.throws(()=>reviewCodeHash('review@example.org','123456',a,secret));
});
