"use client";

// A text link that signs out (POST, then the login page) — for pages
// outside the shell where the user menu is not available, such as the
// forced password change.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { forgetDeskOnSignOut } from "./helpdesk/desk/popout/reply-popout";

export function SignOutLink({ className = "link text-sm" }: { className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        // 1.20.18: reply pop-outs close and this browser keeps no desk drafts or hand-offs (a shared computer).
        forgetDeskOnSignOut();
        await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
        router.push("/login");
        router.refresh();
      }}
      className={className}
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
