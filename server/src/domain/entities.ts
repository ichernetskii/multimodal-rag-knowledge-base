export * from '../contracts/public.js';
import type { Version, UploadSession } from '../contracts/public.js';
export interface StoredVersion extends Version {
  original: string;
}
export interface StoredUpload extends UploadSession {
  owner: string;
  key: string;
  uploadId: string;
  parts: { PartNumber: number; ETag: string }[];
  collection: string;
  conversation: string;
  document: string;
  revision: number;
  created: number;
  result?: unknown;
}
export interface Asset {
  id: string;
  object_key: string;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  document_id: string | null;
  version_id: string | null;
  created: number;
}
