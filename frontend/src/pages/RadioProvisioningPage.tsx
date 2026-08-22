import { useState } from 'react';
import { Radio, RadioTower, Calculator } from 'lucide-react';
import { FemtoConfigTab } from '../components/autoconfig/FemtoConfigTab';
import { BaicellsAcsTab } from '../components/autoconfig/BaicellsAcsTab';
import { SercommNRTab } from '../components/autoconfig/SercommNRTab';
import { clsx } from 'clsx';
import { FEATURES } from '../config/features';

type Tab = 'femto' | 'sercomm-nr' | 'baicells';

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'femto',      label: 'Sercomm 4G',           icon: <Radio className="w-4 h-4" /> },
  { id: 'sercomm-nr', label: 'Sercomm 5G',           icon: <Radio className="w-4 h-4" /> },
  { id: 'baicells',   label: 'Baicells Provisioning', icon: <Radio className="w-4 h-4" /> },
];

interface RadioProvisioningPageProps {
  onNavigate?: (tab: string) => void;
}

export const RadioProvisioningPage: React.FC<RadioProvisioningPageProps> = ({ onNavigate }) => {
  const [activeTab, setActiveTab] = useState<Tab>('femto');

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold font-display text-nms-text flex items-center gap-2">
            <RadioTower className="w-6 h-6 text-nms-accent" />
            Radio Provisioning
          </h1>
          <p className="text-sm text-nms-text-dim mt-1">TR-069/ACS provisioning for Sercomm and Baicells radios</p>
        </div>
        {FEATURES.rfPlanning && (
          <button onClick={() => onNavigate?.('rf-planning')} className="nms-btn-ghost flex items-center gap-2 border border-nms-border">
            <Calculator className="w-4 h-4" />
            RF Planning
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex justify-center">
        <div className="flex gap-1 p-1 bg-nms-surface-2 rounded-lg border border-nms-border">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all',
                activeTab === tab.id
                  ? 'bg-nms-accent text-white shadow-sm'
                  : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface',
              )}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'femto'      && <FemtoConfigTab />}
      {activeTab === 'sercomm-nr' && <SercommNRTab />}
      {activeTab === 'baicells'   && <BaicellsAcsTab />}
    </div>
  );
};
