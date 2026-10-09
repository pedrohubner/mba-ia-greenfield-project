import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class UploadedPartDto {
  @ApiProperty({ example: 1, description: 'Part number (1-based)' })
  @IsInt()
  @Min(1)
  part_number: number;

  @ApiProperty({
    example: '"5d41402abc4b2a76b9719d911017c592"',
    description: 'ETag returned by storage for the part PUT',
  })
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  @ApiProperty({
    type: [UploadedPartDto],
    description: '1..10000 parts with distinct part_number',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10000)
  @ArrayUnique((part: UploadedPartDto) => part.part_number, {
    message: 'parts must have distinct part_number values',
  })
  @ValidateNested({ each: true })
  @Type(() => UploadedPartDto)
  parts: UploadedPartDto[];
}
