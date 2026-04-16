import { useState } from 'react';
import { ChevronLeft, ChevronDown } from 'lucide-react';
import { StatusBadge } from '../ui/StatusBadge';
import { RunHistory } from './RunHistory';
import { ConfigPanel } from '../canvas/ConfigPanel';
import { StreamingMarkdown } from '../chat/StreamingMarkdown';
import type { StageDefinition, StageContext, WorkflowDefinition } from '../../lib/api';

export function GenericSidebar({
  stageId,
  stageDef,
  stageCtx,
  definition,
  onClose,
}: {
  stageId: string;
  stageDef?: StageDefinition;
  stageCtx: StageContext | null | undefined;
  definition?: WorkflowDefinition;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<'runtime' | 'config'>('runtime');
  const [readmeExpanded, setReadmeExpanded] = useState(true);

  return (
    <div className="w-full h-full bg-surface flex flex-col min-h-0 overflow-hidden">
      {/* Header */}
      <div className="p-4 pb-0 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={onClose}
            className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-primary transition-colors flex-shrink-0"
          >
            <ChevronLeft className="w-3 h-3" />
            Overview
          </button>
          <h3 className="font-semibold text-sm truncate">{stageDef?.label || stageId}</h3>
          {stageCtx?.status && <StatusBadge status={stageCtx.status} />}
        </div>
        {stageDef?.type && <p className="text-[10px] text-text-tertiary mt-1">{stageDef.type}</p>}

        {/* Tabs */}
        <div className="flex gap-0 border-b border-border mt-2 -mx-4 px-4">
          {(['runtime', 'config'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors border-b-2 -mb-px ${
                activeTab === tab
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-text-tertiary hover:text-text-secondary'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {activeTab === 'runtime' ? (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {stageDef && (
            <>
              {stageDef.readme && (
                <div className="rounded-lg border border-border bg-surface-secondary/50">
                  <button
                    type="button"
                    onClick={() => setReadmeExpanded((v) => !v)}
                    className="w-full flex items-center justify-between px-3 py-2 text-[10px] text-text-tertiary uppercase tracking-wider font-medium hover:text-text-secondary transition-colors"
                  >
                    Description
                    <ChevronDown className={`w-3 h-3 transition-transform ${readmeExpanded ? '' : '-rotate-90'}`} />
                  </button>
                  {readmeExpanded && (
                    <div className="px-3 pb-3">
                      <StreamingMarkdown content={stageDef.readme} />
                    </div>
                  )}
                </div>
              )}

              {/* Map Over section — shown when map_over is set */}
              {stageDef.map_over && (
                <div className="rounded-lg border border-indigo-400/40 bg-indigo-500/10 p-3 space-y-2">
                  <div className="text-[10px] text-indigo-400 uppercase tracking-wider font-semibold">Map Over</div>
                  <div>
                    <div className="text-[10px] text-text-tertiary mb-0.5">Expression</div>
                    <code className="text-xs text-indigo-300 bg-indigo-500/10 rounded px-1.5 py-0.5 font-mono block break-all">
                      {stageDef.map_over}
                    </code>
                  </div>
                  {stageDef.concurrency != null && (
                    <div className="flex gap-4">
                      <div>
                        <div className="text-[10px] text-text-tertiary mb-0.5">Concurrency</div>
                        <span className="text-xs text-text-primary font-mono">{stageDef.concurrency}</span>
                      </div>
                      {stageDef.failure_tolerance != null && (
                        <div>
                          <div className="text-[10px] text-text-tertiary mb-0.5">Failure Tolerance</div>
                          <span className="text-xs text-text-primary font-mono">{stageDef.failure_tolerance}</span>
                        </div>
                      )}
                    </div>
                  )}
                  {stageDef.concurrency == null && stageDef.failure_tolerance != null && (
                    <div>
                      <div className="text-[10px] text-text-tertiary mb-0.5">Failure Tolerance</div>
                      <span className="text-xs text-text-primary font-mono">{stageDef.failure_tolerance}</span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {stageCtx?.runs && <RunHistory runs={stageCtx.runs} />}
        </div>
      ) : stageDef && definition ? (
        <div className="flex-1 overflow-hidden min-h-0">
          <ConfigPanel
            stage={stageDef}
            definition={definition}
            onClose={onClose}
            readonly
          />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4">
          <div className="text-xs text-text-tertiary py-2">Configuration not available.</div>
        </div>
      )}
    </div>
  );
}
