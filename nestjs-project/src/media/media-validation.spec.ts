import { MEDIA_REASON_CODES } from './media.constants';
import type { MediaRejectedError } from './media.errors';
import type { ProbeResult } from './media-probe.service';
import { assertPlayable } from './media-validation';

function probe(overrides: Partial<ProbeResult>): ProbeResult {
  return {
    durationSeconds: 3,
    width: 1920,
    height: 1080,
    videoCodec: 'h264',
    audioCodec: 'aac',
    containerFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
    bitrate: 1_000_000,
    ...overrides,
  };
}

function reasonCodeOf(result: ProbeResult): string | undefined {
  try {
    assertPlayable(result);
  } catch (error) {
    return (error as MediaRejectedError).reasonCode;
  }
  return undefined;
}

describe('assertPlayable', () => {
  it('should accept MP4 with H.264 video', () => {
    expect(() => assertPlayable(probe({}))).not.toThrow();
  });

  it.each(['vp8', 'vp9', 'av1'])(
    'should accept WebM with %s video',
    (codec) => {
      expect(() =>
        assertPlayable(
          probe({ containerFormat: 'matroska,webm', videoCodec: codec }),
        ),
      ).not.toThrow();
    },
  );

  it('should classify a file without a video stream as INVALID_MEDIA', () => {
    expect(reasonCodeOf(probe({ videoCodec: null }))).toBe(
      MEDIA_REASON_CODES.INVALID_MEDIA,
    );
  });

  it('should classify MP4 with MPEG-4 Part 2 video as UNSUPPORTED_CODEC', () => {
    expect(reasonCodeOf(probe({ videoCodec: 'mpeg4' }))).toBe(
      MEDIA_REASON_CODES.UNSUPPORTED_CODEC,
    );
  });

  it('should classify WebM with H.264 video as UNSUPPORTED_CODEC', () => {
    expect(reasonCodeOf(probe({ containerFormat: 'matroska,webm' }))).toBe(
      MEDIA_REASON_CODES.UNSUPPORTED_CODEC,
    );
  });

  it('should classify a container outside the whitelist as UNSUPPORTED_CODEC', () => {
    expect(reasonCodeOf(probe({ containerFormat: 'avi' }))).toBe(
      MEDIA_REASON_CODES.UNSUPPORTED_CODEC,
    );
  });
});
