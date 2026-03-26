import { useState, useEffect } from 'react';
import { Toaster } from 'react-hot-toast';
import { Layout } from './components/common/Layout';
import { DashboardPage } from './components/dashboard/DashboardPage';
import { TopologyPage } from './components/topology/TopologyPage';
import { RANPage } from './components/ran/RANPage';
import { ServicesPage } from './components/services/ServicesPage';
import { ConfigPage } from './components/config/ConfigPage';
import { SubscriberPage } from './components/subscribers/SubscriberPage';
import { AuditPage } from './components/audit/AuditPage';
import { BackupPage } from './pages/BackupPage';
import { LogsPage } from './pages/LogsPage';
import { AutoConfigPage } from './pages/AutoConfigPage';
import { SuciManagementPage } from './components/suci/SuciManagementPage';
import { useWebSocket } from './hooks/useWebSocket';
import { useServiceStore } from './stores';

function App(): JSX.Element {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [subscriberToEdit, setSubscriberToEdit] = useState<string | undefined>(undefined);
  const fetchStatuses = useServiceStore((s) => s.fetchStatuses);

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

  useEffect(() => {
    fetchStatuses();
  }, [fetchStatuses]);

  const renderPage = (): JSX.Element => {
    switch (activeTab) {
      case 'dashboard':
        return <DashboardPage />;
      case 'topology':
        return <TopologyPage />;
      case 'ran':
        return <RANPage onNavigateToSubscriber={handleNavigateToSubscriber} />;
      case 'services':
        return <ServicesPage />;
      case 'config':
        return <ConfigPage />;
      case 'subscribers':
        return <SubscriberPage initialImsiToEdit={subscriberToEdit} />;
      case 'audit':
        return <AuditPage />;
      case 'backup':
        return <BackupPage />;
      case 'logs':
        return <LogsPage />;
      case 'auto-config':
        return <AutoConfigPage />;
      case 'suci':
        return <SuciManagementPage />;
      default:
        return <DashboardPage />;
    }
  };

  return (
    <>
      <Layout activeTab={activeTab} onTabChange={setActiveTab}>
        {renderPage()}
      </Layout>
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: '#1a2236',
            color: '#e2e8f0',
            border: '1px solid #1e293b',
            fontSize: '13px',
            fontFamily: 'JetBrains Mono, monospace',
          },
          success: { iconTheme: { primary: '#10b981', secondary: '#1a2236' } },
          error: { iconTheme: { primary: '#ef4444', secondary: '#1a2236' } },
        }}
      />
    </>
  );
}

export default App;
