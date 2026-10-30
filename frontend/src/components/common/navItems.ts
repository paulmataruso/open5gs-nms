import type React from 'react';
import {
  // ChevronLeft/ChevronRight/EyeOff are deliberately absent: they are the
  // sidebar's own chrome (collapse toggle, viewer banner), not destinations,
  // and they stay imported by Layout.tsx where they are used.
  Radio, Settings, Users, Activity, Network,
  Database, ScrollText,
  Key, UserCog, BarChart2, Shield, ShieldCheck, Clock, GitBranch, Zap, MessageSquare, Phone, PhoneCall, FlaskConical, Wifi, Globe, Radar, TrendingUp, RadioTower, Calculator, Layers, Gauge, ServerCog, Signal, DollarSign, Wallet, History,
} from 'lucide-react';
import { FEATURES } from '../../config/features';

export interface NavItem {
  id: string;
  label: string;
  icon: React.ComponentType<any>;
  /**
   * Used by the bottom tab bar only. Five columns on a 320px screen leave
   * ~56px of content width, where "RAN Network" and "Unified Logs" both clip.
   * The label is also the ONLY disambiguator there, since the icon set reuses
   * `Activity` for Dashboard and Services and `Wifi` for three destinations —
   * so shortening the string is the right lever rather than shrinking the type.
   */
  shortLabel?: string;
}

/**
 * Every navigation destination, in sidebar order.
 *
 * ONE list, consumed by both the desktop sidebar and the mobile nav sheet. Two
 * copies would diverge the first time a module is added — and the divergence
 * would be silent, because each shell renders only its own copy, so a
 * destination missing from one of them looks exactly like a feature that is
 * switched off.
 */
export const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: Activity, shortLabel: 'Home' },
  { id: 'topology', label: 'Topology', icon: Network },
  { id: 'ran', label: 'RAN Network', icon: Radio, shortLabel: 'RAN' },
  ...(FEATURES.ueSignal ? [{ id: 'radio-signal', label: '4G/5G UE Signal', icon: Wifi }] : []),
  { id: 'services', label: 'Services', icon: Activity },
  { id: 'config', label: 'Configuration', icon: Settings },
  { id: 'auto-config', label: 'Auto Config', icon: Zap },
  { id: 'radio-config', label: 'Radio Provisioning', icon: RadioTower },
  ...(FEATURES.rfPlanning ? [{ id: 'rf-planning', label: 'RF Planning', icon: Calculator }] : []),
  { id: 'apn-profiles', label: 'APN Profiles', icon: Layers },
  { id: 'subscribers', label: 'Subscribers', icon: Users, shortLabel: 'Subs' },
  { id: 'suci', label: 'SUCI Keys', icon: Key },
  { id: 'backup', label: 'Backup & Restore', icon: Database },
  { id: 'logs', label: 'Unified Logs', icon: ScrollText, shortLabel: 'Logs' },
  { id: 'metrics', label: 'Metrics', icon: BarChart2 },
  { id: 'traffic-history', label: 'Traffic History', icon: TrendingUp },
  { id: 'sas',         label: 'SAS',          icon: Shield    },
  { id: 'time-server', label: 'Time Server',   icon: Clock     },
  { id: 'frr', label: 'L3 Routing', icon: GitBranch },
  { id: 'bind', label: 'DNS (BIND9)', icon: Globe },
  ...(FEATURES.sms ? [{ id: 'sms', label: FEATURES.mms ? 'SMS/MMS' : 'SMS', icon: MessageSquare }] : []),
  ...(FEATURES.gsm ? [{ id: 'gsm', label: '2G GSM', icon: Signal }] : []),
  ...(FEATURES.gsm ? [{ id: 'gsm-signal', label: '2G UE Signal', icon: Wifi }] : []),
  ...(FEATURES.hnbgw ? [{ id: 'hnbgw', label: '3G UMTS', icon: Signal }] : []),
  ...(FEATURES.ims ? [{ id: 'ims', label: 'IMS / VoLTE', icon: Phone }] : []),
  ...(FEATURES.pstn ? [{ id: 'pstn', label: 'Voice Gateway', icon: PhoneCall }] : []),
  ...(FEATURES.ocs ? [{ id: 'ocs', label: 'SigScale OCS', icon: DollarSign }] : []),
  ...(FEATURES.ocs ? [{ id: 'charging-plans', label: 'Charging Plans', icon: Wallet }] : []),
  ...(FEATURES.cdr ? [{ id: 'cdr', label: 'Call History', icon: History }] : []),
  ...(FEATURES.vowifi ? [{ id: 'vowifi', label: 'VoWiFi', icon: Wifi }] : []),
  ...(FEATURES.secgw ? [{ id: 'secgw', label: 'SecGW', icon: ShieldCheck }] : []),
  ...(FEATURES.twamp ? [{ id: 'twamp', label: 'TWAMP', icon: Gauge }] : []),
  ...(FEATURES.snmp ? [{ id: 'snmp', label: 'SNMP Monitoring', icon: ServerCog }] : []),
  ...(FEATURES.validation ? [{ id: 'validation', label: 'UE/Core Validation', icon: FlaskConical }] : []),
  ...(FEATURES.pcap ? [{ id: 'pcap', label: 'Packet Capture', icon: Radar }] : []),
  { id: 'users',   label: 'User Management', icon: UserCog },
];

/**
 * The four destinations that get a bottom-tab slot on a phone.
 *
 * The bar holds five targets at most — four of these plus "More". Past that the
 * labels stop fitting and each target drops under the touch minimum, which is
 * the practical reason the cap exists rather than a stylistic one.
 *
 * These four are the monitoring path: is anything wrong (Dashboard), are the
 * radios up (RAN), look up one subscriber (Subscribers), and what is the core
 * actually saying (Logs). Configuration, Auto Config and RF Planning are
 * deliberately absent — they are sit-down tasks, and a destructive multi-step
 * wizard one thumb-tap from a monitoring screen invites the mistake you least
 * want made from a phone. Everything still reachable through More.
 *
 * Kept as one array so re-ordering the bar is a one-line edit rather than a
 * change scattered through JSX.
 */
export const MOBILE_PRIMARY_TAB_IDS = ['dashboard', 'ran', 'subscribers', 'logs'] as const;

/** Resolves the primary tab ids to real items, dropping any the build hides. */
export function mobilePrimaryTabs(): NavItem[] {
  return MOBILE_PRIMARY_TAB_IDS
    .map(id => NAV_ITEMS.find(i => i.id === id))
    .filter((i): i is NavItem => i !== undefined);
}

/** The label shown in the mobile top bar for whatever tab is open. */
export function navLabelFor(tabId: string): string {
  return NAV_ITEMS.find(i => i.id === tabId)?.label ?? 'Dashboard';
}

/**
 * Is this a destination this build can show? Used to stop a bogus or
 * feature-disabled id from the URL hash being held in nav state.
 *
 * Checks NAV_ITEMS plus the extra ids that are reachable only from inside
 * another page and so never appear in the sidebar.
 */
const NON_SIDEBAR_TAB_IDS = ['gsm-signal'];

export function isKnownNavTab(tab: string): boolean {
  return NAV_ITEMS.some(i => i.id === tab) || NON_SIDEBAR_TAB_IDS.includes(tab);
}
