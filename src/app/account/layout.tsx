// Sign-in surfaces (STYLEGUIDE §Sign-in surfaces) wear the workspace's
// default dark style whoever is looking (1.20.35, lib/dark-style). The root
// layout renders it on a full load; this keeps it after a client-side
// navigation here (a redirect to the forced password change, say).

import { WorkspaceDarkStyle } from "@/components/WorkspaceDarkStyle";

export default function SignInSurfaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <WorkspaceDarkStyle />
      {children}
    </>
  );
}
