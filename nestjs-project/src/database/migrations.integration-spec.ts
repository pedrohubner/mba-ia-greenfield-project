import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1791555983193 } from './migrations/1791555983193-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

const MANAGED_ENUM_TYPES = [
  'verification_tokens_type_enum',
  'video_processing_status',
  'video_publication_status',
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1791555983193,
        ],
      },
    );

    await dataSource.initialize();

    const tablesToDrop = [...MANAGED_TABLES, 'migrations']
      .map((table) => `"${table}"`)
      .join(', ');
    await dataSource.query(`DROP TABLE IF EXISTS ${tablesToDrop} CASCADE`);
    for (const enumType of MANAGED_ENUM_TYPES) {
      await dataSource.query(`DROP TYPE IF EXISTS "public"."${enumType}"`);
    }
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving token tables missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    try {
      await dataSource.runMigrations();
    } finally {
      await dataSource.destroy();
    }
  });

  it('should apply all migrations and create all managed tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should create the videos enum types and indexes', async () => {
    const types = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type
       WHERE typname = ANY($1::text[])
       ORDER BY typname`,
      [['video_processing_status', 'video_publication_status']],
    );
    expect(types.map((t) => t.typname)).toEqual([
      'video_processing_status',
      'video_publication_status',
    ]);

    const indexes = await dataSource.query<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'videos'`,
    );
    const definitions = indexes.map((i) => i.indexdef);
    expect(definitions).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/UNIQUE INDEX .* \(public_id\)/),
        expect.stringMatching(/INDEX .* \(channel_id\)/),
        expect.stringMatching(/INDEX .* \(processing_status, created_at\)/),
      ]),
    );
  });

  it('should revert CreateVideos and remove the videos table and enum types', async () => {
    await dataSource.undoLastMigration();

    const tables = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'videos'`,
    );
    expect(tables).toHaveLength(0);

    const types = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typname = ANY($1::text[])`,
      [['video_processing_status', 'video_publication_status']],
    );
    expect(types).toHaveLength(0);
  });

  it('should revert CreateAuthTokens and remove token tables', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['refresh_tokens', 'verification_tokens']],
    );
    expect(result).toHaveLength(0);
  });
});
