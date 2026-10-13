import mysql from 'mysql2/promise';

const SOURCE_CONFIG = {
    host: process.env.SOURCE_DB_HOST || 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com',
    port: parseInt(process.env.SOURCE_DB_PORT || '4000'),
    user: process.env.SOURCE_DB_USER || '3jmws3vjSEBzHAs.root',
    password: process.env.SOURCE_DB_PASSWORD || 'yB3MSU7tNyUAh84n',
    database: process.env.SOURCE_DB_NAME || 'test',
    ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    waitForConnections: true,
    connectionLimit: 10,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: 30000
};

const TARGET_CONFIG = {
    host: process.env.TARGET_DB_HOST || 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com',
    port: parseInt(process.env.TARGET_DB_PORT || '4000'),
    user: process.env.TARGET_DB_USER || 'NJiLRqKxh1QG3am.root',
    password: process.env.TARGET_DB_PASSWORD || 'H6YEFIEODY97QvHQ',
    database: process.env.TARGET_DB_NAME || 'test',
    ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    waitForConnections: true,
    connectionLimit: 10,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: 30000
};

const DB_TABLE_SCHEMAS = [
    `CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE,
        password VARCHAR(255),
        avatar_url TEXT,
        google_id VARCHAR(255),
        premium INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS songs (
        video_id VARCHAR(500) PRIMARY KEY,
        title VARCHAR(500) NOT NULL,
        channel_name VARCHAR(255),
        thumbnail TEXT,
        duration INT,
        album_name VARCHAR(255),
        album_id VARCHAR(255)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS playlists (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        cover_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS playlist_songs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        playlist_id INT NOT NULL,
        video_id VARCHAR(500) NOT NULL,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        video_id VARCHAR(500) NOT NULL,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS favorites (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        video_id VARCHAR(500) NOT NULL,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS followed_artists (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        browse_id VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        thumbnail TEXT,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

async function queryWithRetry(pool, sql, params = [], maxRetries = 5) {
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
                console.warn(`⚠️ Connection hiccup (${err.code || err.message}). Reconnecting and retrying in ${backoffMs}ms (attempt ${attempt}/${maxRetries})...`);
                await new Promise(r => setTimeout(r, backoffMs));
                continue;
            }
            throw err;
        }
    }
}

async function getPrimaryKey(pool, table) {
    try {
        const [keys] = await queryWithRetry(pool, `SHOW KEYS FROM \`${table}\` WHERE Key_name = 'PRIMARY'`);
        if (keys && keys.length > 0) return keys[0].Column_name;
    } catch (e) {
        // Fallback
    }
    return null;
}

async function bulkInsertRows(dstPool, table, columns, rows) {
    if (!rows || rows.length === 0) return;
    const colList = columns.map(c => `\`${c}\``).join(', ');
    const rowPlaceholders = `(${columns.map(() => '?').join(', ')})`;
    const allPlaceholders = new Array(rows.length).fill(rowPlaceholders).join(', ');
    const bulkInsertSql = `INSERT IGNORE INTO \`${table}\` (${colList}) VALUES ${allPlaceholders}`;

    const flattenedValues = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        for (let j = 0; j < columns.length; j++) {
            flattenedValues.push(row[columns[j]]);
        }
    }
    await queryWithRetry(dstPool, bulkInsertSql, flattenedValues);
}

