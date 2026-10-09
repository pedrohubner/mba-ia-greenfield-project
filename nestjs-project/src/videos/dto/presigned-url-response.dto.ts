import { ApiProperty } from '@nestjs/swagger';

export class PresignedUrlResponseDto {
  @ApiProperty({ description: 'Presigned GET URL served by object storage' })
  url: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expires_at: string;
}
