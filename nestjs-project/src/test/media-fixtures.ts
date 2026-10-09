import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface MediaFixtures {
  dir: string;
  h264Mp4: string;
  vp9Webm: string;
  mpeg4Mp4: string;
  randomBytes: string;
  cleanup: () => Promise<void>;
}

const TEST_PATTERN = 'testsrc=duration=3:size=1920x1080:rate=25';
const TEST_TONE = 'sine=frequency=440:duration=3';

async function ffmpeg(args: string[]): Promise<void> {
  await execFileAsync('ffmpeg', ['-v', 'error', '-y', ...args]);
}

export async function createMediaFixtures(): Promise<MediaFixtures> {
  const dir = await mkdtemp(join(tmpdir(), 'streamtube-media-'));
  const fixtures: MediaFixtures = {
    dir,
    h264Mp4: join(dir, 'h264.mp4'),
    vp9Webm: join(dir, 'vp9.webm'),
    mpeg4Mp4: join(dir, 'mpeg4.mp4'),
    randomBytes: join(dir, 'random.mp4'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };

  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    TEST_PATTERN,
    '-f',
    'lavfi',
    '-i',
    TEST_TONE,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    fixtures.h264Mp4,
  ]);
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    TEST_PATTERN,
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
    '-b:v',
    '1M',
    fixtures.vp9Webm,
  ]);
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    TEST_PATTERN,
    '-c:v',
    'mpeg4',
    fixtures.mpeg4Mp4,
  ]);
  await writeFile(fixtures.randomBytes, randomBytes(256 * 1024));

  return fixtures;
}
