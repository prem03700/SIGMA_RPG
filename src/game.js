/** Pure game rules. The backend is authoritative for all rewards. */
export const DIFFICULTY_REWARDS = Object.freeze({
  easy: { xp: 20, gold: 8 },
  medium: { xp: 40, gold: 15 },
  hard: { xp: 70, gold: 25 },
  epic: { xp: 110, gold: 40 }
});

export const CATEGORIES = Object.freeze({
  intellect: { label: 'Intellect', icon: '◈' },
  strength: { label: 'Strength', icon: '▲' },
  discipline: { label: 'Discipline', icon: '◆' },
  vitality: { label: 'Vitality', icon: '✦' }
});

export function xpThreshold(level) {
  const safeLevel = Math.max(1, Math.floor(Number(level) || 1));
  if (safeLevel === 1) return 0;
  return Math.round(100 * Math.pow(safeLevel - 1, 1.55));
}

export function levelFromXp(totalXp) {
  const xp = Math.max(0, Math.floor(Number(totalXp) || 0));
  let level = 1;
  while (xp >= xpThreshold(level + 1)) level += 1;
  return level;
}

export function progression(totalXp) {
  const xp = Math.max(0, Math.floor(Number(totalXp) || 0));
  const level = levelFromXp(xp);
  const currentFloor = xpThreshold(level);
  const nextCeiling = xpThreshold(level + 1);
  const gained = xp - currentFloor;
  const span = nextCeiling - currentFloor;
  return {
    totalXp: xp,
    level,
    currentFloor,
    nextCeiling,
    xpIntoLevel: gained,
    xpForNextLevel: span,
    xpRemaining: Math.max(0, nextCeiling - xp),
    progressPercent: Math.min(100, Math.round((gained / span) * 100))
  };
}

export function rewardForDifficulty(difficulty) {
  return DIFFICULTY_REWARDS[difficulty] ?? DIFFICULTY_REWARDS.medium;
}

export function attributeGain(xpReward) {
  return Math.max(1, Math.round(xpReward * 0.5));
}

export function addDaysISO(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function localDateISO(timeZone, date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${map.year}-${map.month}-${map.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}
