import { useState, useEffect, useMemo, useCallback } from 'react';
import { X, Copy, Check, Search, ChevronDown, Smartphone, Loader2, Send, AlertTriangle, ExternalLink } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { subscriberApi } from '../../api';
import { esimApi, type SimlesslyGenerateAcResult } from '../../api/esim';
import type { Subscriber, SubscriberListItem } from '../../types';

interface EsimGeneratorModalProps {
  subscriber?: Subscriber;
  onClose: () => void;
}

interface EsimFormState {
  iccid: string;
  imsi: string;
  ki: string;
  configName: string;
  opc: string;
  msisdn: string;
  hplmnList: string;
  ehplmnList: string;
  oplmnList: string;
  fplmnList: string;
  spn: string;
  pnn: string;
  impi: string;
  impu: string;
  needAcLink: boolean;
  pin1: string;
  pin2: string;
  puk1: string;
  puk2: string;
  adm1: string;
  smsp: string;
}

function emptyForm(): EsimFormState {
  return {
    iccid: '', imsi: '', ki: '', configName: '',
    opc: '', msisdn: '', hplmnList: '', ehplmnList: '', oplmnList: '', fplmnList: '',
    spn: '', pnn: '', impi: '', impu: '',
    needAcLink: false,
    pin1: '', pin2: '', puk1: '', puk2: '', adm1: '', smsp: '',
  };
}

function fromSubscriber(sub: Subscriber): EsimFormState {
  return {
    ...emptyForm(),
    iccid: sub.iccid ?? '',
    imsi: sub.imsi ?? '',
    ki: sub.security?.k ?? '',
    opc: sub.security?.opc ?? '',
    msisdn: sub.msisdn?.[0] ?? '',
  };
}

