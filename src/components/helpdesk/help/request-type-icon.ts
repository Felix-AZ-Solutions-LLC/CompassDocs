// The request-type icon map (1.19.0, §Helpdesk: Get help): a request type
// stores a lucide icon *name*; this maps it to the icon, in kebab, camel or
// Pascal case alike, and falls back to LifeBuoy. Never an emoji. Server-safe
// (1.20.37): Get help's client screens and the customer portal's request
// tiles, which render on the server, share it.

import type { LucideIcon } from "lucide-react";
import {
  Briefcase,
  Bug,
  Building2,
  Car,
  CircleHelp,
  Coffee,
  Flag,
  GraduationCap,
  Heart,
  KeyRound,
  Laptop,
  LifeBuoy,
  Lock,
  Mail,
  Monitor,
  Package,
  Phone,
  Printer,
  Smartphone,
  UserPlus,
  Users,
  Wallet,
  Wrench,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  briefcase: Briefcase,
  bug: Bug,
  building: Building2,
  building2: Building2,
  car: Car,
  coffee: Coffee,
  flag: Flag,
  graduation: GraduationCap,
  heart: Heart,
  help: CircleHelp,
  key: KeyRound,
  keyround: KeyRound,
  laptop: Laptop,
  lifebuoy: LifeBuoy,
  lock: Lock,
  mail: Mail,
  monitor: Monitor,
  package: Package,
  phone: Phone,
  printer: Printer,
  smartphone: Smartphone,
  userplus: UserPlus,
  users: Users,
  wallet: Wallet,
  wrench: Wrench,
};

/** "user-plus", "userPlus" and "UserPlus" all name the same lucide icon. */
export function requestTypeIcon(name: string | null | undefined): LucideIcon {
  const key = (name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return ICONS[key] ?? LifeBuoy;
}
