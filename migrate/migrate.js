import mysql from 'mysql2/promise';
import pkg from 'pg';
import dotenv from 'dotenv';

dotenv.config();
const { Pool } = pkg;

const SOURCE_CONFIG = {
    host: process.env.SOURCE_DB_HOST || 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com',
    port: parseInt(process.env.SOURCE_DB_PORT || '4000'),
    user: process.env.SOURCE_DB_USER || 'NJiLRqKxh1QG3am.root',
    password: process.env.SOURCE_DB_PASSWORD || 'H6YEFIEODY97QvHQ',
    database: process.env.SOURCE_DB_NAME || 'test',
    ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    waitForConnections: true,
    connectionLimit: 10,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: 30000,
    dateStrings: true
};

const TARGET_PG_URL = process.env.TARGET_PG_URL || process.env.TARGET_DATABASE_URL || 'postgresql://muzo:muzo123@160.22.109.140:5432/muzo';

const PG_CONFIG = {
    connectionString: TARGET_PG_URL,
    connectionTimeoutMillis: 30000,
    max: 20
};

const PG_TABLE_SCHEMAS = [
    `CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE,
        password VARCHAR(255),
        avatar_url TEXT,
        google_id VARCHAR(255),
        premium INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        premium_until TIMESTAMP DEFAULT NULL,
        referred_by INT DEFAULT NULL,
        referral_code VARCHAR(32) UNIQUE
    )`,

    `CREATE TABLE IF NOT EXISTS songs (
        video_id VARCHAR(500) PRIMARY KEY,
        title VARCHAR(500) NOT NULL,
        channel_name VARCHAR(255),
        thumbnail TEXT,
        duration INT,
        album_name VARCHAR(255),
        album_id VARCHAR(255)
    )`,

    `CREATE TABLE IF NOT EXISTS playlists (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        cover_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS playlist_songs (
        id SERIAL PRIMARY KEY,
        playlist_id INT NOT NULL,
        video_id VARCHAR(500) NOT NULL,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS history (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL,
        video_id VARCHAR(500) NOT NULL,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS favorites (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL,
        video_id VARCHAR(500) NOT NULL,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS followed_artists (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL,
        browse_id VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        thumbnail TEXT,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS referrals (
        id SERIAL PRIMARY KEY,
        referrer_id INT NOT NULL,
        referred_id INT NOT NULL UNIQUE,
        referral_code VARCHAR(32) NOT NULL,
        status VARCHAR(32) DEFAULT 'pending',
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        verified_at TIMESTAMP DEFAULT NULL,
        verified_by VARCHAR(255) DEFAULT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS promo_codes (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        duration_type VARCHAR(20) DEFAULT 'months',
        duration_months INT DEFAULT 1,
        max_uses INT DEFAULT 1,
        times_used INT DEFAULT 0,
        expires_at TIMESTAMP DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_by VARCHAR(255) DEFAULT NULL,
        is_active SMALLINT DEFAULT 1
    )`,

    `CREATE TABLE IF NOT EXISTS promo_redemptions (
        id SERIAL PRIMARY KEY,
        promo_id INT NOT NULL,
        code VARCHAR(50) NOT NULL,
        user_id INT NOT NULL,
        duration_applied VARCHAR(50),
        redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uniq_user_promo UNIQUE (promo_id, user_id)
    )`
];

const PG_INDEXES = [
    `CREATE INDEX IF NOT EXISTS idx_history_user_id ON history (user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_history_video_id ON history (video_id)`,
    `CREATE INDEX IF NOT EXISTS idx_favorites_user_id ON favorites (user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_playlists_user_id ON playlists (user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_playlist_songs_playlist_id ON playlist_songs (playlist_id)`,
    `CREATE INDEX IF NOT EXISTS idx_followed_artists_user_id ON followed_artists (user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals (referred_id)`,
    `CREATE INDEX IF NOT EXISTS idx_promo_redemptions_user ON promo_redemptions (user_id)`
];

