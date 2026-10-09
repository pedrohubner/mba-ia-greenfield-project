import { MEDIA_REASON_CODES, type MediaReasonCode } from './media.constants';

export abstract class MediaRejectedError extends Error {
  constructor(
    public readonly reasonCode: MediaReasonCode,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class InvalidMediaError extends MediaRejectedError {
  constructor(message = 'The file is not a readable video') {
    super(MEDIA_REASON_CODES.INVALID_MEDIA, message);
  }
}

export class UnsupportedCodecError extends MediaRejectedError {
  constructor(message = 'The video container or codec is not supported') {
    super(MEDIA_REASON_CODES.UNSUPPORTED_CODEC, message);
  }
}
