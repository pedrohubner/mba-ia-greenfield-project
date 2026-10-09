import { ApiProperty } from '@nestjs/swagger';

export class SignedPartUrlDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ description: 'Presigned UploadPart URL (HTTP PUT)' })
  url: string;
}

export class SignPartUrlsResponseDto {
  @ApiProperty({ type: [SignedPartUrlDto] })
  parts: SignedPartUrlDto[];

  @ApiProperty({ type: String, format: 'date-time' })
  expires_at: string;
}

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: '"5d41402abc4b2a76b9719d911017c592"' })
  etag: string;

  @ApiProperty({ example: 67108864 })
  size: number;
}

export class UploadedPartsResponseDto {
  @ApiProperty({ example: 67108864 })
  part_size: number;

  @ApiProperty({ example: 160 })
  part_count: number;

  @ApiProperty({ type: [UploadedPartDto] })
  parts: UploadedPartDto[];
}
