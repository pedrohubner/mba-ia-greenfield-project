import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { SignPartUrlsDto } from './dto/sign-part-urls.dto';
import {
  SignPartUrlsResponseDto,
  UploadedPartsResponseDto,
} from './dto/upload-parts-response.dto';
import { InitiateUploadResponseDto } from './dto/video-response.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      "Creates the draft video in the caller's channel and opens a multipart upload in object storage. The client uploads the bytes directly to storage.",
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload opened',
    type: InitiateUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
  })
  @ApiResponse({
    status: 415,
    description: 'Unsupported video format (UNSUPPORTED_MEDIA_TYPE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<InitiateUploadResponseDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':publicId/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign upload part URLs',
    description:
      'Returns presigned UploadPart URLs (HTTP PUT) for a batch of part numbers of a pending upload owned by the caller.',
  })
  @ApiResponse({
    status: 200,
    description: 'Part URLs signed',
    type: SignPartUrlsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the caller (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload is not pending (INVALID_UPLOAD_STATE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'Part number above part_count (INVALID_UPLOAD_PARTS)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async signPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: SignPartUrlsDto,
  ): Promise<SignPartUrlsResponseDto> {
    return this.videosService.signPartUrls(
      user.sub,
      publicId,
      dto.part_numbers,
    );
  }

  @Get(':publicId/upload/parts')
  @ApiOperation({
    summary: 'List uploaded parts',
    description:
      'Returns the parts already stored for a pending upload, read from object storage, so an interrupted upload can resume.',
  })
  @ApiResponse({
    status: 200,
    description: 'Uploaded parts',
    type: UploadedPartsResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the caller (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload is not pending (INVALID_UPLOAD_STATE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listUploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<UploadedPartsResponseDto> {
    return this.videosService.listUploadedParts(user.sub, publicId);
  }
}
