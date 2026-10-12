import { useState, useEffect, lazy, Suspense } from 'react';
import { Toaster } from 'react-hot-toast';
import { Layout } from './components/common/Layout';
import { DashboardPage } from './components/dashboard/DashboardPage';
import { useWebSocket } from './hooks/useWebSocket';
import { AuthGuard } from './components/auth/AuthGuard';
import { StaleModulesModal } from './components/common/StaleModulesModal';
import { FEATURES } from './config/features';

// Route-level code splitting. These pages pull in the heavy dependencies
// (jointjs, leaflet, recharts, monaco), so importing them statically meant a
// single ~2.9 MB bundle shipped to anyone who just opened the dashboard.
const ApnProfilesPage = lazy(() => import('./pages/ApnProfilesPage').then(m => ({ default: m.ApnProfilesPage })));
const AutoConfigPage = lazy(() => import('./pages/AutoConfigPage').then(m => ({ default: m.AutoConfigPage })));
const BackupPage = lazy(() => import('./pages/BackupPage').then(m => ({ default: m.BackupPage })));
const BindPage = lazy(() => import('./pages/BindPage').then(m => ({ default: m.BindPage })));
const CallHistoryPage = lazy(() => import('./pages/CallHistoryPage').then(m => ({ default: m.CallHistoryPage })));
const ChargingPlansPage = lazy(() => import('./pages/ChargingPlansPage').then(m => ({ default: m.ChargingPlansPage })));
const ConfigPage = lazy(() => import('./components/config/ConfigPage').then(m => ({ default: m.ConfigPage })));
const FRRPage = lazy(() => import('./pages/FRRPage').then(m => ({ default: m.FRRPage })));
const Gsm2gSignalPage = lazy(() => import('./pages/Gsm2gSignalPage').then(m => ({ default: m.Gsm2gSignalPage })));
const GsmPage = lazy(() => import('./pages/GsmPage').then(m => ({ default: m.GsmPage })));
const HnbPage = lazy(() => import('./pages/HnbPage').then(m => ({ default: m.HnbPage })));
const IMSPage = lazy(() => import('./pages/IMSPage').then(m => ({ default: m.IMSPage })));
const LogsPage = lazy(() => import('./pages/LogsPage').then(m => ({ default: m.LogsPage })));
const MetricsPage = lazy(() => import('./components/metrics/MetricsPage').then(m => ({ default: m.MetricsPage })));
const OcsPage = lazy(() => import('./pages/OcsPage').then(m => ({ default: m.OcsPage })));
const PcapPage = lazy(() => import('./components/pcap/PcapPage').then(m => ({ default: m.PcapPage })));
const PstnGatewayPage = lazy(() => import('./pages/PstnGatewayPage').then(m => ({ default: m.PstnGatewayPage })));
const RANPage = lazy(() => import('./components/ran/RANPage').then(m => ({ default: m.RANPage })));
const RadioProvisioningPage = lazy(() => import('./pages/RadioProvisioningPage').then(m => ({ default: m.RadioProvisioningPage })));
const RadioSignalPage = lazy(() => import('./pages/RadioSignalPage').then(m => ({ default: m.RadioSignalPage })));
const RfPlanningPage = lazy(() => import('./pages/RfPlanningPage').then(m => ({ default: m.RfPlanningPage })));
const SASPage = lazy(() => import('./pages/SASPage').then(m => ({ default: m.SASPage })));
const SMSPage = lazy(() => import('./pages/SMSPage').then(m => ({ default: m.SMSPage })));
const SecGWPage = lazy(() => import('./pages/SecGWPage').then(m => ({ default: m.SecGWPage })));
const ServicesPage = lazy(() => import('./components/services/ServicesPage').then(m => ({ default: m.ServicesPage })));
const SnmpPage = lazy(() => import('./pages/SnmpPage').then(m => ({ default: m.SnmpPage })));
const SubscriberPage = lazy(() => import('./components/subscribers/SubscriberPage').then(m => ({ default: m.SubscriberPage })));
const SuciManagementPage = lazy(() => import('./components/suci/SuciManagementPage').then(m => ({ default: m.SuciManagementPage })));
const TimeServerPage = lazy(() => import('./pages/TimeServerPage').then(m => ({ default: m.TimeServerPage })));
const TopologyPage = lazy(() => import('./components/topology/TopologyPage').then(m => ({ default: m.TopologyPage })));
const TrafficHistoryPage = lazy(() => import('./pages/TrafficHistoryPage').then(m => ({ default: m.TrafficHistoryPage })));
const TwampPage = lazy(() => import('./pages/TwampPage').then(m => ({ default: m.TwampPage })));
const UserManagementPage = lazy(() => import('./components/users/UserManagementPage').then(m => ({ default: m.UserManagementPage })));
const ValidationPage = lazy(() => import('./pages/ValidationPage').then(m => ({ default: m.ValidationPage })));
const VoWiFiPage = lazy(() => import('./pages/VoWiFiPage').then(m => ({ default: m.VoWiFiPage })));

/**
 * Shown while a lazily-loaded page chunk arrives. Deliberately reserves the
 * page's own padding and a tall-ish box rather than collapsing to nothing,
 * so switching tabs does not shift the surrounding chrome (CLS).
 */
