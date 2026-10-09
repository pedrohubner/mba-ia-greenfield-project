import {
  ArgumentMetadata,
  BadRequestException,
  ValidationPipe,
} from '@nestjs/common';
import { CompleteUploadDto } from './complete-upload.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const metadata: ArgumentMetadata = {
  type: 'body',
  metatype: CompleteUploadDto,
  data: '',
};

async function validationMessages(body: unknown): Promise<string[]> {
  try {
    await pipe.transform(body, metadata);
  } catch (error) {
    const response = (error as BadRequestException).getResponse() as {
      message: string[];
    };
    return response.message;
  }
  return [];
}

describe('CompleteUploadDto', () => {
  it('should accept distinct parts with non-empty etags', async () => {
    expect(
      await validationMessages({
        parts: [
          { part_number: 1, etag: '"a"' },
          { part_number: 2, etag: '"b"' },
        ],
      }),
    ).toEqual([]);
  });

  it('should reject duplicated part numbers', async () => {
    const messages = await validationMessages({
      parts: [
        { part_number: 1, etag: '"a"' },
        { part_number: 1, etag: '"b"' },
      ],
    });

    expect(messages.join(' ')).toContain('distinct part_number');
  });

  it('should reject an empty etag', async () => {
    const messages = await validationMessages({
      parts: [{ part_number: 1, etag: '' }],
    });

    expect(messages.join(' ')).toContain('etag');
  });

  it('should reject a missing parts array', async () => {
    const messages = await validationMessages({});

    expect(messages.join(' ')).toContain('parts');
  });
});
