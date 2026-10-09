import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  MAX_VIDEO_SIZE_BYTES,
  VIDEO_FILENAME_MAX_LENGTH,
  VIDEO_TITLE_MAX_LENGTH,
} from '../videos.constants';

export class CreateVideoDto {
  /**
   * Original file name; must include an extension
   * @example "aula.mp4"
   */
  @IsString()
  @MinLength(1)
  @MaxLength(VIDEO_FILENAME_MAX_LENGTH)
  @Matches(/\.[A-Za-z0-9]+$/, { message: 'filename must have an extension' })
  filename: string;

  /**
   * Declared file size in bytes (max 10 GiB)
   * @example 10485760
   */
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_SIZE_BYTES)
  size_bytes: number;

  /**
   * MIME type; `video/mp4` or `video/webm`
   * @example "video/mp4"
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  content_type: string;

  /**
   * Optional title; defaults to the filename without its extension
   * @example "Minha aula"
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(VIDEO_TITLE_MAX_LENGTH)
  title?: string;
}
