import React, { useState } from 'react';
import { X, AlertCircle, CheckCircle, Loader, RotateCcw } from 'lucide-react';
import { genieacsApi, NbiTask } from '../../api';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';

interface Props {
  deviceId:  string;
  serial:    string;
  tasks:     NbiTask[];           // from preview endpoint
  onClose:   () => void;
  onSuccess: () => void;
}

type TaskState = 'pending' | 'running' | 'done' | 'error';

const TASK_LABELS = [
  '① setParameterValues — full config push',
  '② reboot',
  '③ setParameterValues — RF enable (post-reboot)',
];

export const ProvisionConfirmModal: React.FC<Props> = ({ deviceId, serial, tasks, onClose, onSuccess }) => {
  // Each task has its own editable JSON textarea + parse state
  const [editors, setEditors] = useState<string[]>(
    () => tasks.map(t => JSON.stringify(t.body, null, 2)),
  );
  const [errors, setErrors]   = useState<(string | null)[]>(() => tasks.map(() => null));
  const [taskStates, setTaskStates] = useState<TaskState[]>(() => tasks.map(() => 'pending'));
  const [running, setRunning]       = useState(false);
  const [done, setDone]             = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  // Validate JSON on every keystroke
  const handleEdit = (i: number, value: string) => {
    setEditors(prev => prev.map((v, idx) => idx === i ? value : v));
    try {
      JSON.parse(value);
      setErrors(prev => prev.map((e, idx) => idx === i ? null : e));
    } catch {
      setErrors(prev => prev.map((e, idx) => idx === i ? 'Invalid JSON' : e));
    }
  };

  const resetTask = (i: number) => {
    handleEdit(i, JSON.stringify(tasks[i].body, null, 2));
  };

  const allValid = errors.every(e => e === null);

  const handleConfirm = async () => {
    if (!allValid || running) return;
    setRunning(true);
    setGlobalError(null);

    // Build task list with possibly-edited bodies
    const editedTasks: NbiTask[] = editors.map((body, i) => ({
      url:  tasks[i].url,
      body: JSON.parse(body),
    }));

    try {
      for (let i = 0; i < editedTasks.length; i++) {
        setTaskStates(prev => prev.map((s, idx) => idx === i ? 'running' : s));

        // Fire each task individually so we can track per-task status
        const result = await genieacsApi.executeTasks(deviceId, [editedTasks[i]]);

        if (result.success) {
          setTaskStates(prev => prev.map((s, idx) => idx === i ? 'done' : s));
        } else {
          setTaskStates(prev => prev.map((s, idx) => idx === i ? 'error' : s));
          throw new Error(result.results?.[0]?.response ?? 'Task failed');
        }
      }

      setDone(true);
      toast.success(`${serial}: config pushed, reboot queued, RF enable queued.`);
      setTimeout(() => { onSuccess(); onClose(); }, 1500);
    } catch (err: any) {
      setGlobalError(String(err?.response?.data?.error ?? err?.message ?? err));
      setRunning(false);
    }
  };

  const taskStateIcon = (state: TaskState) => {
    if (state === 'running') return <Loader className="w-4 h-4 animate-spin text-nms-accent" />;
    if (state === 'done')    return <CheckCircle className="w-4 h-4 text-green-400" />;
    if (state === 'error')   return <AlertCircle className="w-4 h-4 text-red-400" />;
    return <span className="w-4 h-4 rounded-full border border-nms-border inline-block" />;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-nms-surface border border-nms-border rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-nms-border flex-shrink-0">
          <div>
            <h2 className="text-base font-semibold text-nms-text">Review &amp; Confirm — GenieACS NBI Calls</h2>
            <p className="text-xs text-nms-text-dim mt-0.5 font-mono">{serial}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-nms-surface-2 text-nms-text-dim">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Info banner */}
        <div className="mx-6 mt-4 flex-shrink-0 text-xs text-nms-text-dim bg-nms-surface-2 border border-nms-border rounded-lg px-4 py-3">
          These are the exact API calls that will be sent to GenieACS NBI in order.
          You can edit the JSON body of any task before confirming. All three tasks will be executed sequentially.
        </div>

        {/* Task editors — scrollable */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {tasks.map((task, i) => (
            <div key={i} className={clsx(
              'rounded-lg border overflow-hidden',
              taskStates[i] === 'done'    ? 'border-green-500/40' :
              taskStates[i] === 'error'   ? 'border-red-500/40'   :
              taskStates[i] === 'running' ? 'border-nms-accent/60' :
              'border-nms-border',
            )}>
              {/* Task header */}
              <div className="flex items-center justify-between px-4 py-2 bg-nms-surface-2 border-b border-nms-border">
                <div className="flex items-center gap-2">
                  {taskStateIcon(taskStates[i])}
                  <span className="text-xs font-semibold text-nms-text">{TASK_LABELS[i] ?? `Task ${i + 1}`}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-nms-text-dim font-mono truncate max-w-xs">{task.url}</span>
                  <button
                    onClick={() => resetTask(i)}
                    disabled={running}
                    className="flex items-center gap-1 text-xs text-nms-text-dim hover:text-nms-accent transition-colors"
                    title="Reset to default"
                  >
                    <RotateCcw className="w-3 h-3" /> Reset
                  </button>
                </div>
              </div>

              {/* JSON editor */}
              <div className="relative">
                <textarea
                  value={editors[i]}
                  onChange={e => handleEdit(i, e.target.value)}
                  disabled={running}
                  spellCheck={false}
                  className={clsx(
                    'w-full font-mono text-xs p-4 bg-nms-surface text-nms-text resize-none outline-none',
                    'focus:bg-nms-surface-2 transition-colors',
                    errors[i] ? 'text-red-400' : '',
                    running ? 'opacity-60 cursor-not-allowed' : '',
                  )}
                  rows={i === 0 ? 18 : 5}
                />
                {errors[i] && (
                  <div className="absolute bottom-2 right-3 text-xs text-red-400 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" /> {errors[i]}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Global error */}
        {globalError && (
          <div className="mx-6 mb-2 flex-shrink-0 flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{globalError}</span>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-nms-border flex-shrink-0">
          <p className="text-xs text-nms-text-dim">
            {allValid ? '✓ All tasks are valid JSON' : '⚠ Fix JSON errors before confirming'}
          </p>
          <div className="flex gap-3">
            <button onClick={onClose} className="nms-btn-ghost text-sm">
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={!allValid || running || done}
              className="nms-btn-primary text-sm flex items-center gap-2"
            >
              {running ? (
                <><Loader className="w-4 h-4 animate-spin" /> Executing…</>
              ) : done ? (
                <><CheckCircle className="w-4 h-4" /> Done</>
              ) : (
                'Confirm & Push'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
