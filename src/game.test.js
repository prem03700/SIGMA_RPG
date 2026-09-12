import test from 'node:test';
import assert from 'node:assert/strict';
import { addDaysISO, attributeGain, levelFromXp, progression, rewardForDifficulty, xpThreshold } from './game.js';

test('level thresholds are non-linear and increasing', () => {
  assert.equal(xpThreshold(1), 0);
  assert.equal(xpThreshold(2), 100);
  assert.ok(xpThreshold(4) - xpThreshold(3) > xpThreshold(3) - xpThreshold(2));
});
test('levels follow thresholds', () => {
  assert.equal(levelFromXp(99), 1);
  assert.equal(levelFromXp(100), 2);
  assert.equal(levelFromXp(xpThreshold(5)), 5);
});
test('progression exposes next-level progress', () => {
  const value = progression(150);
  assert.equal(value.level, 2);
  assert.ok(value.progressPercent > 0 && value.progressPercent < 100);
});
test('rewards stay server-owned and scale', () => {
  assert.deepEqual(rewardForDifficulty('easy'), { xp: 20, gold: 8 });
  assert.ok(rewardForDifficulty('epic').xp > rewardForDifficulty('hard').xp);
  assert.equal(attributeGain(70), 35);
});
test('ISO day arithmetic crosses month boundaries', () => {
  assert.equal(addDaysISO('2026-09-01', -1), '2026-08-31');
});