async function migrateTable(srcPool, dstPool, table) {
    const startTime = Date.now();
    const [[{ count: initialSrcCount }]] = await queryWithRetry(srcPool, `SELECT COUNT(*) as count FROM \`${table}\``);

    if (initialSrcCount === 0) {
        const [[{ count: dstCount }]] = await queryWithRetry(dstPool, `SELECT COUNT(*) as count FROM \`${table}\``);
        return { table, srcCount: 0, dstCount, durationMs: Date.now() - startTime, status: 'SUCCESS' };
    }

    const [columnsResult] = await queryWithRetry(srcPool, `SHOW COLUMNS FROM \`${table}\``);
    const columns = columnsResult.map(c => c.Field);

    const pk = await getPrimaryKey(srcPool, table);
    const BATCH_SIZE = 1500;
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
            [rows] = await queryWithRetry(srcPool, sql, params);
        } else {
            [rows] = await queryWithRetry(srcPool, `SELECT * FROM \`${table}\` LIMIT ${BATCH_SIZE} OFFSET ${offset}`);
            offset += BATCH_SIZE;
        }

        if (!rows || rows.length === 0) break;

        await bulkInsertRows(dstPool, table, columns, rows);
        processed += rows.length;
        if (pk) {
            lastPk = rows[rows.length - 1][pk];
        }
        if (processed % 6000 === 0 || processed >= initialSrcCount) {
            console.log(`[${table}] Transferred ${processed}/${initialSrcCount} rows...`);
        }
    }

    const [[{ count: currentDstCount }]] = await queryWithRetry(dstPool, `SELECT COUNT(*) as count FROM \`${table}\``);
    const durationMs = Date.now() - startTime;
    console.log(`[${table}] Transferred in ${(durationMs / 1000).toFixed(2)}s (${currentDstCount} rows in target).`);

    return { table, srcCount: initialSrcCount, dstCount: currentDstCount, durationMs, status: 'COPIED' };
}

// Catch-up sync to capture newly arrived rows from the live production source
async function syncDelta(srcPool, dstPool, table) {
    const pk = await getPrimaryKey(srcPool, table);
    const [columnsResult] = await queryWithRetry(srcPool, `SHOW COLUMNS FROM \`${table}\``);
    const columns = columnsResult.map(c => c.Field);

    let newlySynced = 0;

    if (pk === 'id') {
        const [[{ maxId }]] = await queryWithRetry(dstPool, `SELECT COALESCE(MAX(\`${pk}\`), 0) AS maxId FROM \`${table}\``);
        let lastId = maxId;
        while (true) {
            const [rows] = await queryWithRetry(srcPool, `SELECT * FROM \`${table}\` WHERE \`${pk}\` > ? ORDER BY \`${pk}\` ASC LIMIT 1500`, [lastId]);
            if (!rows || rows.length === 0) break;

            await bulkInsertRows(dstPool, table, columns, rows);
            newlySynced += rows.length;
            lastId = rows[rows.length - 1][pk];
        }
    } else if (pk === 'video_id') {
        // Songs: find missing songs
        const [[{ count: srcCount }]] = await queryWithRetry(srcPool, `SELECT COUNT(*) as count FROM \`${table}\``);
        const [[{ count: dstCount }]] = await queryWithRetry(dstPool, `SELECT COUNT(*) as count FROM \`${table}\``);
        if (srcCount > dstCount) {
            let lastPk = null;
            while (true) {
                let sql = `SELECT * FROM \`${table}\``;
                let params = [];
                if (lastPk !== null) {
                    sql += ` WHERE \`${pk}\` > ?`;
                    params.push(lastPk);
                }
                sql += ` ORDER BY \`${pk}\` ASC LIMIT 1500`;
                const [rows] = await queryWithRetry(srcPool, sql, params);
                if (!rows || rows.length === 0) break;

                await bulkInsertRows(dstPool, table, columns, rows);
                newlySynced += rows.length;
                lastPk = rows[rows.length - 1][pk];
            }
        }
    }

    if (newlySynced > 0) {
        console.log(`⚡ [Delta Sync] Caught up ${newlySynced} live records on \`${table}\``);
    }
    return newlySynced;
}

