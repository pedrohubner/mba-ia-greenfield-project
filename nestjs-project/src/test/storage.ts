import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import type { DataSource } from 'typeorm';

const bucket = process.env.STORAGE_BUCKET ?? 'streamtube-media';

function createTestS3Client(): S3Client {
  return new S3Client({
    endpoint: process.env.STORAGE_ENDPOINT ?? 'http://minio:9000',
    region: process.env.STORAGE_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.STORAGE_ACCESS_KEY ?? '',
      secretAccessKey: process.env.STORAGE_SECRET_KEY ?? '',
    },
    forcePathStyle: true,
  });
}

export function createTestKeyPrefix(suite: string): string {
  return `test/${suite}-${randomUUID()}/`;
}

export async function cleanupStoragePrefix(prefix: string): Promise<void> {
  const client = createTestS3Client();
  try {
    const uploads = await client.send(
      new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix }),
    );
    for (const upload of uploads.Uploads ?? []) {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: upload.Key,
          UploadId: upload.UploadId,
        }),
      );
    }

    let continuationToken: string | undefined;
    do {
      const listed = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      const objects = (listed.Contents ?? []).map((object) => ({
        Key: object.Key,
      }));
      if (objects.length > 0) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: objects },
          }),
        );
      }
      continuationToken = listed.NextContinuationToken;
    } while (continuationToken);
  } finally {
    client.destroy();
  }
}

export async function cleanupVideoStorage(
  dataSource: DataSource,
): Promise<void> {
  const rows = await dataSource.query<{ id: string }[]>(
    'SELECT id FROM "videos"',
  );
  for (const { id } of rows) {
    await cleanupStoragePrefix(`videos/${id}/`);
    await cleanupStoragePrefix(`thumbnails/${id}/`);
  }
}
