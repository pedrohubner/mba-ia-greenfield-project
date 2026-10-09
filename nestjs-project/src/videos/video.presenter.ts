import type { VideoResponseDto } from './dto/video-response.dto';
import type { Video } from './entities/video.entity';

export function toVideoResponse(
  video: Video,
  thumbnailUrl: string | null,
): VideoResponseDto {
  return {
    public_id: video.public_id,
    title: video.title,
    original_filename: video.original_filename,
    content_type: video.content_type,
    size_bytes: video.size_bytes,
    processing_status: video.processing_status,
    publication_status: video.publication_status,
    processing_error: video.processing_error,
    duration_seconds: video.duration_seconds,
    width: video.width,
    height: video.height,
    video_codec: video.video_codec,
    audio_codec: video.audio_codec,
    container_format: video.container_format,
    bitrate: video.bitrate,
    thumbnail_url: thumbnailUrl,
    created_at: video.created_at.toISOString(),
    updated_at: video.updated_at.toISOString(),
  };
}