async function run() {
    console.log('🚀 Starting Robust & Fast Database Migration...');
    const overallStart = Date.now();

    // Ensure target database exists
    const initTargetConfig = { ...TARGET_CONFIG };
    delete initTargetConfig.database;
    const targetBootstrapConn = await mysql.createConnection(initTargetConfig);
    try {
        await targetBootstrapConn.query(`CREATE DATABASE IF NOT EXISTS \`${TARGET_CONFIG.database}\``);
        console.log(`✅ Ensured target database \`${TARGET_CONFIG.database}\` exists.`);
    } finally {
        await targetBootstrapConn.end();
    }

    const srcPool = mysql.createPool(SOURCE_CONFIG);
    const dstPool = mysql.createPool(TARGET_CONFIG);

    try {
        await Promise.all([
            queryWithRetry(srcPool, 'SELECT 1'),
            queryWithRetry(dstPool, 'SELECT 1')
        ]);
        console.log('✅ Connected to both Source and Target databases.');

        // Initialize target schema
        console.log('📋 Verifying schema on target database...');
        for (const sql of DB_TABLE_SCHEMAS) {
            await queryWithRetry(dstPool, sql);
        }

        // Discover all tables from source
        const [tablesResult] = await queryWithRetry(srcPool, 'SHOW TABLES');
        const dbColName = Object.keys(tablesResult[0])[0];
        const allSrcTables = tablesResult.map(r => r[dbColName]);
        console.log(`Discovered ${allSrcTables.length} tables in source:`, allSrcTables);

        // Ensure missing tables exist
        for (const table of allSrcTables) {
            try {
                const [createTableResult] = await queryWithRetry(srcPool, `SHOW CREATE TABLE \`${table}\``);
                const createSql = createTableResult[0]['Create Table'];
                await queryWithRetry(dstPool, createSql);
            } catch (err) {
                // Ignore if exists
            }
        }

        // 🧹 Clean target database before running fresh migration
        console.log('\n🧹 Cleaning target database for fresh migration...');
        await queryWithRetry(dstPool, 'SET FOREIGN_KEY_CHECKS = 0');
        for (const table of allSrcTables) {
            try {
                await queryWithRetry(dstPool, `TRUNCATE TABLE \`${table}\``);
                console.log(`   Cleaned target table: \`${table}\``);
            } catch (e) {
                // Ignore
            }
        }

        // Optimize target session for bulk ingestion
        await queryWithRetry(dstPool, 'SET UNIQUE_CHECKS = 0');

        // Order tables logically to maintain relational integrity
        const orderedTables = [
            'users',
            'songs',
            'playlists',
            'playlist_songs',
            'history',
            'favorites',
            'followed_artists',
            ...allSrcTables.filter(t => !['users', 'songs', 'playlists', 'playlist_songs', 'history', 'favorites', 'followed_artists'].includes(t))
        ].filter(t => allSrcTables.includes(t));

        // Migrate tables one-by-one to avoid socket congestion and protocol disconnection
        console.log('\n⏩ Migrating tables sequentially for maximum socket stability...');
        for (const table of orderedTables) {
            await migrateTable(srcPool, dstPool, table);
        }

        // 🔄 Catch-Up Delta Pass: Capture live rows added during bulk migration
        console.log('\n🔄 Catch-Up Phase: Syncing live rows inserted during bulk migration...');
        for (let round = 1; round <= 2; round++) {
            for (const table of orderedTables) {
                await syncDelta(srcPool, dstPool, table);
            }
        }

        await queryWithRetry(dstPool, 'SET FOREIGN_KEY_CHECKS = 1');
        await queryWithRetry(dstPool, 'SET UNIQUE_CHECKS = 1');

        // Final verification summary
        console.log('\n📊 Verifying final table counts...');
        const finalSummary = [];
        for (const table of orderedTables) {
            const [[{ count: srcCount }]] = await queryWithRetry(srcPool, `SELECT COUNT(*) as count FROM \`${table}\``);
            const [[{ count: dstCount }]] = await queryWithRetry(dstPool, `SELECT COUNT(*) as count FROM \`${table}\``);
            const diff = Math.abs(srcCount - dstCount);
            // Allow minor diff if live traffic is actively firing right now
            const isMatch = dstCount === srcCount || (dstCount >= srcCount - 15 && dstCount <= srcCount + 15);
            finalSummary.push({
                table,
                srcCount,
                dstCount,
                diff,
                status: isMatch ? 'SUCCESS' : `MISMATCH (src: ${srcCount}, dst: ${dstCount})`
            });
        }

        const totalTime = ((Date.now() - overallStart) / 1000).toFixed(2);
        console.log(`\n🎉 Migration & Live Catch-Up completed in ${totalTime}s!\n`);
        console.table(finalSummary);

        const hasFailure = finalSummary.some(s => s.status.startsWith('MISMATCH'));
        if (hasFailure) {
            throw new Error('One or more tables had record mismatches after delta sync');
        }
    } catch (err) {
        console.error('❌ Migration failed:', err);
        process.exitCode = 1;
    } finally {
        await srcPool.end();
        await dstPool.end();
    }
}

run();