async function queryMysqlWithRetry(pool, sql, params = [], maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await pool.query(sql, params);
        } catch (err) {
            const isRetryable = [
                'PROTOCOL_CONNECTION_LOST',
                'ECONNRESET',
                'ETIMEDOUT',
                'EPIPE',
                'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR'
            ].includes(err.code) || err.fatal;

            if (isRetryable && attempt < maxRetries) {
                const backoffMs = attempt * 1500;
                console.warn(`⚠️ MySQL hiccup (${err.code || err.message}). Retrying in ${backoffMs}ms (${attempt}/${maxRetries})...`);
                await new Promise(r => setTimeout(r, backoffMs));
                continue;
            }
            throw err;
        }
    }
}

async function queryPgWithRetry(pool, sql, params = [], maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await pool.query(sql, params);
        } catch (err) {
            const isRetryable = [
                'ECONNRESET',
                'ETIMEDOUT',
                'EPIPE',
                '57P01', // admin_shutdown
                '08006', // connection_failure
                '08001'  // sqlclient_unable_to_establish_sqlconnection
            ].includes(err.code);

            if (isRetryable && attempt < maxRetries) {
                const backoffMs = attempt * 1500;
                console.warn(`⚠️ PostgreSQL hiccup (${err.code || err.message}). Retrying in ${backoffMs}ms (${attempt}/${maxRetries})...`);
                await new Promise(r => setTimeout(r, backoffMs));
                continue;
            }
            throw err;
        }
    }
}

function cleanValue(val) {
    if (val === undefined || val === null) return null;
    if (typeof val === 'string') {
        if (val === '0000-00-00 00:00:00' || val === '0000-00-00') return null;
    }
    return val;
}

async function bulkInsertPg(pgPool, table, columns, rows) {
    if (!rows || rows.length === 0) return 0;

    const colList = columns.map(c => `"${c}"`).join(', ');
    const numCols = columns.length;

    // Construct ($1, $2, ...), ($N+1, $N+2, ...)
    const rowPlaceholders = [];
    const values = [];

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const offset = i * numCols;
        const rowParamTokens = [];
        for (let j = 0; j < numCols; j++) {
            rowParamTokens.push(`$${offset + j + 1}`);
            values.push(cleanValue(row[columns[j]]));
        }
        rowPlaceholders.push(`(${rowParamTokens.join(', ')})`);
    }

    const sql = `INSERT INTO "${table}" (${colList}) VALUES ${rowPlaceholders.join(', ')} ON CONFLICT DO NOTHING`;
    const res = await queryPgWithRetry(pgPool, sql, values);
    return res.rowCount || 0;
}

async function getPrimaryKey(mysqlPool, table) {
    try {
        const [keys] = await queryMysqlWithRetry(mysqlPool, `SHOW KEYS FROM \`${table}\` WHERE Key_name = 'PRIMARY'`);
        if (keys && keys.length > 0) return keys[0].Column_name;
    } catch (e) {
        // Fallback
    }
    return null;
}

