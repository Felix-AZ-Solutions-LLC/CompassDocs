import { requireSettingsSection } from "@/lib/auth";
import {
  getAiKeySource,
  getAiModel,
  DEFAULT_AI_MODEL,
  getAiProviderConfig,
  OPENAI_DEFAULT_URL,
} from "@/lib/ai-config";
import { embeddingsStatus } from "@/lib/embeddings";
import { AiSettings } from "@/components/AiSettings";
import { SemanticSearchPanel } from "@/components/SemanticSearchPanel";
import { SettingsPage } from "@/components/SettingsPage";

import { settingsMetadata } from "@/lib/settings-sections";
import Link from "next/link";
import type { SessionUser } from "@/lib/types";

/** "Keep AI on" / "Stop at the allowance" / "Cap at $40 a month", for whoever can open Plan & usage; null otherwise (self-hosted included). */
async function planSpendingLine(user: SessionUser): Promise<string | null> {
  const { canSeePlanNotices } = await import("@/components/plan/PlanBannerSlot");
  if (!(await canSeePlanNotices(user))) return null;
  const { cloudPlan } = await import("@/lib/plan");
  if (!(await cloudPlan())) return null;
  const { getAiSpending } = await import("@/lib/plan-usage");
  const c = await getAiSpending();
  return c.spending === "keep" ? "Keep AI on" : c.spending === "stop" ? "Stop at the allowance" : `Cap at $${(c.capUsd ?? 0).toFixed(2)} a month`;
}
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/ai");

export default async function AiPage() {
  const user = await requireSettingsSection("/admin/ai");
  const [source, providerCfg] = await Promise.all([getAiKeySource(), getAiProviderConfig()]);
  // 1.22.0 (design D2): in a CompassDocs Cloud workspace with a plan, one line linking the monthly AI spending choice.
  const spending = await planSpendingLine(user);
  return (
    <SettingsPage href="/admin/ai">
    <div className="space-y-6">
      {spending && (
        <p className="text-sm text-slate-600" data-testid="ai-spending-line">
          Spending: <b className="font-semibold text-slate-800">{spending}</b> ·{" "}
          <Link href="/admin/plan/ai#ai-spending" className="link">
            Plan & usage
          </Link>
        </p>
      )}
      <AiSettings
        initial={{
          source,
          has_key: source !== "none",
          model: await getAiModel(),
          default_model: DEFAULT_AI_MODEL,
          provider: providerCfg.provider,
          openai_base_url: providerCfg.openaiBaseUrl,
          openai_key_set: providerCfg.openaiKeySet,
          openai_model: providerCfg.openaiModel,
          openai_default_url: OPENAI_DEFAULT_URL,
        }}
      />
      <SemanticSearchPanel initial={await embeddingsStatus()} />
    </div>
    </SettingsPage>
  );
}
