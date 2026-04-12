import { AssistantChat } from './AssistantChat';
import { ResizablePanel } from '../ui/ResizablePanel';

interface AssistantDockProps {
  isOpen: boolean;
}

export function AssistantDock({ isOpen }: AssistantDockProps) {
  if (!isOpen) return null;

  return (
    <ResizablePanel
      side="left"
      defaultWidth={400}
      minWidth={280}
      maxWidth={700}
      className="border-r border-border bg-surface flex flex-col"
    >
      <div className="flex-1 min-h-0 overflow-hidden">
        <AssistantChat />
      </div>
    </ResizablePanel>
  );
}