async function migrateTable(mysqlPool, pgPool, table) {
    const startTime = Date.now();
    const [[{ count: initialSrcCount }]] = await queryMysqlWithRetry(mysqlPool, `SELECT COUNT(*) as count FROM \`${table}\``);

    if (initialSrcCount === 0) {
        const pgCountRes = await queryPgWithRetry(pgPool, `SELECT COUNT(*) as count FROM "${table}"`);
        return { table, srcCount: 0, dstCount: parseInt(pgCountRes.rows[0].count), durationMs: Date.now() - startTime, status: 'SUCCESS' };
    }

    const [columnsResult] = await queryMysqlWithRetry(mysqlPool, `SHOW COLUMNS FROM \`${table}\``);
    const columns = columnsResult.map(c => c.Field);

    const pk = await getPrimaryKey(mysqlPool, table);
    const BATCH_SIZE = 1000;
    let processed = 0;
    let lastPk = null;
    let offset = 0;

    while (true) {
        let rows;
        if (pk) {
            let sql = `SELECT * FROM \`${table}\``;
            let params = [];
            if (lastPk !== null) {
                sql += ` WHERE \`${pk}\` > ?`;
                params.push(lastPk);
            }
            sql += ` ORDER BY \`${pk}\` ASC LIMIT ${BATCH_SIZE}`;
            [rows] = await queryMysqlWithRetry(mysqlPool, sql, params);
        } else {
            [rows] = await queryMysqlWithRetry(mysqlPool, `SELECT * FROM \`${table}\` LIMIT ${BATCH_SIZE} OFFSET ${offset}`);
            offset += BATCH_SIZE;
        }

        if (!rows || rows.length === 0) break;

        await bulkInsertPg(pgPool, table, columns, rows);
        processed += rows.length;

        if (pk) {
            lastPk = rows[rows.length - 1][pk];
        }

        if (processed % 10000 === 0 || processed >= initialSrcCount) {
            const pct = ((processed / initialSrcCount) * 100).toFixed(1);
            console.log(`  [${table}] Transferred ${processed}/${initialSrcCount} rows (${pct}%)...`);
        }
    }

    // Sync sequence if table has serial 'id'
    if (columns.includes('id')) {
        await queryPgWithRetry(pgPool, `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE(MAX(id), 1)) FROM "${table}"`);
    }

    const pgFinalCountRes = await queryPgWithRetry(pgPool, `SELECT COUNT(*) as count FROM "${table}"`);
    const currentDstCount = parseInt(pgFinalCountRes.rows[0].count);
    const durationMs = Date.now() - startTime;
    console.log(`✅ [${table}] Done in ${(durationMs / 1000).toFixed(2)}s (${currentDstCount} rows in Postgres).`);

    return { table, srcCount: initialSrcCount, dstCount: currentDstCount, durationMs, status: 'COPIED' };
}

async function syncDelta(mysqlPool, pgPool, table) {
    const pk = await getPrimaryKey(mysqlPool, table);
    const [columnsResult] = await queryMysqlWithRetry(mysqlPool, `SHOW COLUMNS FROM \`${table}\``);
    const columns = columnsResult.map(c => c.Field);

    let newlySynced = 0;

    if (pk === 'id') {
        const pgMaxRes = await queryPgWithRetry(pgPool, `SELECT COALESCE(MAX(id), 0) AS "maxId" FROM "${table}"`);
        let lastId = parseInt(pgMaxRes.rows[0].maxId);

        while (true) {
            const [rows] = await queryMysqlWithRetry(mysqlPool, `SELECT * FROM \`${table}\` WHERE id > ? ORDER BY id ASC LIMIT 1000`, [lastId]);
            if (!rows || rows.length === 0) break;

            const inserted = await bulkInsertPg(pgPool, table, columns, rows);
            newlySynced += inserted;
            lastId = rows[rows.length - 1].id;
        }

        if (newlySynced > 0) {
            await queryPgWithRetry(pgPool, `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE(MAX(id), 1)) FROM "${table}"`);
        }
    } else if (pk === 'video_id') {
        const [[{ count: srcCount }]] = await queryMysqlWithRetry(mysqlPool, `SELECT COUNT(*) as count FROM \`${table}\``);
        const pgCountRes = await queryPgWithRetry(pgPool, `SELECT COUNT(*) as count FROM "${table}"`);
        const dstCount = parseInt(pgCountRes.rows[0].count);

        if (srcCount > dstCount) {
            let lastPk = null;
            while (true) {
                let sql = `SELECT * FROM \`${table}\``;
                let params = [];
                if (lastPk !== null) {
                    sql += ` WHERE video_id > ?`;
                    params.push(lastPk);
                }
                sql += ` ORDER BY video_id ASC LIMIT 1000`;
                const [rows] = await queryMysqlWithRetry(mysqlPool, sql, params);
                if (!rows || rows.length === 0) break;

                const inserted = await bulkInsertPg(pgPool, table, columns, rows);
                newlySynced += inserted;
                lastPk = rows[rows.length - 1].video_id;
            }
        }
    }

    if (newlySynced > 0) {
        console.log(`⚡ [Delta Sync] Caught up ${newlySynced} live records on \`${table}\``);
    }
    return newlySynced;
}

