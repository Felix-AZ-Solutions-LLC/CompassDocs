"use client";

// 1.20.13: a page shown as a tab of a settings section. The section's
// chrome (desk settings: DeskSettingsChrome) draws the page container, the
// section's PageHeader (the page's one h1) and the SubNav tab row, then
// wraps the tab's page in this provider. A page component written to stand
// alone (its own PageContainer and PageHeader with a Create button) then
// renders inside the tab without a second container or a second h1:
// PageContainer passes its children through, and PageHeader becomes the
// tab's intro row (an sr-only h2 with the page's title, the subtitle, and
// the actions on the right). STYLEGUIDE §Settings pages.

import { createContext, useContext } from "react";

const SubPageContext = createContext(false);

export function SettingsSubPage({ children }: { children: React.ReactNode }) {
  return <SubPageContext.Provider value={true}>{children}</SubPageContext.Provider>;
}

/** Is this rendered as a tab under a section's header? */
export function useSettingsSubPage(): boolean {
  return useContext(SubPageContext);
}
