import { InvalidMediaError } from './media.errors';
import { parseProbeOutput } from './media-probe.service';

const mp4WithAudio = {
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
  format: {
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: '3.000000',
    bit_rate: '1506856',
  },
};

describe('parseProbeOutput', () => {
  it('should map ffprobe JSON to the video metadata columns', () => {
    expect(parseProbeOutput(JSON.stringify(mp4WithAudio))).toEqual({
      durationSeconds: 3,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
      containerFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
      bitrate: 1506856,
    });
  });

  it('should leave audioCodec null when the file has no audio stream', () => {
    const output = { ...mp4WithAudio, streams: [mp4WithAudio.streams[0]] };

    expect(parseProbeOutput(JSON.stringify(output)).audioCodec).toBeNull();
  });

  it('should leave video fields null when the file has no video stream', () => {
    const output = { ...mp4WithAudio, streams: [mp4WithAudio.streams[1]] };

    expect(parseProbeOutput(JSON.stringify(output))).toMatchObject({
      width: null,
      height: null,
      videoCodec: null,
    });
  });

  it('should return null for missing or non-numeric duration and bitrate', () => {
    const output = {
      ...mp4WithAudio,
      format: { format_name: 'matroska,webm', duration: 'N/A' },
    };

    expect(parseProbeOutput(JSON.stringify(output))).toMatchObject({
      durationSeconds: null,
      bitrate: null,
    });
  });

  it('should reject output that is not JSON as invalid media', () => {
    expect(() => parseProbeOutput('not json')).toThrow(InvalidMediaError);
  });

  it('should reject empty ffprobe output as invalid media', () => {
    expect(() => parseProbeOutput('{}')).toThrow(InvalidMediaError);
  });
});
