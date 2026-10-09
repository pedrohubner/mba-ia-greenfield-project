import { Injectable } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { FFPROBE_TIMEOUT_MS } from './media.constants';
import { InvalidMediaError } from './media.errors';

const execFileAsync = promisify(execFile);

const UNREADABLE_INPUT_MESSAGE = 'Invalid data found when processing input';

export interface ProbeResult {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  containerFormat: string | null;
  bitrate: number | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: {
    format_name?: string;
    duration?: string | number;
    bit_rate?: string | number;
  };
}

function toNumber(value: string | number | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseProbeOutput(output: string): ProbeResult {
  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(output) as FfprobeOutput;
  } catch {
    throw new InvalidMediaError('ffprobe output is not valid JSON');
  }
  if (!parsed.format || !Array.isArray(parsed.streams)) {
    throw new InvalidMediaError('ffprobe found no container information');
  }

  const videoStream = parsed.streams.find((s) => s.codec_type === 'video');
  const audioStream = parsed.streams.find((s) => s.codec_type === 'audio');

  return {
    durationSeconds: toNumber(parsed.format.duration),
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    videoCodec: videoStream?.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
    containerFormat: parsed.format.format_name ?? null,
    bitrate: toNumber(parsed.format.bit_rate),
  };
}

function isUnreadableInput(error: unknown): boolean {
  const stderr = (error as { stderr?: string }).stderr ?? '';
  return stderr.includes(UNREADABLE_INPUT_MESSAGE);
}

@Injectable()
export class MediaProbeService {
  async probe(source: string): Promise<ProbeResult> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          source,
        ],
        { timeout: FFPROBE_TIMEOUT_MS },
      ));
    } catch (error) {
      if (isUnreadableInput(error)) {
        throw new InvalidMediaError();
      }
      throw error;
    }
    return parseProbeOutput(stdout);
  }
}
