import journals from "../data/journals.config.js";
import type { AppConfig } from "./app-config.js";
import { loadAppConfig } from "./app-config.js";
import { configSummaryLines } from "./config-summary.js";
import { openDeliveryHistory } from "./delivery-history.js";
import { sendEmail } from "./email.js";
import { buildInterestCorpus } from "./interest-corpus.js";
import { rankPapers, resolveMatchingProvider } from "./matching.js";
import {
  enrichFeedPaperMetadata,
  enrichRecommendationAbstracts,
  repairRecommendationMetadata
} from "./paper-metadata.js";
import {
  deliverRecommendations,
  type RecommendationDeliveryDependencies
} from "./recommendation-delivery.js";
import { fetchRecentFeedPapers } from "./feed-ingestion.js";

type Env = Record<string, string | undefined>;

export type DailyFeedMode = "run" | "preview-email";

export type DailyFeedResult = {
  recommendationCount: number;
  html: string;
  sent: boolean;
  deliveryDetails: string;
};

export type DailyFeedDependencies = {
  buildInterestCorpus: typeof buildInterestCorpus;
  fetchRecentFeedPapers: typeof fetchRecentFeedPapers;
  openDeliveryHistory: typeof openDeliveryHistory;
  enrichFeedPaperMetadata: typeof enrichFeedPaperMetadata;
  enrichRecommendationAbstracts: typeof enrichRecommendationAbstracts;
  resolveMatchingProvider: typeof resolveMatchingProvider;
  rankPapers: typeof rankPapers;
  repairRecommendationMetadata: typeof repairRecommendationMetadata;
  delivery: RecommendationDeliveryDependencies;
};

const defaultDependencies: DailyFeedDependencies = {
  buildInterestCorpus,
  fetchRecentFeedPapers,
  openDeliveryHistory,
  enrichFeedPaperMetadata,
  enrichRecommendationAbstracts,
  resolveMatchingProvider,
  rankPapers,
  repairRecommendationMetadata,
  delivery: { sendEmail }
};

export async function runDailyFeed(
  mode: DailyFeedMode,
  env: Env = process.env,
  config: AppConfig = loadAppConfig(env),
  dependencies: DailyFeedDependencies = defaultDependencies
): Promise<DailyFeedResult> {
  console.log("Loaded app config.");
  for (const line of configSummaryLines(config)) {
    console.log(line);
  }

  console.log("Building interest corpus...");
  const interestCorpus = await dependencies.buildInterestCorpus(config.interests, env);
  if (interestCorpus.length === 0) {
    throw new Error("Interest corpus is empty. Enable profile or Zotero interests in app config.");
  }
  console.log(`Built ${interestCorpus.length} interest documents.`);

  const recentPapers = await dependencies.fetchRecentFeedPapers(journals, config.feeds, config.matching.maxPaperAgeDays);
  const deliveryHistory = dependencies.openDeliveryHistory({ env });
  const eligiblePapers = deliveryHistory.filterUndeliveredPapers(recentPapers);
  console.log(
    `Filtered ${recentPapers.length - eligiblePapers.length} already delivered papers; ${eligiblePapers.length} candidates remain.`
  );
  const enrichedPapers = await dependencies.enrichFeedPaperMetadata(eligiblePapers, config.metadataEnrichment);
  // History records the delivered metadata, whose title can differ from the RSS title.
  const undeliveredEnrichedPapers = deliveryHistory.filterUndeliveredPapers(enrichedPapers);
  console.log(`Filtered ${enrichedPapers.length - undeliveredEnrichedPapers.length} already delivered papers after metadata enrichment.`);
  const matchingProvider = dependencies.resolveMatchingProvider(config.matching);
  const fallback = matchingProvider.fallbackReason ? ` (${matchingProvider.fallbackReason})` : "";
  console.log(
    `Ranking ${undeliveredEnrichedPapers.length} papers against ${interestCorpus.length} interest documents with ${matchingProvider.label}${fallback}...`
  );
  let recommendations = await dependencies.rankPapers(config.matching, undeliveredEnrichedPapers, interestCorpus, env);
  console.log(`Ranked ${recommendations.length} recommended papers.`);
  recommendations = await dependencies.enrichRecommendationAbstracts(
    recommendations,
    config.metadataEnrichment
  );
  recommendations = await dependencies.repairRecommendationMetadata(recommendations, config.metadataRepair);
  const finalRecommendations = deliveryHistory.filterUndeliveredPapers(recommendations);
  console.log(`Filtered ${recommendations.length - finalRecommendations.length} already delivered papers after selected metadata enrichment.`);

  return deliverRecommendations(finalRecommendations, mode, config, deliveryHistory, env, new Date(), dependencies.delivery);
}
