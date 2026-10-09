import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { cleanupStoragePrefix, createTestKeyPrefix } from '../test/storage';
import { StorageModule } from './storage.module';
import { CompletedPart, StorageService } from './storage.service';

const PART_SIZE = 5 * 1024 * 1024;

function partBody(fill: number, size = PART_SIZE): Buffer {
  return Buffer.alloc(size, fill);
}

describe('StorageService (integration)', () => {
  let module: TestingModule;
  let service: StorageService;
  const prefix = createTestKeyPrefix('storage-service');

  async function uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<Response> {
    const url = await service.signUploadPartUrl(key, uploadId, partNumber, 600);
    return fetch(url, { method: 'PUT', body: new Uint8Array(body) });
  }

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    service = module.get(StorageService);
  });

  afterAll(async () => {
    await cleanupStoragePrefix(prefix);
    await module.close();
  });

  it('accepts a part PUT on a public-audience signed URL and returns an ETag', async () => {
    const key = `${prefix}put-part.mp4`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');

    const url = await service.signUploadPartUrl(key, uploadId, 1, 600);
    expect(new URL(url).origin).toBe(
      new URL(process.env.STORAGE_PUBLIC_ENDPOINT!).origin,
    );

    const response = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(partBody(1)),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBeTruthy();
  });

  it('lists uploaded parts in ascending order with the storage ETags', async () => {
    const key = `${prefix}list-parts.mp4`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');

    const etags = new Map<number, string>();
    for (const partNumber of [3, 1, 2]) {
      const response = await uploadPart(
        key,
        uploadId,
        partNumber,
        partBody(partNumber),
      );
      etags.set(partNumber, response.headers.get('etag')!);
    }

    const parts = await service.listParts(key, uploadId);

    expect(parts).toEqual([
      { partNumber: 1, etag: etags.get(1), size: PART_SIZE },
      { partNumber: 2, etag: etags.get(2), size: PART_SIZE },
      { partNumber: 3, etag: etags.get(3), size: PART_SIZE },
    ]);
  });

  it('completes a multipart upload with parts given out of order', async () => {
    const key = `${prefix}complete.mp4`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const first = await uploadPart(key, uploadId, 1, partBody(1));
    const second = await uploadPart(key, uploadId, 2, partBody(2, 1024));

    const parts: CompletedPart[] = [
      { partNumber: 2, etag: second.headers.get('etag')! },
      { partNumber: 1, etag: first.headers.get('etag')! },
    ];
    await service.completeMultipartUpload(key, uploadId, parts);

    const head = await service.headObject(key);
    expect(head.contentLength).toBe(PART_SIZE + 1024);
    expect(head.contentType).toBe('video/mp4');
  });

  it('discards uploaded parts on abort so listing the upload fails with NoSuchUpload', async () => {
    const key = `${prefix}abort.mp4`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    await uploadPart(key, uploadId, 1, partBody(1));

    await service.abortMultipartUpload(key, uploadId);

    await expect(service.listParts(key, uploadId)).rejects.toMatchObject({
      name: 'NoSuchUpload',
    });
  });

  it('serves a signed GET URL with Range as 206 partial content', async () => {
    const key = `${prefix}range.bin`;
    const body = partBody(7, 1000);
    await service.putObject(key, body, 'application/octet-stream');

    const url = await service.signGetObjectUrl(key, {
      audience: 'internal',
      ttlSeconds: 600,
    });
    const response = await fetch(url, { headers: { Range: 'bytes=0-99' } });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-99/1000');
    expect((await response.arrayBuffer()).byteLength).toBe(100);
  });

  it('deletes an object so a subsequent head fails with NotFound', async () => {
    const key = `${prefix}delete.bin`;
    await service.putObject(key, partBody(1, 10), 'application/octet-stream');

    await service.deleteObject(key);

    await expect(service.headObject(key)).rejects.toMatchObject({
      name: 'NotFound',
    });
  });
});
