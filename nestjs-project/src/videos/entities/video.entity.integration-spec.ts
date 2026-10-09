import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generatePublicId } from '../public-id.util';
import {
  Video,
  VideoProcessingStatus,
  VideoPublicationStatus,
} from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const TEN_GIB = 10 * 1024 * 1024 * 1024;

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const index = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${index}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${index}`,
        nickname: `video-channel-${index}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channel: Channel, overrides: Partial<Video> = {}): Video {
    return videoRepository.create({
      public_id: generatePublicId(),
      channel_id: channel.id,
      title: 'My video',
      original_filename: 'my-video.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      object_key: 'videos/placeholder/original.mp4',
      ...overrides,
    });
  }

  it('should default to pending_upload, draft and null metadata', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(buildVideo(channel));

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.processing_status).toBe(VideoProcessingStatus.PENDING_UPLOAD);
    expect(found.publication_status).toBe(VideoPublicationStatus.DRAFT);
    expect(found).toMatchObject({
      upload_id: null,
      thumbnail_key: null,
      processing_error: null,
      duration_seconds: null,
      width: null,
      height: null,
      video_codec: null,
      audio_codec: null,
      container_format: null,
      bitrate: null,
    });
  });

  it('should enforce a unique public_id', async () => {
    const channel = await createChannel();
    const publicId = generatePublicId();
    await videoRepository.save(buildVideo(channel, { public_id: publicId }));

    await expect(
      videoRepository.save(buildVideo(channel, { public_id: publicId })),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
  });

  it('should delete videos in cascade when their channel is removed', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(buildVideo(channel));

    await channelRepository.delete({ id: channel.id });

    expect(await videoRepository.findOneBy({ id: saved.id })).toBeNull();
  });

  it('should reject a video whose channel does not exist', async () => {
    const channel = await createChannel();
    await channelRepository.delete({ id: channel.id });

    await expect(
      videoRepository.save(buildVideo(channel)),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
  });

  it('should read bigint columns back as numbers up to 10 GiB', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      buildVideo(channel, { size_bytes: TEN_GIB, bitrate: 8_000_000 }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.size_bytes).toBe(TEN_GIB);
    expect(found.bitrate).toBe(8_000_000);
  });
});
