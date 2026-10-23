import type { Job } from '../../shared/api/contracts.generated';
export const statuses: Record<Job['status'], string> = {
  retrying: 'Waiting to retry',
  queued: 'Queued',
  extracting: 'Preparing material',
  ocr: 'Recognizing pages',
  indexing: 'Indexing',
  searching: 'Finding sources',
  generating: 'Generating',
  complete: 'Complete',
  no_info: 'Insufficient information',
  clarification: 'Clarification required',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
  failed: 'Technical error',
};
