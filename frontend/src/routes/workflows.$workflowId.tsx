import { createFileRoute } from '@tanstack/react-router';
import { WorkflowEditor } from '../components/WorkflowEditor';

export const Route = createFileRoute('/workflows/$workflowId')({
  component: EditWorkflow,
});

function EditWorkflow() {
  const { workflowId } = Route.useParams();
  return <WorkflowEditor workflowId={workflowId} />;
}
