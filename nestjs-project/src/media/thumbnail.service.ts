import { Injectable } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  FFMPEG_TIMEOUT_MS,
  THUMBNAIL_MAX_BUFFER_BYTES,
  THUMBNAIL_MAX_WIDTH,
} from './media.constants';

const execFileAsync = promisify(execFile);

const THUMBNAIL_POSITION = 0.1;

const THUMBNAIL_END_MARGIN_SECONDS = 0.1;

export function thumbnailTimestamp(durationSeconds: number): number {
  const latest = Math.max(0, durationSeconds - THUMBNAIL_END_MARGIN_SECONDS);
  return Math.min(Math.max(0, durationSeconds * THUMBNAIL_POSITION), latest);
}

@Injectable()
export class ThumbnailService {
  async extractFrame(source: string, atSeconds: number): Promise<Buffer> {
    const { stdout } = await execFileAsync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        String(atSeconds),
        '-i',
        source,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${THUMBNAIL_MAX_WIDTH},iw)':-2`,
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      {
        encoding: 'buffer',
        timeout: FFMPEG_TIMEOUT_MS,
        maxBuffer: THUMBNAIL_MAX_BUFFER_BYTES,
      },
    );
    return stdout;
  }
}
