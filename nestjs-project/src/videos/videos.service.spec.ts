import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { UnsupportedMediaTypeException } from './exceptions/video.exceptions';
import { VideosService } from './videos.service';

const PART_SIZE = 5 * 1024 * 1024;
const USER_ID = 'user-1';
const CHANNEL_ID = 'channel-1';

function uniqueViolation(column: string): QueryFailedError {
  const error = new QueryFailedError('INSERT', [], new Error('duplicate'));
  Object.assign(error, {
    code: '23505',
    detail: `Key (${column})=(x) already exists.`,
  });
  return error;
}

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: { create: jest.Mock; save: jest.Mock };
  let storageService: {
    createMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
    signGetObjectUrl: jest.Mock;
  };
  let channelsService: { findByUserId: jest.Mock };

  const dto = {
    filename: 'aula.mp4',
    size_bytes: 3 * PART_SIZE + 1,
    content_type: 'video/mp4',
  };

  function savedVideo(callIndex: number): Partial<Video> {
    return (videoRepository.save.mock.calls as [Partial<Video>][])[
      callIndex
    ][0];
  }

  beforeEach(async () => {
    videoRepository = {
      create: jest.fn((fields: Partial<Video>) => ({ ...fields })),
      save: jest.fn((video: Partial<Video>) =>
        Promise.resolve({
          ...video,
          processing_status: 'pending_upload',
          publication_status: 'draft',
          thumbnail_key: null,
          created_at: new Date(),
          updated_at: new Date(),
        }),
      ),
    };
    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      signGetObjectUrl: jest.fn(),
    };
    channelsService = {
      findByUserId: jest.fn().mockResolvedValue({ id: CHANNEL_ID }),
    };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
        { provide: ChannelsService, useValue: channelsService },
        {
          provide: storageConfig.KEY,
          useValue: { partSizeBytes: PART_SIZE, thumbnailUrlTtlSeconds: 3600 },
        },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  it('should reject content types outside the whitelist before touching storage', async () => {
    await expect(
      service.initiateUpload(USER_ID, {
        ...dto,
        content_type: 'video/x-matroska',
      }),
    ).rejects.toThrow(UnsupportedMediaTypeException);

    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    expect(videoRepository.save).not.toHaveBeenCalled();
  });

  it('should compute part_count as ceil(size_bytes / part_size)', async () => {
    const result = await service.initiateUpload(USER_ID, dto);

    expect(result.upload).toEqual({ part_size: PART_SIZE, part_count: 4 });
  });

  it('should key the original object by the generated video id and extension', async () => {
    await service.initiateUpload(USER_ID, { ...dto, filename: 'Aula.MP4' });

    const [key, contentType] = storageService.createMultipartUpload.mock
      .calls[0] as [string, string];
    const saved = savedVideo(0);
    expect(key).toBe(`videos/${saved.id}/original.mp4`);
    expect(contentType).toBe('video/mp4');
    expect(saved).toMatchObject({
      channel_id: CHANNEL_ID,
      object_key: key,
      upload_id: 'upload-1',
      title: 'Aula',
    });
  });

  it('should retry with a new public_id when the insert collides on public_id', async () => {
    videoRepository.save.mockRejectedValueOnce(uniqueViolation('public_id'));

    await service.initiateUpload(USER_ID, dto);

    expect(videoRepository.save).toHaveBeenCalledTimes(2);
    const first = savedVideo(0);
    const second = savedVideo(1);
    expect(second.public_id).not.toBe(first.public_id);
    expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it('should abort the multipart upload and rethrow when the insert fails', async () => {
    const failure = new Error('db down');
    videoRepository.save.mockRejectedValueOnce(failure);

    await expect(service.initiateUpload(USER_ID, dto)).rejects.toBe(failure);

    const saved = savedVideo(0);
    expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
      saved.object_key,
      'upload-1',
    );
  });

  it('should still rethrow the insert error when the best-effort abort fails', async () => {
    const failure = new Error('db down');
    videoRepository.save.mockRejectedValueOnce(failure);
    storageService.abortMultipartUpload.mockRejectedValueOnce(
      new Error('storage down'),
    );

    await expect(service.initiateUpload(USER_ID, dto)).rejects.toBe(failure);
  });

  it('should not expose internal fields in the response', async () => {
    const { video } = await service.initiateUpload(USER_ID, dto);

    for (const key of [
      'id',
      'channel_id',
      'object_key',
      'upload_id',
      'thumbnail_key',
    ]) {
      expect(video).not.toHaveProperty(key);
    }
    expect(video.thumbnail_url).toBeNull();
  });
});
