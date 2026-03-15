import * as restate from '@restatedev/restate-sdk';
import { initializeRegistry } from '../nodes/registry.js';
import { pipelineWorkflow } from './pipeline-workflow.js';

// Initialize node registry before binding the workflow endpoint
await initializeRegistry();

const endpoint = restate.endpoint();
endpoint.bind(pipelineWorkflow);

const port = parseInt(process.env.RESTATE_SERVICE_PORT || '9080', 10);
endpoint.listen(port);
console.log(`Restate services listening on port ${port}`);
