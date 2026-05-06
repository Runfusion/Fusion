import {
  EVAL_SCORE_BANDS,
  EVAL_SCORE_CATEGORIES,
  EVAL_SCORE_SCALE_MAX,
  EVAL_SCORE_SCALE_MIN,
  type EvalCategoryScore,
  type EvalScoreBand,
  type EvalScoreCategory,
} from "./eval-types.js";

export const EVAL_CATEGORY_WEIGHTS: Record<EvalScoreCategory, number> = {
  agentPerformance: 0.30,
  taskOutcomeQuality: 0.45,
  processCompliance: 0.25,
};

const DETERMINISTIC_WEIGHT = 0.7;
const AI_WEIGHT = 0.3;

export function clampScore(value: number): number {
  return Math.min(EVAL_SCORE_SCALE_MAX, Math.max(EVAL_SCORE_SCALE_MIN, value));
}

export function assertValidScore(value: number, fieldName = "score"): void {
  if (!Number.isInteger(value) || value < EVAL_SCORE_SCALE_MIN || value > EVAL_SCORE_SCALE_MAX) {
    throw new Error(`${fieldName} must be an integer between ${EVAL_SCORE_SCALE_MIN} and ${EVAL_SCORE_SCALE_MAX}`);
  }
}

export function resolveScoreBand(score: number): EvalScoreBand {
  assertValidScore(score);
  for (const band of EVAL_SCORE_BANDS) {
    if (score >= band.min && score <= band.max) {
      return band.id;
    }
  }
  throw new Error(`No score band for score ${score}`);
}

export function computeCategoryFinalScore(deterministicScore: number, aiScore: number): number {
  assertValidScore(deterministicScore, "deterministicScore");
  assertValidScore(aiScore, "aiScore");
  return Math.round(clampScore((deterministicScore * DETERMINISTIC_WEIGHT) + (aiScore * AI_WEIGHT)));
}

export function normalizeCategoryScore(input: {
  category: EvalScoreCategory;
  deterministicScore: number;
  aiScore: number;
  rationale: string;
  evidence: EvalCategoryScore["evidence"];
}): EvalCategoryScore {
  const { category, deterministicScore, aiScore, rationale, evidence } = input;
  if (!EVAL_SCORE_CATEGORIES.includes(category)) {
    throw new Error(`Unknown score category: ${category}`);
  }
  if (!rationale.trim()) {
    throw new Error(`rationale is required for ${category}`);
  }

  const finalScore = computeCategoryFinalScore(deterministicScore, aiScore);
  return {
    category,
    deterministicScore,
    aiScore,
    finalScore,
    weight: EVAL_CATEGORY_WEIGHTS[category],
    band: resolveScoreBand(finalScore),
    rationale,
    evidence,
  };
}

export function computeOverallScore(categoryScores: EvalCategoryScore[]): number {
  if (categoryScores.length !== EVAL_SCORE_CATEGORIES.length) {
    throw new Error(`Expected ${EVAL_SCORE_CATEGORIES.length} category scores`);
  }

  const byCategory = new Map<EvalScoreCategory, EvalCategoryScore>();
  for (const categoryScore of categoryScores) {
    if (!EVAL_SCORE_CATEGORIES.includes(categoryScore.category)) {
      throw new Error(`Unknown score category: ${categoryScore.category}`);
    }
    byCategory.set(categoryScore.category, categoryScore);
  }

  let weightedSum = 0;
  for (const category of EVAL_SCORE_CATEGORIES) {
    const score = byCategory.get(category);
    if (!score) {
      throw new Error(`Missing category score: ${category}`);
    }
    assertValidScore(score.finalScore, `${category}.finalScore`);
    weightedSum += score.finalScore * EVAL_CATEGORY_WEIGHTS[category];
  }

  return Math.round(clampScore(weightedSum));
}
