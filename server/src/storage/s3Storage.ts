/**
 * Pilote S3-compatible (AWS S3, MinIO, Ceph…). Identifiants lus par la chaîne standard du SDK
 * (variables `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, profil, identité gérée) : aucun secret
 * dans le code ni dans la configuration de l'application.
 */
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ServerConfig } from '../config.ts';
import type { ObjectStorage } from './storage.ts';

type S3Config = Extract<ServerConfig['storage'], { driver: 's3' }>;

export class S3Storage implements ObjectStorage {
  readonly driver = 's3';
  private readonly client: S3Client;
  constructor(private readonly config: S3Config) {
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
    });
  }
  private key(key: string) {
    return `${this.config.prefix}${key}`;
  }
  async putFile(key: string, path: string, meta: { contentType: string; byteLength: number }) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: this.key(key),
        Body: createReadStream(path),
        ContentType: meta.contentType,
        ContentLength: meta.byteLength,
      }),
    );
  }
  async get(key: string): Promise<Readable | null> {
    try {
      const r = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: this.key(key) }),
      );
      return (r.Body as Readable | undefined) ?? null;
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null;
      throw error;
    }
  }
  async exists(key: string) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: this.key(key) }));
      return true;
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
        return false;
      throw error;
    }
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: this.key(key) }));
  }
}
