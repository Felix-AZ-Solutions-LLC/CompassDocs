import { ShieldOff, LayoutDashboard } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Not available in a support session" };

// 1.21.4: where the request proxy shows a page a CompassDocs support session
// may not open (lib/support-policy), at the page's own address.
export default async function SupportNotAllowedPage() {
  await requireUser();
  return (
    <PageContainer>
      <PageHeader icon={<ShieldOff />} title="Not available in a support session" subtitle="This part of the workspace is kept to the workspace's own people." />
      <EmptyState
        icon={<ShieldOff />}
        title="Support can't open this page"
        body="A CompassDocs support session can't see or change its own access, sign-in and account security, or take a copy of the workspace."
        action={{ href: "/", label: "Go to the dashboard", icon: <LayoutDashboard /> }}
      />
    </PageContainer>
  );
}
