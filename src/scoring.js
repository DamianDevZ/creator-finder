// Channel scoring. Weights tuned for indie-game outreach: topic fit matters
// most, but small active channels beat big dead ones.

const WEIGHTS = {
  topicFit: 0.40,
  reach: 0.25,
  engagement: 0.20,
  recency: 0.15,
};

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Log-scale normalization so a 10M-sub channel doesn't dwarf everything.
const logNorm = (x, max) => Math.min(1, Math.log10(1 + x) / Math.log10(1 + max));

export function scoreChannel({ relevantVideoCount, medianRecentViews, subscriberCount, daysSinceLastUpload }) {
  // Topic fit: how many videos covering our/similar games they have, log-scaled.
  // A channel with 10+ relevant uploads is a near-perfect fit.
  const topicFit = logNorm(relevantVideoCount, 30);

  const reach = logNorm(medianRecentViews, 1_000_000);
  const engagement = subscriberCount > 0 ? Math.min(1, (medianRecentViews / subscriberCount) * 3) : 0;
  // 100 = uploaded today, linear down to 0 at 6 months of silence.
  const recency = daysSinceLastUpload == null ? 0 : Math.max(0, 1 - daysSinceLastUpload / 180);

  const score = Math.round(
    100 * (WEIGHTS.topicFit * topicFit + WEIGHTS.reach * reach + WEIGHTS.engagement * engagement + WEIGHTS.recency * recency)
  );

  return {
    score,
    breakdown: {
      topicFit: Math.round(topicFit * 100),
      reach: Math.round(reach * 100),
      engagement: Math.round(engagement * 100),
      recency: Math.round(recency * 100),
    },
  };
}

export function medianViews(videos) {
  return median(videos.map((v) => Number(v.statistics?.viewCount || 0)));
}

export function daysSince(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}
