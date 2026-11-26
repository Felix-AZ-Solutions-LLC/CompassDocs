import { redirect } from "next/navigation";
import { needsSetup } from "@/lib/db";
import { eePresent } from "@/lib/ee";
import { proxyManaged } from "@/lib/caddy";
import { isCloud, licenseManagedByCloud, platformValue } from "@/lib/cloud";
import { SetupForm } from "@/components/SetupForm";
import { Brand } from "@/components/Brand";
import { printSetupToken } from "@/lib/setup-token";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set up workspace", robots: { index: false, follow: false } };

export default async function SetupPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  // Once an admin exists, setup is done — send people to sign in.
  if (!(await needsSetup())) redirect("/login");
  // 1.20.27 (security review M11): the token goes to the server log again,
  // in case the start-up lines have scrolled away (at most once a minute).
  printSetupToken("page");
  const token = (await searchParams).token;

  return (
    <div className="flex min-h-screen items-center justify-center bg-linear-to-br from-slate-100 to-compass-50 px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex flex-col items-center text-center">
          <Brand name="CompassDocs" size="lg" layout="col" />
          <h1 className="mt-3 text-2xl font-bold text-slate-900">Welcome — let&rsquo;s set up</h1>
          <p className="text-sm text-slate-500">
            Create your admin account to finish installing CompassDocs.
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-surface p-6 shadow-xs">
          <SetupForm
            enterprise={eePresent()}
            proxyManaged={proxyManaged()}
            cloud={isCloud()}
            platformLicense={licenseManagedByCloud()}
            platformAiKey={!!platformValue("ANTHROPIC_API_KEY")}
            initialToken={typeof token === "string" ? token.slice(0, 200) : ""}
          />
        </div>
        <p className="mt-4 text-center text-xs text-slate-500">
          You can add teammates and adjust settings later from the Admin console.
        </p>
      </div>
    </div>
  );
}
