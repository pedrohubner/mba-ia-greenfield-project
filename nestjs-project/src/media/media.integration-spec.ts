import { Test, TestingModule } from '@nestjs/testing';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import {
  createMediaFixtures,
  type MediaFixtures,
} from '../test/media-fixtures';
import { MEDIA_REASON_CODES } from './media.constants';
import { InvalidMediaError, type MediaRejectedError } from './media.errors';
import { MediaModule } from './media.module';
import { MediaProbeService, type ProbeResult } from './media-probe.service';
import { assertPlayable } from './media-validation';
import { thumbnailTimestamp, ThumbnailService } from './thumbnail.service';

const execFileAsync = promisify(execFile);

function reasonCodeOf(result: ProbeResult): string | undefined {
  try {
    assertPlayable(result);
  } catch (error) {
    return (error as MediaRejectedError).reasonCode;
  }
  return undefined;
}

async function imageSize(
  image: Buffer,
  dir: string,
): Promise<{ width: number; height: number }> {
  const path = join(dir, 'frame.jpg');
  await writeFile(path, image);
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    path,
  ]);
  const [stream] = (
    JSON.parse(stdout) as { streams: { width: number; height: number }[] }
  ).streams;
  return { width: stream.width, height: stream.height };
}

describe('Media services (integration)', () => {
  let module: TestingModule;
  let probeService: MediaProbeService;
  let thumbnailService: ThumbnailService;
  let fixtures: MediaFixtures;

  beforeAll(async () => {
    fixtures = await createMediaFixtures();
    module = await Test.createTestingModule({
      imports: [MediaModule],
    }).compile();
    probeService = module.get(MediaProbeService);
    thumbnailService = module.get(ThumbnailService);
  }, 120000);

  afterAll(async () => {
    await fixtures.cleanup();
    await module.close();
  });

  it('should probe an H.264 MP4 with its duration, size and codecs', async () => {
    const result = await probeService.probe(fixtures.h264Mp4);

    expect(result.durationSeconds).toBeCloseTo(3, 0);
    expect(result).toMatchObject({
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
    expect(result.containerFormat).toContain('mp4');
    expect(result.bitrate).toBeGreaterThan(0);
    expect(reasonCodeOf(result)).toBeUndefined();
  });

  it('should probe a VP9 WebM as playable without audio', async () => {
    const result = await probeService.probe(fixtures.vp9Webm);

    expect(result).toMatchObject({ videoCodec: 'vp9', audioCodec: null });
    expect(result.containerFormat).toContain('webm');
    expect(reasonCodeOf(result)).toBeUndefined();
  });

  it('should classify an MP4 with MPEG-4 Part 2 video as UNSUPPORTED_CODEC', async () => {
    const result = await probeService.probe(fixtures.mpeg4Mp4);

    expect(reasonCodeOf(result)).toBe(MEDIA_REASON_CODES.UNSUPPORTED_CODEC);
  });

  it('should classify random bytes as INVALID_MEDIA', async () => {
    await expect(probeService.probe(fixtures.randomBytes)).rejects.toThrow(
      InvalidMediaError,
    );
  });

  it('should extract a JPEG frame scaled to 1280 wide keeping the aspect ratio', async () => {
    const result = await probeService.probe(fixtures.h264Mp4);

    const frame = await thumbnailService.extractFrame(
      fixtures.h264Mp4,
      thumbnailTimestamp(result.durationSeconds!),
    );

    expect(frame.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(await imageSize(frame, fixtures.dir)).toEqual({
      width: 1280,
      height: 720,
    });
  });

  it('should treat a source containing shell syntax as a literal argument', async () => {
    const marker = join(fixtures.dir, 'injected');
    const source = `${fixtures.h264Mp4}; touch ${marker}`;

    await expect(probeService.probe(source)).rejects.toThrow();
    await expect(thumbnailService.extractFrame(source, 0)).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
  });
});
