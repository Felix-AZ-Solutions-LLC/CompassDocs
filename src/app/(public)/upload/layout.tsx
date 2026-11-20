// A standalone surface with no per-person dark style (1.20.35, lib/dark-style):
// it wears the workspace's default. The root layout renders it on a full
// load; this keeps it after a client-side navigation here.

import { WorkspaceDarkStyle } from "@/components/WorkspaceDarkStyle";

export default function WorkspaceStyleLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <WorkspaceDarkStyle />
      {children}
    </>
  );
}