function splitList(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

// Maps our form state to the exact request-body shape documented for
// Simlessly's Single Generate AC endpoint (POST /api/v2/ac/generate).
// Optional fields are omitted entirely when empty rather than sent as
// empty strings/arrays, matching the schema's "fully optional" semantics.
// encryptionMode is intentionally never sent — Simlessly defaults to 1
// (plaintext) when the field is omitted, which is always what we want.
function buildSimlesslyJson(form: EsimFormState): Record<string, unknown> {
  const json: Record<string, unknown> = {
    iccid: form.iccid,
    imsi: form.imsi,
    ki: form.ki,
    configName: form.configName,
  };

  if (form.opc) json.opc = form.opc;
  if (form.msisdn) json.msisdn = form.msisdn;

  const hplmnList = splitList(form.hplmnList);
  if (hplmnList.length) json.hplmnList = hplmnList;
  const ehplmnList = splitList(form.ehplmnList);
  if (ehplmnList.length) json.ehplmnList = ehplmnList;
  const oplmnList = splitList(form.oplmnList);
  if (oplmnList.length) json.oplmnList = oplmnList;
  const fplmnList = splitList(form.fplmnList);
  if (fplmnList.length) json.fplmnList = fplmnList;

  if (form.spn) json.spn = form.spn;
  if (form.pnn) json.pnn = form.pnn;
  if (form.impi) json.impi = form.impi;
  const impu = splitList(form.impu);
  if (impu.length) json.impu = impu;
  if (form.needAcLink) json.needAcLink = true;
  if (form.pin1) json.pin1 = form.pin1;
  if (form.pin2) json.pin2 = form.pin2;
  if (form.puk1) json.puk1 = form.puk1;
  if (form.puk2) json.puk2 = form.puk2;
  if (form.adm1) json.adm1 = form.adm1;
  if (form.smsp) json.smsp = form.smsp;

  return json;
}

function TextField({
  label, value, onChange, placeholder, mono = true,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <label className="text-xs font-semibold text-nms-text uppercase tracking-wider block mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={clsx('nms-input w-full text-sm', mono && 'font-mono')}
      />
    </div>
  );
}

export function EsimGeneratorModal({ subscriber, onClose }: EsimGeneratorModalProps): JSX.Element {
  const [form, setForm] = useState<EsimFormState>(() => (subscriber ? fromSubscriber(subscriber) : emptyForm()));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [copiedPretty, setCopiedPretty] = useState(false);
  const [copiedOneline, setCopiedOneline] = useState(false);
  const copyToClipboard = useCopyToClipboard();

  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<SimlesslyGenerateAcResult | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // Inline subscriber picker — only relevant when launched without a pre-selected subscriber
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<SubscriberListItem[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (subscriber) return;
    if (!searchTerm.trim()) { setSearchResults([]); return; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      subscriberApi.list(0, 8, searchTerm)
        .then((r) => { if (!cancelled) setSearchResults(r.subscribers); })
        .catch(() => { if (!cancelled) setSearchResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [searchTerm, subscriber]);

  const pickSubscriber = useCallback(async (imsi: string) => {
    try {
      const full = await subscriberApi.get(imsi);
      setForm(fromSubscriber(full));
      setSearchTerm('');
      setSearchResults([]);
      toast.success(`Loaded ${imsi}`);
    } catch {
      toast.error('Failed to load subscriber');
    }
  }, []);

  const update = <K extends keyof EsimFormState>(key: K, value: EsimFormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const json = useMemo(() => buildSimlesslyJson(form), [form]);
  const prettyJson = JSON.stringify(json, null, 2);
  const onelineJson = JSON.stringify(json);
  const isValid = Boolean(form.iccid.trim() && form.imsi.trim() && form.ki.trim() && form.configName.trim());

  const copy = async (text: string, which: 'pretty' | 'oneline') => {
    const ok = await copyToClipboard(text);
    if (ok) {
      if (which === 'pretty') {
        setCopiedPretty(true);
        setTimeout(() => setCopiedPretty(false), 2000);
      } else {
        setCopiedOneline(true);
        setTimeout(() => setCopiedOneline(false), 2000);
      }
      toast.success('Copied to clipboard');
    } else {
      toast.error('Failed to copy');
    }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    setResult(null);
    setGenerateError(null);
    try {
      const r = await esimApi.generate(json);
      setResult(r);
      if (r.success) {
        toast.success('eSIM generated');
      } else {
        toast.error(r.msg || `Simlessly error ${r.code}`);
      }
    } catch (err: any) {
      const msg = err?.response?.data?.error ?? err?.message ?? String(err);
      setGenerateError(msg);
      toast.error(msg);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="nms-card w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-4 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Smartphone className="w-5 h-5 text-nms-accent" />
            <h2 className="text-base font-semibold font-display text-nms-text">Generate eSIM (Simlessly)</h2>
          </div>
          <button onClick={onClose} className="text-nms-text-dim hover:text-nms-text transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 space-y-5">
          <p className="text-xs text-nms-text-dim">
            Builds and sends the request for Simlessly's Single Generate AC endpoint
            (<code className="text-nms-accent">POST /api/v2/ac/generate</code>). The JSON below
            is also shown for reference / manual use elsewhere.
          </p>

          {/* Subscriber picker — only when not launched with a pre-selected subscriber */}
          {!subscriber && (
            <div>
              <label className="text-xs font-semibold text-nms-text uppercase tracking-wider block mb-2">
                Load from existing subscriber (optional)
              </label>
              <div className="relative">
                <Search className="w-4 h-4 text-nms-text-dim absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search by IMSI, MSISDN, ICCID, nickname..."
                  className="nms-input pl-9 w-full text-sm"
                />
              </div>
              {searching && <p className="text-xs text-nms-text-dim mt-1">Searching...</p>}
              {searchResults.length > 0 && (
                <div className="mt-2 border border-nms-border rounded-md divide-y divide-nms-border overflow-hidden">
                  {searchResults.map((s) => (
                    <button
                      key={s.imsi}
                      onClick={() => pickSubscriber(s.imsi)}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-nms-surface-2 transition-colors flex items-center justify-between"
                    >
                      <span className="font-mono text-nms-text">{s.imsi}</span>
                      <span className="text-nms-text-dim">{s.nickname || s.msisdn?.[0] || ''}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Core required fields */}
          <div className="grid grid-cols-2 gap-3">
            <TextField label="ICCID *" value={form.iccid} onChange={(v) => update('iccid', v)} placeholder="19-20 digits" />
            <TextField label="IMSI *" value={form.imsi} onChange={(v) => update('imsi', v)} placeholder="15 digits" />
            <TextField label="KI *" value={form.ki} onChange={(v) => update('ki', v)} placeholder="32 hex chars" />
            <TextField label="Config Name *" value={form.configName} onChange={(v) => update('configName', v)} placeholder="e.g. templateRegualr01" mono={false} />
          </div>
          {!isValid && (
            <p className="text-xs text-amber-400 -mt-3">ICCID, IMSI, KI, and Config Name are required.</p>
          )}

          {/* Advanced (collapsible) */}
          <div className="border border-nms-border rounded-md overflow-hidden">
            <button
              onClick={() => setAdvancedOpen((o) => !o)}
              className="w-full flex items-center justify-between gap-3 text-left px-3 py-2.5 bg-nms-surface-2/50"
            >
              <span className="text-xs font-semibold text-nms-text uppercase tracking-wider">Advanced (optional fields)</span>
              <ChevronDown className={clsx('w-4 h-4 text-nms-text-dim transition-transform shrink-0', advancedOpen && 'rotate-180')} />
            </button>
            {advancedOpen && (
              <div className="p-3 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <TextField label="OPC" value={form.opc} onChange={(v) => update('opc', v)} placeholder="32 hex chars" />
                  <TextField label="MSISDN" value={form.msisdn} onChange={(v) => update('msisdn', v)} mono={false} />
                  <TextField label="HPLMN List" value={form.hplmnList} onChange={(v) => update('hplmnList', v)} placeholder="comma-separated" mono={false} />
                  <TextField label="EHPLMN List" value={form.ehplmnList} onChange={(v) => update('ehplmnList', v)} placeholder="comma-separated" mono={false} />
                  <TextField label="OPLMN List" value={form.oplmnList} onChange={(v) => update('oplmnList', v)} placeholder="comma-separated" mono={false} />
                  <TextField label="FPLMN List" value={form.fplmnList} onChange={(v) => update('fplmnList', v)} placeholder="comma-separated" mono={false} />
                  <TextField label="SPN" value={form.spn} onChange={(v) => update('spn', v)} mono={false} />
                  <TextField label="PNN" value={form.pnn} onChange={(v) => update('pnn', v)} mono={false} />
                  <TextField label="IMPI" value={form.impi} onChange={(v) => update('impi', v)} mono={false} />
                  <TextField label="IMPU List" value={form.impu} onChange={(v) => update('impu', v)} placeholder="comma-separated" mono={false} />
                  <div className="flex items-center gap-2 pt-6">
                    <input
                      type="checkbox"
                      id="needAcLink"
                      checked={form.needAcLink}
                      onChange={(e) => update('needAcLink', e.target.checked)}
                      className="nms-checkbox"
                    />
                    <label htmlFor="needAcLink" className="text-xs text-nms-text">Return AC Link (QR code URL)</label>
                  </div>
                  <TextField label="PIN1" value={form.pin1} onChange={(v) => update('pin1', v)} mono={false} />
                  <TextField label="PIN2" value={form.pin2} onChange={(v) => update('pin2', v)} mono={false} />
                  <TextField label="PUK1" value={form.puk1} onChange={(v) => update('puk1', v)} mono={false} />
                  <TextField label="PUK2" value={form.puk2} onChange={(v) => update('puk2', v)} mono={false} />
                  <TextField label="ADM1" value={form.adm1} onChange={(v) => update('adm1', v)} mono={false} />
                  <TextField label="SMSP" value={form.smsp} onChange={(v) => update('smsp', v)} mono={false} />
                </div>
              </div>
            )}
          </div>

          {/* Generate via Simlessly API */}
          <button
            onClick={handleGenerate}
            disabled={!isValid || generating}
            className="nms-btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {generating
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Generating...</>
              : <><Send className="w-4 h-4" /> Generate via Simlessly API</>}
          </button>

          {generateError && (
            <div className="flex items-start gap-2 bg-nms-red/10 border border-nms-red/30 rounded-md p-3 text-xs text-nms-red">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{generateError}</span>
            </div>
          )}

          {result && (
            <div className={clsx(
              'rounded-md p-3 border text-xs space-y-2',
              result.success
                ? 'bg-green-500/10 border-green-500/30 text-nms-text'
                : 'bg-nms-red/10 border-nms-red/30 text-nms-text',
            )}>
              <div className="flex items-center gap-2">
                {result.success ? <Check className="w-4 h-4 text-green-400" /> : <AlertTriangle className="w-4 h-4 text-nms-red" />}
                <span className="font-semibold">{result.success ? 'Generated successfully' : `Simlessly error ${result.code}`}</span>
              </div>
              {result.msg && <p className="text-nms-text-dim">{result.msg}</p>}
              {result.obj?.activationCode && (
                <div>
                  <span className="text-nms-text-dim">Activation Code: </span>
                  <span className="font-mono text-nms-accent break-all">{result.obj.activationCode}</span>
                </div>
              )}
              {result.obj?.acLink && (
                <div>
                  <a href={result.obj.acLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-nms-accent hover:text-nms-accent-hover">
                    <ExternalLink className="w-3.5 h-3.5" /> Open AC Link
                  </a>
                  <a href={result.obj.acLink} target="_blank" rel="noreferrer" className="block mt-2">
                    <img src={result.obj.acLink} alt="Activation QR code" className="max-w-[180px] rounded-md border border-nms-border" />
                  </a>
                </div>
              )}
            </div>
          )}

          {/* Pretty JSON */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-nms-text uppercase tracking-wider">Pretty JSON (human readable)</label>
              <button
                onClick={() => copy(prettyJson, 'pretty')}
                className="flex items-center gap-1.5 text-xs text-nms-accent hover:text-nms-accent-hover transition-colors"
              >
                {copiedPretty ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedPretty ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre className="bg-nms-surface-2 border border-nms-border rounded-md p-3 text-xs font-mono text-nms-text overflow-x-auto whitespace-pre">
              {prettyJson}
            </pre>
          </div>

          {/* Single-line */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-nms-text uppercase tracking-wider">Single-line</label>
              <button
                onClick={() => copy(onelineJson, 'oneline')}
                className="flex items-center gap-1.5 text-xs text-nms-accent hover:text-nms-accent-hover transition-colors"
              >
                {copiedOneline ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedOneline ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <div className="bg-nms-surface-2 border border-nms-border rounded-md p-3 text-xs font-mono text-nms-text break-all">
              {onelineJson}
            </div>
          </div>
        </div>

        <div className="flex justify-end mt-4 flex-shrink-0">
          <button onClick={onClose} className="nms-btn-ghost text-sm">Close</button>
        </div>
      </div>
    </div>
  );
}
