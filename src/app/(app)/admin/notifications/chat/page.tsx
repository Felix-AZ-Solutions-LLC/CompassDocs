import { requireSettingsSection } from "@/lib/auth";
import { ChatAskPanel } from "@/components/ChatAskPanel";
import { getChatAskConfig } from "@/lib/chat-ask";
import { getAppSettings } from "@/lib/settings-store";

import { settingsMetadata } from "@/lib/settings-sections";
import { originForDomain } from "@/lib/workspace-origin";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/notifications", "Ask in chat");

export default async function ChatPage() {
  await requireSettingsSection("/admin/notifications");
  const [chatAsk, appSettings] = await Promise.all([getChatAskConfig(), getAppSettings()]);
  const chatBase = originForDomain(appSettings.custom_domain) ?? "https://your-domain";
  return <ChatAskPanel initial={chatAsk} baseUrl={chatBase} />;
}