export async function runMigration() {
    console.log('🚀 Starting High-Speed MySQL to PostgreSQL Migration...');
    console.log(`Source MySQL: ${SOURCE_CONFIG.user}@${SOURCE_CONFIG.host}:${SOURCE_CONFIG.port}/${SOURCE_CONFIG.database}`);
    const maskedTargetUrl = TARGET_PG_URL.replace(/:([^:@]+)@/, ':****@');
    console.log(`Target PostgreSQL: ${maskedTargetUrl}`);

    const overallStart = Date.now();
    const mysqlPool = mysql.createPool(SOURCE_CONFIG);
    const pgPool = new Pool(PG_CONFIG);

    try {
        await Promise.all([
            queryMysqlWithRetry(mysqlPool, 'SELECT 1'),
            queryPgWithRetry(pgPool, 'SELECT 1')
        ]);
        console.log('✅ Connected to both MySQL source and PostgreSQL target.');

        // Initialize target schema
        console.log('📋 Creating PostgreSQL tables...');
        for (const sql of PG_TABLE_SCHEMAS) {
            await queryPgWithRetry(pgPool, sql);
        }

        // Ordered table list to preserve logical relations
        const orderedTables = [
            'users',
            'songs',
            'playlists',
            'playlist_songs',
            'history',
            'favorites',
            'followed_artists',
            'referrals',
            'promo_codes',
            'promo_redemptions'
        ];

        // Discover tables present in source
        const [tablesResult] = await queryMysqlWithRetry(mysqlPool, 'SHOW TABLES');
        const dbColName = Object.keys(tablesResult[0])[0];
        const allSrcTables = tablesResult.map(r => r[dbColName]);
        const tablesToMigrate = orderedTables.filter(t => allSrcTables.includes(t));

        console.log(`Discovered ${tablesToMigrate.length} tables to migrate:`, tablesToMigrate);

        // Migrate tables
        console.log('\n⏩ Migrating tables...');
        for (const table of tablesToMigrate) {
            await migrateTable(mysqlPool, pgPool, table);
        }

        // Catch-up delta pass
        console.log('\n🔄 Catch-Up Phase: Syncing live rows inserted during bulk transfer...');
        for (let round = 1; round <= 2; round++) {
            for (const table of tablesToMigrate) {
                await syncDelta(mysqlPool, pgPool, table);
            }
        }

        // Create indexes
        console.log('\n⚡ Creating PostgreSQL indexes...');
        for (const idxSql of PG_INDEXES) {
            await queryPgWithRetry(pgPool, idxSql);
        }

        // Final verification summary
        console.log('\n📊 Verifying final table counts...');
        const finalSummary = [];
        for (const table of tablesToMigrate) {
            const [[{ count: srcCount }]] = await queryMysqlWithRetry(mysqlPool, `SELECT COUNT(*) as count FROM \`${table}\``);
            const pgCountRes = await queryPgWithRetry(pgPool, `SELECT COUNT(*) as count FROM "${table}"`);
            const dstCount = parseInt(pgCountRes.rows[0].count);
            const diff = Math.abs(srcCount - dstCount);
            const isMatch = dstCount === srcCount || (dstCount >= srcCount - 20 && dstCount <= srcCount + 20);
            finalSummary.push({
                table,
                srcCount,
                dstCount,
                diff,
                status: isMatch ? 'SUCCESS' : `MISMATCH (src: ${srcCount}, dst: ${dstCount})`
            });
        }

        const totalTime = ((Date.now() - overallStart) / 1000).toFixed(2);
        console.log(`\n🎉 MySQL to PostgreSQL Migration finished in ${totalTime}s!\n`);
        console.table(finalSummary);

        const hasFailure = finalSummary.some(s => s.status.startsWith('MISMATCH'));
        if (hasFailure) {
            throw new Error('One or more tables had record mismatches after delta sync');
        }
    } catch (err) {
        console.error('❌ Migration failed:', err);
        process.exitCode = 1;
        throw err;
    } finally {
        await mysqlPool.end();
        await pgPool.end();
    }
}

// Auto-run if executed directly
if (process.argv[1] && process.argv[1].endsWith('migrate.js')) {
    runMigration().catch(() => process.exit(1));
}
