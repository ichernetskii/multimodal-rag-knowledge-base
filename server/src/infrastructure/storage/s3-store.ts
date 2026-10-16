import { createHash } from 'node:crypto';
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { DeploymentConfig } from '../../config/saas-config.js';
import { requireValue } from '../../shared/errors.js';
export class ObjectStore {
  readonly client: S3Client;
  readonly bucket: string;
  constructor(config: DeploymentConfig['storage']) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      maxAttempts: 3,
      requestHandler: { connectionTimeout: 3000, requestTimeout: 30000 },
    });
  }
  async initialize() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (e) {
      if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404)
        throw e;
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }
  async health() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }
  async put(key: string, bytes: Uint8Array, mime = 'application/octet-stream') {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: mime }),
    );
  }
  async *read(key: string, range?: string, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, ...(range ? { Range: range } : {}) }),
      signal ? { abortSignal: signal } : {},
    );
    requireValue(result.Body, 'OBJECT_MISSING', 'Stored object is missing.', 404);
    for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
      signal?.throwIfAborted();
      yield chunk;
    }
  }
  async bytes(key: string, maxBytes = 104857600, signal?: AbortSignal) {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of this.read(key, undefined, signal)) {
      length += chunk.length;
      requireValue(
        length <= maxBytes,
        'OBJECT_LIMIT',
        'Stored object exceeds the configured size.',
        413,
      );
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
  }
  async digest(key: string, expectedBytes: number, signal?: AbortSignal) {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of this.read(key, undefined, signal)) {
      bytes += chunk.length;
      requireValue(
        bytes <= expectedBytes,
        'UPLOAD_SIZE',
        'Uploaded object is larger than declared.',
        413,
      );
      hash.update(chunk);
    }
    requireValue(bytes === expectedBytes, 'UPLOAD_SIZE', 'Uploaded object size does not match.');
    return hash.digest('hex');
  }
  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async copy(from: string, to: string, signal?: AbortSignal) {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: to,
        CopySource: encodeURIComponent(this.bucket + '/' + from),
      }),
      signal ? { abortSignal: signal } : {},
    );
  }
  async multipart(key: string, mime: string) {
    const r = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: mime }),
    );
    requireValue(r.UploadId, 'STORAGE_ERROR', 'Storage did not return an upload ID.', 503);
    return r.UploadId;
  }
  async part(key: string, uploadId: string, part: number, bytes: Uint8Array) {
    const r = await this.client.send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: part,
        Body: bytes,
      }),
    );
    requireValue(r.ETag, 'STORAGE_ERROR', 'Missing upload part ETag.', 503);
    return r.ETag;
  }
  async complete(key: string, uploadId: string, parts: { PartNumber: number; ETag: string }[]) {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
  }
  async abort(key: string, uploadId: string) {
    await this.client.send(
      new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
    );
  }
  async keys(prefix: string) {
    let continuation: string | undefined;
    const keys: string[] = [];
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(continuation ? { ContinuationToken: continuation } : {}),
        }),
      );
      for (const o of r.Contents ?? []) if (o.Key) keys.push(o.Key);
      continuation = r.NextContinuationToken;
    } while (continuation);
    return keys;
  }
  close() {
    this.client.destroy();
  }
}
