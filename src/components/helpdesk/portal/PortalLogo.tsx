// The portal's logo element (1.20.37), for the Help Center's header band:
// the same element PortalHeader draws, from the same source. The portal's
// own logo (Desk settings → Customer portal → Brand, served by
// /support/api/logo, lib/helpdesk/portal portalBrand logo_url) when one is
// set, else the brand's initials. Only the size and the initials' tile
// differ: the header's is 32px on bg-compass-50; the band's is 48px on
// bg-surface with a hairline, since the band itself is the accent tint.
// Server-safe.

import { brandInitials } from "@/lib/helpdesk/portal-shared";

export function PortalLogo({ name, logoUrl, size = "md" }: { name: string; logoUrl: string | null; size?: "md" | "lg" }) {
  const box = size === "lg" ? "h-12 w-12 rounded-xl" : "h-8 w-8 rounded-lg";
  if (logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logoUrl} alt="" className={`${box} shrink-0 object-contain`} data-testid="portal-logo" />;
  }
  return (
    <span
      aria-hidden
      className={`${box} grid shrink-0 place-items-center font-semibold text-compass-700 ${size === "lg" ? "bg-surface text-base shadow-xs ring-1 ring-slate-200" : "bg-compass-50 text-xs"}`}
      data-testid="portal-initials"
    >
      {brandInitials(name)}
    </span>
  );
}
