import { createFileRoute } from '@tanstack/react-router';
import { WorkflowEditor } from '../components/WorkflowEditor';

export const Route = createFileRoute('/workflows/new')({
  component: NewWorkflow,
});

function NewWorkflow() {
  return <WorkflowEditor />;
}
