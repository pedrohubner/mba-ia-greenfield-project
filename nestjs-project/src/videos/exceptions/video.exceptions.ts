import { DomainException } from '../../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class UnsupportedMediaTypeException extends DomainException {
  constructor() {
    super('UNSUPPORTED_MEDIA_TYPE', 415, 'Unsupported video format');
  }
}

export class InvalidUploadStateException extends DomainException {
  constructor() {
    super(
      'INVALID_UPLOAD_STATE',
      409,
      'Upload is not in a valid state for this operation',
    );
  }
}

export class InvalidUploadPartsException extends DomainException {
  constructor() {
    super(
      'INVALID_UPLOAD_PARTS',
      422,
      'Uploaded parts are invalid or incomplete',
    );
  }
}

export class UploadSizeExceededException extends DomainException {
  constructor() {
    super(
      'UPLOAD_SIZE_EXCEEDED',
      422,
      'Uploaded file exceeds the maximum size',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready yet');
  }
}
