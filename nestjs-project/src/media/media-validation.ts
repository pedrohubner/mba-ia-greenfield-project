import { PLAYABLE_FORMATS } from './media.constants';
import { InvalidMediaError, UnsupportedCodecError } from './media.errors';
import type { ProbeResult } from './media-probe.service';

export function assertPlayable(probe: ProbeResult): void {
  if (!probe.videoCodec) {
    throw new InvalidMediaError('The file has no video stream');
  }

  const containers = (probe.containerFormat ?? '').split(',');
  const videoCodec = probe.videoCodec;
  const playable = PLAYABLE_FORMATS.some(
    (format) =>
      containers.includes(format.container) &&
      (format.videoCodecs as readonly string[]).includes(videoCodec),
  );

  if (!playable) {
    throw new UnsupportedCodecError(
      `Unsupported container/codec: ${probe.containerFormat ?? 'unknown'}/${videoCodec}`,
    );
  }
}
