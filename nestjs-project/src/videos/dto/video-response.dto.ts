import { ApiProperty } from '@nestjs/swagger';
import {
  VideoProcessingStatus,
  VideoPublicationStatus,
} from '../entities/video.entity';

export class VideoResponseDto {
  @ApiProperty({ example: 'dQw4w9WgXcQ', minLength: 11, maxLength: 11 })
  public_id: string;

  @ApiProperty({ example: 'Minha aula' })
  title: string;

  @ApiProperty({ example: 'aula.mp4' })
  original_filename: string;

  @ApiProperty({ example: 'video/mp4' })
  content_type: string;

  @ApiProperty({ example: 10485760 })
  size_bytes: number;

  @ApiProperty({
    enum: VideoProcessingStatus,
    enumName: 'VideoProcessingStatus',
  })
  processing_status: VideoProcessingStatus;

  @ApiProperty({
    enum: VideoPublicationStatus,
    enumName: 'VideoPublicationStatus',
  })
  publication_status: VideoPublicationStatus;

  @ApiProperty({ type: String, nullable: true, example: null })
  processing_error: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 3.0 })
  duration_seconds: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'h264' })
  video_codec: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'aac' })
  audio_codec: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'mov,mp4,m4a,3gp,3g2,mj2',
  })
  container_format: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 1500000 })
  bitrate: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Presigned GET URL for the thumbnail; null until ready',
  })
  thumbnail_url: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  created_at: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updated_at: string;
}

export class UploadInstructionsDto {
  @ApiProperty({
    example: 67108864,
    description: 'Size of every non-last part',
  })
  part_size: number;

  @ApiProperty({ example: 160, description: 'ceil(size_bytes / part_size)' })
  part_count: number;
}

export class InitiateUploadResponseDto {
  @ApiProperty({ type: VideoResponseDto })
  video: VideoResponseDto;

  @ApiProperty({ type: UploadInstructionsDto })
  upload: UploadInstructionsDto;
}
