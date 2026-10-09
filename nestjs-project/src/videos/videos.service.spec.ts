import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import storageConfig from '../config/storage.config';
import { S3ServiceException } from '@aws-sdk/client-s3';
import { StorageService } from '../storage/storage.service';
import { VideoProcessingProducer } from '../video-processing/video-processing.producer';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import {
  InvalidUploadPartsException,
  InvalidUploadStateException,
  UnsupportedMediaTypeException,
  UploadSizeExceededException,
  VideoNotFoundException,
} from './exceptions/video.exceptions';
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
  let videoRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    delete: jest.Mock;
  };
  let producer: { enqueueProcessing: jest.Mock };
  let storageService: {
    createMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
    signGetObjectUrl: jest.Mock;
    signUploadPartUrl: jest.Mock;
    completeMultipartUpload: jest.Mock;
    headObject: jest.Mock;
    deleteObject: jest.Mock;
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
      findOne: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    producer = { enqueueProcessing: jest.fn().mockResolvedValue(undefined) };
    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      signGetObjectUrl: jest.fn(),
      signUploadPartUrl: jest.fn(
        (key: string, uploadId: string, partNumber: number) =>
          Promise.resolve(`https://storage.test/${key}?part=${partNumber}`),
      ),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn().mockResolvedValue({ contentLength: 2 * PART_SIZE }),
      deleteObject: jest.fn().mockResolvedValue(undefined),
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
        { provide: VideoProcessingProducer, useValue: producer },
        {
          provide: storageConfig.KEY,
          useValue: {
            partSizeBytes: PART_SIZE,
            thumbnailUrlTtlSeconds: 3600,
            partUrlTtlSeconds: 3600,
          },
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

  describe('findOwnedOrFail', () => {
    it('should reject a malformed publicId without querying the database', async () => {
      await expect(
        service.findOwnedOrFail(USER_ID, 'not-a-valid-id'),
      ).rejects.toThrow(VideoNotFoundException);

      expect(videoRepository.findOne).not.toHaveBeenCalled();
    });

    it("should throw the same VideoNotFoundException for missing and other users' videos", async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findOwnedOrFail(USER_ID, 'AAAAAAAAAAA'),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('should scope the lookup to the caller through the channel owner', async () => {
      videoRepository.findOne.mockResolvedValue({ id: 'video-1' });

      await service.findOwnedOrFail(USER_ID, 'AAAAAAAAAAA');

      expect(videoRepository.findOne).toHaveBeenCalledWith({
        where: { public_id: 'AAAAAAAAAAA', channel: { user_id: USER_ID } },
      });
    });
  });

  describe('assertPendingUpload', () => {
    it.each([
      VideoProcessingStatus.UPLOADED,
      VideoProcessingStatus.PROCESSING,
      VideoProcessingStatus.READY,
      VideoProcessingStatus.FAILED,
    ])('should reject a video in %s', (status) => {
      expect(() =>
        service.assertPendingUpload({
          processing_status: status,
          upload_id: 'upload-1',
        } as Video),
      ).toThrow(InvalidUploadStateException);
    });

    it('should accept a pending upload with an open multipart upload', () => {
      expect(() =>
        service.assertPendingUpload({
          processing_status: VideoProcessingStatus.PENDING_UPLOAD,
          upload_id: 'upload-1',
        } as Video),
      ).not.toThrow();
    });
  });

  describe('signPartUrls', () => {
    const pendingVideo = {
      object_key: 'videos/v1/original.mp4',
      upload_id: 'upload-1',
      size_bytes: 3 * PART_SIZE,
      processing_status: VideoProcessingStatus.PENDING_UPLOAD,
    };

    beforeEach(() => {
      videoRepository.findOne.mockResolvedValue(pendingVideo);
    });

    it('should reject a part number above part_count', async () => {
      await expect(
        service.signPartUrls(USER_ID, 'AAAAAAAAAAA', [1, 4]),
      ).rejects.toThrow(InvalidUploadPartsException);

      expect(storageService.signUploadPartUrl).not.toHaveBeenCalled();
    });

    it('should sign every requested part and expire after the configured TTL', async () => {
      const before = Date.now();

      const result = await service.signPartUrls(USER_ID, 'AAAAAAAAAAA', [1, 3]);

      expect(result.parts.map((part) => part.part_number)).toEqual([1, 3]);
      expect(storageService.signUploadPartUrl).toHaveBeenCalledWith(
        'videos/v1/original.mp4',
        'upload-1',
        3,
        3600,
      );
      const expiresAt = new Date(result.expires_at).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
    });
  });

  describe('completeUpload', () => {
    const parts = [
      { part_number: 2, etag: '"etag-2"' },
      { part_number: 1, etag: '"etag-1"' },
    ];

    function videoIn(status: VideoProcessingStatus): Partial<Video> {
      return {
        id: 'video-1',
        object_key: 'videos/video-1/original.mp4',
        upload_id:
          status === VideoProcessingStatus.PENDING_UPLOAD ? 'upload-1' : null,
        size_bytes: 2 * PART_SIZE,
        processing_status: status,
        thumbnail_key: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
    }

    it('should only re-enqueue an uploaded video without touching storage', async () => {
      videoRepository.findOne.mockResolvedValue(
        videoIn(VideoProcessingStatus.UPLOADED),
      );

      const result = await service.completeUpload(
        USER_ID,
        'AAAAAAAAAAA',
        parts,
      );

      expect(result.processing_status).toBe(VideoProcessingStatus.UPLOADED);
      expect(producer.enqueueProcessing).toHaveBeenCalledWith('video-1');
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.save).not.toHaveBeenCalled();
    });

    it.each([
      VideoProcessingStatus.PROCESSING,
      VideoProcessingStatus.READY,
      VideoProcessingStatus.FAILED,
    ])(
      'should reject a video in %s with InvalidUploadStateException',
      async (status) => {
        videoRepository.findOne.mockResolvedValue(videoIn(status));

        await expect(
          service.completeUpload(USER_ID, 'AAAAAAAAAAA', parts),
        ).rejects.toThrow(InvalidUploadStateException);
        expect(producer.enqueueProcessing).not.toHaveBeenCalled();
      },
    );

    it.each(['InvalidPart', 'InvalidPartOrder', 'EntityTooSmall'])(
      'should map the storage %s error to InvalidUploadPartsException',
      async (name) => {
        videoRepository.findOne.mockResolvedValue(
          videoIn(VideoProcessingStatus.PENDING_UPLOAD),
        );
        storageService.completeMultipartUpload.mockRejectedValue(
          new S3ServiceException({ name, $fault: 'client', $metadata: {} }),
        );

        await expect(
          service.completeUpload(USER_ID, 'AAAAAAAAAAA', parts),
        ).rejects.toThrow(InvalidUploadPartsException);
        expect(videoRepository.save).not.toHaveBeenCalled();
      },
    );

    it('should rethrow other storage errors unchanged', async () => {
      videoRepository.findOne.mockResolvedValue(
        videoIn(VideoProcessingStatus.PENDING_UPLOAD),
      );
      const failure = new Error('connection reset');
      storageService.completeMultipartUpload.mockRejectedValue(failure);

      await expect(
        service.completeUpload(USER_ID, 'AAAAAAAAAAA', parts),
      ).rejects.toBe(failure);
    });

    it('should delete the object and the row when the stored object exceeds 10 GiB', async () => {
      videoRepository.findOne.mockResolvedValue(
        videoIn(VideoProcessingStatus.PENDING_UPLOAD),
      );
      storageService.headObject.mockResolvedValue({
        contentLength: 10 * 1024 * 1024 * 1024 + 1,
      });

      await expect(
        service.completeUpload(USER_ID, 'AAAAAAAAAAA', parts),
      ).rejects.toThrow(UploadSizeExceededException);
      expect(storageService.deleteObject).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
      );
      expect(videoRepository.delete).toHaveBeenCalledWith({ id: 'video-1' });
      expect(producer.enqueueProcessing).not.toHaveBeenCalled();
    });

    it('should persist uploaded with the real size and enqueue only after saving', async () => {
      videoRepository.findOne.mockResolvedValue(
        videoIn(VideoProcessingStatus.PENDING_UPLOAD),
      );
      storageService.headObject.mockResolvedValue({ contentLength: 7340032 });

      await service.completeUpload(USER_ID, 'AAAAAAAAAAA', parts);

      expect(savedVideo(0)).toMatchObject({
        size_bytes: 7340032,
        upload_id: null,
        processing_status: VideoProcessingStatus.UPLOADED,
      });
      expect(producer.enqueueProcessing).toHaveBeenCalledWith('video-1');
      expect(videoRepository.save.mock.invocationCallOrder[0]).toBeLessThan(
        producer.enqueueProcessing.mock.invocationCallOrder[0],
      );
    });

    it('should leave the video uploaded when the enqueue fails after saving', async () => {
      videoRepository.findOne.mockResolvedValue(
        videoIn(VideoProcessingStatus.PENDING_UPLOAD),
      );
      producer.enqueueProcessing.mockRejectedValue(new Error('redis down'));

      await expect(
        service.completeUpload(USER_ID, 'AAAAAAAAAAA', parts),
      ).rejects.toThrow('redis down');
      expect(savedVideo(0).processing_status).toBe(
        VideoProcessingStatus.UPLOADED,
      );
    });
  });
});
