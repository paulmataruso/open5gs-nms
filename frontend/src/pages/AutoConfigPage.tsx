import { useState, useEffect } from 'react';
import { Settings, Zap, AlertCircle, FileText, List } from 'lucide-react';
import { autoConfigApi, AutoConfigInput, PlmnConfig, configApi } from '../api';
import { DiffViewer } from '../components/DiffViewer';
import { PlmnInput } from '../components/config/PlmnInput';
import { LabelWithTooltip } from '../components/common/UniversalTooltipWrappers';
import { AUTO_CONFIG_TOOLTIPS } from '../data/tooltips';
import toast from 'react-hot-toast';

export const AutoConfigPage: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [config, setConfig] = useState<AutoConfigInput>({
    plmn4g: [{ mcc: '', mnc: '', mme_gid: 2, mme_code: 1, tac: 1 }],
    plmn5g: [{ mcc: '', mnc: '', tac: 1 }],
    s1mmeIP: '',
    sgwuGtpIP: '',
    amfNgapIP: '',
    upfGtpIP: '',
    sessionPoolIPv4Subnet: '',
    sessionPoolIPv4Gateway: '',
    sessionPoolIPv6Subnet: '',
    sessionPoolIPv6Gateway: '',
    configureNAT: false,
    natInterface: 'ogstun',
  });

  const [previewData, setPreviewData] = useState<string[] | null>(null);
  const [previewDiffs, setPreviewDiffs] = useState<Record<string, string> | null>(null);
  const [viewMode, setViewMode] = useState<'summary' | 'yaml'>('summary');

  // Load current config values on mount
  useEffect(() => {
    const loadCurrentConfigs = async () => {
      setInitializing(true);
      try {
        const configs = await configApi.getAll();
        
        const mmeConfig = (configs.mme as any)?.mme;
        const amfConfig = (configs.amf as any)?.amf;
        
        // Extract multiple GUMMEIs from MME
        const mmeGummeis = mmeConfig?.gummei || [];
        const plmn4g: PlmnConfig[] = mmeGummeis.map((gummei: any) => {
          const plmnId = Array.isArray(gummei.plmn_id) ? gummei.plmn_id[0] : gummei.plmn_id;
          // Find corresponding TAI
          const tai = mmeConfig?.tai?.find((t: any) => {
            const taiPlmn = Array.isArray(t.plmn_id) ? t.plmn_id[0] : t.plmn_id;
            return taiPlmn?.mcc === plmnId?.mcc && taiPlmn?.mnc === plmnId?.mnc;
          });
          const tacValue = tai?.tac;
          const tac = Array.isArray(tacValue) ? tacValue[0] : tacValue;

          return {
            mcc: plmnId?.mcc || '999',
            mnc: plmnId?.mnc || '70',
            mme_gid: gummei.mme_gid || 2,
            mme_code: gummei.mme_code || 1,
            tac: tac || 1,
          };
        });

        // Extract multiple GUAMIs from AMF
        const amfGuamis = amfConfig?.guami || [];
        const plmn5g: PlmnConfig[] = amfGuamis.map((guami: any) => {
          const plmnId = guami.plmn_id;
          // Find corresponding TAI
          const tai = amfConfig?.tai?.find((t: any) => 
            t.plmn_id?.mcc === plmnId?.mcc && t.plmn_id?.mnc === plmnId?.mnc
          );
          
          return {
            mcc: plmnId?.mcc || '999',
            mnc: plmnId?.mnc || '70',
            tac: tai?.tac || 1,
          };
        });
        
        const newConfig: AutoConfigInput = {
          plmn4g: plmn4g.length > 0 ? plmn4g : [{ mcc: '999', mnc: '70', mme_gid: 2, mme_code: 1, tac: 1 }],
          plmn5g: plmn5g.length > 0 ? plmn5g : [{ mcc: '999', mnc: '70', tac: 1 }],
          s1mmeIP: mmeConfig?.s1ap?.server?.[0]?.address || '',
          sgwuGtpIP: (configs.sgwu as any)?.sgwu?.gtpu?.server?.[0]?.address || '',
          amfNgapIP: amfConfig?.ngap?.server?.[0]?.address || '',
          upfGtpIP: (configs.upf as any)?.upf?.gtpu?.server?.[0]?.address || '',
          sessionPoolIPv4Subnet: (configs.upf as any)?.upf?.subnet?.[0]?.addr || '10.45.0.0/16',
          sessionPoolIPv4Gateway: '10.45.0.1',
          sessionPoolIPv6Subnet: (configs.upf as any)?.upf?.subnet?.[1]?.addr || '2001:db8:cafe::/48',
          sessionPoolIPv6Gateway: '2001:db8:cafe::1',
          configureNAT: false,
          natInterface: 'ogstun',
        };
        
        setConfig(newConfig);
      } catch (err) {
        console.error('Failed to load current configs:', err);
        toast.error('Failed to load current configuration values');
        setConfig({
          plmn4g: [{ mcc: '999', mnc: '70', mme_gid: 2, mme_code: 1, tac: 1 }],
          plmn5g: [{ mcc: '999', mnc: '70', tac: 1 }],
          s1mmeIP: '',
          sgwuGtpIP: '',
          amfNgapIP: '',
          upfGtpIP: '',
          sessionPoolIPv4Subnet: '10.45.0.0/16',
          sessionPoolIPv4Gateway: '10.45.0.1',
          sessionPoolIPv6Subnet: '2001:db8:cafe::/48',
          sessionPoolIPv6Gateway: '2001:db8:cafe::1',
          configureNAT: false,
          natInterface: 'ogstun',
        });
      } finally {
        setInitializing(false);
      }
    };
    
    loadCurrentConfigs();
  }, []);

  const handleApply = async () => {
    // Validation
    if (config.plmn4g.length === 0 || !config.plmn4g.every(p => p.mcc && p.mnc)) {
      toast.error('4G PLMN (MCC and MNC) is required for all entries');
      return;
    }
    if (config.plmn5g.length === 0 || !config.plmn5g.every(p => p.mcc && p.mnc)) {
      toast.error('5G PLMN (MCC and MNC) is required for all entries');
      return;
    }
    if (!config.s1mmeIP || !config.sgwuGtpIP || !config.amfNgapIP || !config.upfGtpIP) {
      toast.error('All IP addresses are required');
      return;
    }
    if (!config.sessionPoolIPv4Subnet || !config.sessionPoolIPv4Gateway ||
        !config.sessionPoolIPv6Subnet || !config.sessionPoolIPv6Gateway) {
      toast.error('All session pool settings are required');
      return;
    }

    if (!confirm('⚡ This will automatically configure Open5GS and restart all services.\n\nA backup will be created automatically.\n\nContinue?')) {
      return;
    }

    setLoading(true);
    try {
      const result = await autoConfigApi.apply(config);
      
      if (result.success) {
        toast.success(`✅ ${result.message}`, { duration: 6000 });
        setPreviewData(null);
        setPreviewDiffs(null);
      } else {
        toast.error(`❌ ${result.message}\n${result.errors?.join('\n') || ''}`);
      }
    } catch (err) {
      toast.error('Failed to apply auto-configuration');
    } finally {
      setLoading(false);
    }
  };

  const handlePreview = async () => {
    setLoading(true);
    try {
      const changes: string[] = [];
      
      // 4G PLMNs summary
      config.plmn4g.forEach((plmn, i) => {
        changes.push(`✓ MME PLMN ${i + 1}: ${plmn.mcc}/${plmn.mnc}, GID: ${plmn.mme_gid}, Code: ${plmn.mme_code}, TAC: ${plmn.tac}`);
      });
      changes.push(`✓ MME: S1-MME (${config.s1mmeIP})`);
      changes.push(`✓ SGW-U: GTP-U (${config.sgwuGtpIP})`);
      
      // 5G PLMNs summary
      config.plmn5g.forEach((plmn, i) => {
        changes.push(`✓ AMF PLMN ${i + 1}: ${plmn.mcc}/${plmn.mnc}, TAC: ${plmn.tac}`);
      });
      changes.push(`✓ AMF: NGAP (${config.amfNgapIP})`);
      changes.push(`✓ UPF: GTP-U (${config.upfGtpIP})`);
      changes.push(`✓ UPF: IPv4 Pool (${config.sessionPoolIPv4Subnet} via ${config.sessionPoolIPv4Gateway})`);
      changes.push(`✓ UPF: IPv6 Pool (${config.sessionPoolIPv6Subnet} via ${config.sessionPoolIPv6Gateway})`);
      changes.push(`✓ SMF: IPv4 Pool (${config.sessionPoolIPv4Subnet} via ${config.sessionPoolIPv4Gateway})`);
      changes.push(`✓ SMF: IPv6 Pool (${config.sessionPoolIPv6Subnet} via ${config.sessionPoolIPv6Gateway})`);
      setPreviewData(changes);

      const result = await autoConfigApi.preview(config);
      if (result.success) {
        setPreviewDiffs(result.diffs);
      } else {
        toast.error(result.message || 'Failed to generate preview');
      }
    } catch (err) {
      toast.error('Failed to generate preview');
    } finally {
      setLoading(false);
    }
  };

  if (initializing) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <div className="flex items-center justify-center h-64 text-nms-text-dim">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-nms-accent mx-auto mb-4"></div>
            <p>Loading current configuration...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold font-display text-nms-text mb-1">Auto Configuration</h1>
        <p className="text-sm text-nms-text-dim">Quickly configure Open5GS with your network details</p>
      </div>

      {/* Network Identity */}
      <div className="nms-card mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Settings className="w-5 h-5 text-nms-accent" />
          <h2 className="text-lg font-semibold font-display text-nms-text">📡 Network Identity</h2>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* 4G PLMN */}
          <PlmnInput
            label="4G PLMN (EPC / MME)"
            plmns={config.plmn4g}
            onChange={(plmns) => setConfig({ ...config, plmn4g: plmns })}
            showAdvanced={true}
            mode="4g"
          />

          {/* 5G PLMN */}
          <PlmnInput
            label="5G PLMN (5GC / AMF)"
            plmns={config.plmn5g}
            onChange={(plmns) => setConfig({ ...config, plmn5g: plmns })}
            showAdvanced={true}
            mode="5g"
          />
        </div>
      </div>

      {/* Network Interfaces */}
      <div className="nms-card mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Settings className="w-5 h-5 text-nms-accent" />
          <h2 className="text-lg font-semibold font-display text-nms-text">🌐 Network Interfaces</h2>
        </div>
        
        <div className="space-y-6">
          {/* 4G Network */}
          <div>
            <h3 className="text-sm font-semibold text-nms-text mb-3">4G Network (EPC)</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="nms-label">
                  <LabelWithTooltip tooltip={AUTO_CONFIG_TOOLTIPS.s1mme_ip}>S1-MME (MME ↔ eNodeB)</LabelWithTooltip>
                </label>
                <input
                  type="text"
                  placeholder="10.0.1.175"
                  value={config.s1mmeIP}
                  onChange={(e) => setConfig({ ...config, s1mmeIP: e.target.value })}
                  className="nms-input font-mono"
                />
              </div>
              <div>
                <label className="nms-label">
                  <LabelWithTooltip tooltip={AUTO_CONFIG_TOOLTIPS.sgwu_gtpu_ip}>S1-U (SGW-U GTP-U)</LabelWithTooltip>
                </label>
                <input
                  type="text"
                  placeholder="10.0.1.175"
                  value={config.sgwuGtpIP}
                  onChange={(e) => setConfig({ ...config, sgwuGtpIP: e.target.value })}
                  className="nms-input font-mono"
                />
              </div>
            </div>
          </div>

          {/* 5G Network */}
          <div>
            <h3 className="text-sm font-semibold text-nms-text mb-3">5G Network (5GC)</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="nms-label">
                  <LabelWithTooltip tooltip={AUTO_CONFIG_TOOLTIPS.amf_ngap_ip}>NGAP (AMF ↔ gNodeB)</LabelWithTooltip>
                </label>
                <input
                  type="text"
                  placeholder="10.0.1.175"
                  value={config.amfNgapIP}
                  onChange={(e) => setConfig({ ...config, amfNgapIP: e.target.value })}
                  className="nms-input font-mono"
                />
              </div>
              <div>
                <label className="nms-label">
                  <LabelWithTooltip tooltip={AUTO_CONFIG_TOOLTIPS.upf_gtpu_ip}>N3 (UPF GTP-U)</LabelWithTooltip>
                </label>
                <input
                  type="text"
                  placeholder="10.0.1.155"
                  value={config.upfGtpIP}
                  onChange={(e) => setConfig({ ...config, upfGtpIP: e.target.value })}
                  className="nms-input font-mono"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* UE IP Address Pool */}
      <div className="nms-card mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Settings className="w-5 h-5 text-nms-accent" />
          <h2 className="text-lg font-semibold font-display text-nms-text">📶 UE IP Address Pool (UPF Session Pool)</h2>
        </div>
        
        <div className="space-y-6">
          {/* IPv4 Pool */}
          <div>
            <h3 className="text-sm font-semibold text-nms-text mb-3">IPv4 Pool</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="nms-label">
                  <LabelWithTooltip tooltip={AUTO_CONFIG_TOOLTIPS.session_pool_ipv4_subnet}>Subnet (CIDR)</LabelWithTooltip>
                </label>
                <input
                  type="text"
                  placeholder="10.45.0.0/16"
                  value={config.sessionPoolIPv4Subnet}
                  onChange={(e) => setConfig({ ...config, sessionPoolIPv4Subnet: e.target.value })}
                  className="nms-input font-mono"
                />
                <p className="text-xs text-nms-text-dim mt-1">Example: 10.45.0.0/16</p>
              </div>
              <div>
                <label className="nms-label">
                  <LabelWithTooltip tooltip={AUTO_CONFIG_TOOLTIPS.session_pool_ipv4_gateway}>Gateway</LabelWithTooltip>
                </label>
                <input
                  type="text"
                  placeholder="10.45.0.1"
                  value={config.sessionPoolIPv4Gateway}
                  onChange={(e) => setConfig({ ...config, sessionPoolIPv4Gateway: e.target.value })}
                  className="nms-input font-mono"
                />
                <p className="text-xs text-nms-text-dim mt-1">Example: 10.45.0.1</p>
              </div>
            </div>
          </div>

          {/* IPv6 Pool */}
          <div>
            <h3 className="text-sm font-semibold text-nms-text mb-3">IPv6 Pool</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="nms-label">
                  <LabelWithTooltip tooltip={AUTO_CONFIG_TOOLTIPS.session_pool_ipv6_subnet}>Subnet (CIDR)</LabelWithTooltip>
                </label>
                <input
                  type="text"
                  placeholder="2001:db8:cafe::/48"
                  value={config.sessionPoolIPv6Subnet}
                  onChange={(e) => setConfig({ ...config, sessionPoolIPv6Subnet: e.target.value })}
                  className="nms-input font-mono"
                />
                <p className="text-xs text-nms-text-dim mt-1">Example: 2001:db8:cafe::/48</p>
              </div>
              <div>
                <label className="nms-label">
                  <LabelWithTooltip tooltip={AUTO_CONFIG_TOOLTIPS.session_pool_ipv6_gateway}>Gateway</LabelWithTooltip>
                </label>
                <input
                  type="text"
                  placeholder="2001:db8:cafe::1"
                  value={config.sessionPoolIPv6Gateway}
                  onChange={(e) => setConfig({ ...config, sessionPoolIPv6Gateway: e.target.value })}
                  className="nms-input font-mono"
                />
                <p className="text-xs text-nms-text-dim mt-1">Example: 2001:db8:cafe::1</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* NAT Configuration */}
      <div className="nms-card mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Settings className="w-5 h-5 text-nms-accent" />
          <h2 className="text-lg font-semibold font-display text-nms-text">🔒 NAT Configuration (Optional)</h2>
        </div>
        <p className="text-xs text-nms-text-dim mb-4">
          Configure Network Address Translation (NAT) with iptables for UE traffic
        </p>
        
        <div className="mb-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={config.configureNAT}
              onChange={(e) => setConfig({ ...config, configureNAT: e.target.checked })}
              className="w-4 h-4 rounded border-nms-border bg-nms-surface text-nms-accent focus:ring-nms-accent"
            />
            <span className="text-sm text-nms-text">Configure NAT and IP forwarding</span>
          </label>
        </div>

        {config.configureNAT && (
          <>
            <div className="mb-4">
              <label className="nms-label">
                <LabelWithTooltip tooltip={AUTO_CONFIG_TOOLTIPS.nat_interface}>Tunnel Interface</LabelWithTooltip>
              </label>
              <input
                type="text"
                value={config.natInterface || 'ogstun'}
                onChange={(e) => setConfig({ ...config, natInterface: e.target.value })}
                placeholder="ogstun"
                className="nms-input font-mono"
              />
              <p className="text-xs text-nms-text-dim mt-1">Default: ogstun</p>
            </div>

            <div className="bg-nms-surface-2 border border-nms-border rounded-md p-4">
              <h3 className="text-sm font-semibold text-nms-text mb-2">Commands that will be executed:</h3>
              <pre className="text-xs font-mono text-nms-text-dim space-y-1 overflow-x-auto">
                <div className="text-cyan-400"># Enable IP forwarding</div>
                <div>sysctl -w net.ipv4.ip_forward=1</div>
                <div>sysctl -w net.ipv6.conf.all.forwarding=1</div>
                <div>sysctl -p /etc/sysctl.conf</div>
                <div className="mt-2"></div>
                <div className="text-cyan-400"># Configure IPv4 NAT</div>
                <div>iptables -t nat -A POSTROUTING -s {config.sessionPoolIPv4Subnet} ! -o {config.natInterface || 'ogstun'} -j MASQUERADE</div>
                <div className="mt-2"></div>
                <div className="text-cyan-400"># Configure IPv6 NAT</div>
                <div>ip6tables -t nat -A POSTROUTING -s {config.sessionPoolIPv6Subnet} ! -o {config.natInterface || 'ogstun'} -j MASQUERADE</div>
                <div className="mt-2"></div>
                <div className="text-cyan-400"># Allow traffic from tunnel interface</div>
                <div>iptables -I INPUT -i {config.natInterface || 'ogstun'} -j ACCEPT</div>
              </pre>
            </div>
          </>
        )}
      </div>

      {/* Preview Changes */}
      {previewData && (
        <div className="nms-card bg-blue-500/5 border-blue-500/20 mb-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-blue-400" />
              <h2 className="text-lg font-semibold font-display text-nms-text">ℹ️ Preview Changes</h2>
            </div>
            
            <div className="flex gap-2">
              <button
                onClick={() => setViewMode('summary')}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors flex items-center gap-1.5 ${
                  viewMode === 'summary'
                    ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                    : 'bg-nms-surface-2 text-nms-text-dim hover:text-nms-text'
                }`}
              >
                <List className="w-3.5 h-3.5" />
                Summary
              </button>
              <button
                onClick={() => setViewMode('yaml')}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors flex items-center gap-1.5 ${
                  viewMode === 'yaml'
                    ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                    : 'bg-nms-surface-2 text-nms-text-dim hover:text-nms-text'
                }`}
              >
                <FileText className="w-3.5 h-3.5" />
                YAML Diff
              </button>
            </div>
          </div>

          {viewMode === 'summary' ? (
            <>
              <p className="text-xs text-nms-text-dim mb-3">
                The following configurations will be updated:
              </p>
              <div className="bg-blue-500/10 border border-blue-500/30 rounded-md p-3">
                <ul className="text-xs text-blue-300 space-y-1 font-mono">
                  {previewData.map((change, idx) => (
                    <li key={idx}>{change}</li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-nms-text-dim mb-3">
                YAML diff showing changes to each config file:
              </p>
              {previewDiffs && Object.keys(previewDiffs).length > 0 ? (
                <div className="space-y-4">
                  {Object.entries(previewDiffs).map(([service, diffText]) => (
                    <div key={service}>
                      <h3 className="text-sm font-semibold text-nms-text mb-2">{service}.yaml</h3>
                      <DiffViewer diff={diffText} />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="bg-blue-500/10 border border-blue-500/30 rounded-md p-3 text-center text-xs text-blue-300">
                  Loading diff...
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex gap-3">
        <button
          onClick={handlePreview}
          disabled={loading}
          className="nms-btn-secondary flex-1"
        >
          <AlertCircle className="w-4 h-4 inline mr-2" />
          Preview Config
        </button>
        
        <button
          onClick={handleApply}
          disabled={loading}
          className="nms-btn-primary flex-1"
        >
          {loading ? (
            <>⏳ Applying...</>
          ) : (
            <>
              <Zap className="w-4 h-4 inline mr-2" />
              Apply & Restart Services
            </>
          )}
        </button>
      </div>

      {/* Info Box */}
      <div className="nms-card bg-amber-500/5 border-amber-500/20 mt-6">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-amber-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-nms-text mb-2">Important Notes</h3>
            <ul className="text-xs text-nms-text-dim space-y-1">
              <li>• A backup will be created automatically before applying changes</li>
              <li>• All Open5GS services will be restarted after configuration</li>
              <li>• This will update: mme.yaml, sgwu.yaml, amf.yaml, upf.yaml, smf.yaml</li>
              <li>• Existing subscriber data in MongoDB will NOT be affected</li>
              <li>• Multiple PLMNs supported for both 4G (MME) and 5G (AMF)</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};
