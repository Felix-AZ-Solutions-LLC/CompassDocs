// The workspace's default dark style on <html> (1.20.35, lib/dark-style),
// for the surfaces where nobody has a choice of their own: the customer
// portal and its help centre, the public site and share links, and the
// sign-in pages. The root layout already renders it on a full page load;
// this keeps it after a client-side navigation from a page in someone's own
// style. Server component: reads the setting itself.

import { getAppSettings } from "@/lib/settings-store";
import { DEFAULT_DARK_STYLE, type DarkStyle } from "@/lib/dark-style";
import { DarkStyleSync } from "./DarkStyleSync";

export async function WorkspaceDarkStyle() {
  let style: DarkStyle = DEFAULT_DARK_STYLE;
  try {
    style = (await getAppSettings()).dark_style;
  } catch {
    /* no database: Slate, as the root layout would show */
  }
  return <DarkStyleSync style={style} />;
}