function PageLoading(): JSX.Element {
  return (
    <div className="p-6" role="status" aria-live="polite">
      <span className="sr-only">Loading page…</span>
      <div className="h-8 w-56 rounded-md bg-nms-surface-2 animate-pulse" />
      <div className="mt-6 h-40 rounded-lg border border-nms-border bg-nms-surface animate-pulse" />
    </div>
  );
}

function App(): JSX.Element {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [subscriberToEdit, setSubscriberToEdit] = useState<string | undefined>(undefined);

  const handleNavigateToSubscriber = (imsi: string) => {
    setSubscriberToEdit(imsi);
    setActiveTab('subscribers');
  };

  // Clear subscriberToEdit when navigating away from subscribers page
  useEffect(() => {
    if (activeTab !== 'subscribers') {
      setSubscriberToEdit(undefined);
    }
  }, [activeTab]);

  useWebSocket();

  const renderPage = (): JSX.Element => {
    switch (activeTab) {
      case 'dashboard':
        return <DashboardPage />;
      case 'topology':
        return <TopologyPage />;
      case 'ran':
        return <RANPage onNavigateToSubscriber={handleNavigateToSubscriber} />;
      case 'services':
        return <ServicesPage onNavigate={setActiveTab} />;
      case 'config':
        return <ConfigPage />;
      case 'apn-profiles':
        return <ApnProfilesPage />;
      case 'subscribers':
        return <SubscriberPage initialImsiToEdit={subscriberToEdit} />;
      case 'backup':
        return <BackupPage />;
      case 'logs':
        return <LogsPage />;
      case 'auto-config':
        return <AutoConfigPage />;
      case 'radio-config':
        return <RadioProvisioningPage onNavigate={setActiveTab} />;
      case 'rf-planning':
        return FEATURES.rfPlanning ? <RfPlanningPage /> : <DashboardPage />;
      case 'suci':
        return <SuciManagementPage />;
      case 'metrics':
        return <MetricsPage />;
      case 'traffic-history':
        return <TrafficHistoryPage />;
      case 'radio-signal':
        return FEATURES.ueSignal ? <RadioSignalPage /> : <DashboardPage />;
      case 'snmp':
        return FEATURES.snmp ? <SnmpPage /> : <DashboardPage />;
      case 'sas':
        return <SASPage />;
      case 'time-server':
        return <TimeServerPage />;
      case 'frr':
        return <FRRPage />;
      case 'bind':
        return <BindPage />;
      case 'sms':
        return FEATURES.sms ? <SMSPage /> : <DashboardPage />;
      case 'ims':
        return FEATURES.ims ? <IMSPage /> : <DashboardPage />;
      case 'pstn':
        return FEATURES.pstn ? <PstnGatewayPage onNavigate={setActiveTab} /> : <DashboardPage />;
      case 'ocs':
        return FEATURES.ocs ? <OcsPage /> : <DashboardPage />;
      case 'charging-plans':
        return FEATURES.ocs ? <ChargingPlansPage /> : <DashboardPage />;
      case 'cdr':
        return FEATURES.cdr ? <CallHistoryPage /> : <DashboardPage />;
      case 'vowifi':
        return FEATURES.vowifi ? <VoWiFiPage /> : <DashboardPage />;
      case 'secgw':
        return FEATURES.secgw ? <SecGWPage /> : <DashboardPage />;
      case 'gsm':
        return FEATURES.gsm ? <GsmPage onNavigate={setActiveTab} /> : <DashboardPage />;
      case 'gsm-signal':
        return FEATURES.gsm ? <Gsm2gSignalPage /> : <DashboardPage />;
      case 'hnbgw':
        return FEATURES.hnbgw ? <HnbPage onNavigate={setActiveTab} /> : <DashboardPage />;
      case 'twamp':
        return FEATURES.twamp ? <TwampPage onNavigate={setActiveTab} /> : <DashboardPage />;
      case 'validation':
        return FEATURES.validation ? <ValidationPage /> : <DashboardPage />;
      case 'pcap':
        return FEATURES.pcap ? <PcapPage /> : <DashboardPage />;
      case 'users':
        return <UserManagementPage />;
      default:
        return <DashboardPage />;
    }
  };

  return (
    <>
      <AuthGuard>
        <Layout activeTab={activeTab} onTabChange={setActiveTab}>
          <Suspense fallback={<PageLoading />}>{renderPage()}</Suspense>
        </Layout>
        <StaleModulesModal />
      </AuthGuard>
      <Toaster
        position="bottom-right"
        toastOptions={{
          // Driven off the theme tokens rather than hardcoded hex: these were
          // the Cyan Slate values, so toasts stayed blue-grey on all five
          // themes.
          style: {
            background: 'rgb(var(--nms-surface-2-rgb))',
            color: 'rgb(var(--nms-text-rgb))',
            border: '1px solid rgb(var(--nms-border-rgb))',
            fontSize: '13px',
            fontFamily: 'JetBrains Mono, monospace',
          },
          success: {
            iconTheme: {
              primary: 'rgb(var(--nms-green-rgb))',
              secondary: 'rgb(var(--nms-surface-2-rgb))',
            },
          },
          error: {
            iconTheme: {
              primary: 'rgb(var(--nms-red-rgb))',
              secondary: 'rgb(var(--nms-surface-2-rgb))',
            },
          },
        }}
      />
    </>
  );
}

export default App;
