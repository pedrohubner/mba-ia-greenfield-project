import {
  Body,
  Controller,
  Delete,
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
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { SignPartUrlsDto } from './dto/sign-part-urls.dto';
import {
  SignPartUrlsResponseDto,
  UploadedPartsResponseDto,
} from './dto/upload-parts-response.dto';
import {
  InitiateUploadResponseDto,
  VideoResponseDto,
} from './dto/video-response.dto';
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

  @Get(':publicId')
  @ApiOperation({
    summary: 'Get a video',
    description:
      'Returns the caller-owned video with its processing status, metadata and a presigned thumbnail URL once processed.',
  })
  @ApiResponse({ status: 200, description: 'Video', type: VideoResponseDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the caller (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getVideo(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.getOwnedVideo(user.sub, publicId);
  }

  @Post(':publicId/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Completes the multipart upload, validates the stored object, moves the video to `uploaded` and enqueues processing. Repeating it on an `uploaded` video only re-enqueues (deduplicated) and returns 200.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed; video is uploaded',
    type: VideoResponseDto,
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
    description: 'Video is processing, ready or failed (INVALID_UPLOAD_STATE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description:
      'Storage rejected the parts (INVALID_UPLOAD_PARTS) or the object exceeds 10 GiB (UPLOAD_SIZE_EXCEEDED)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<VideoResponseDto> {
    return this.videosService.completeUpload(user.sub, publicId, dto.parts);
  }

  @Delete(':publicId/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Abort a video upload',
    description:
      'Aborts the in-progress multipart upload and deletes the draft video.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted; draft deleted' })
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
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<void> {
    await this.videosService.abortUpload(user.sub, publicId);
  }
}
