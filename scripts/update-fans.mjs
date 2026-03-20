import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_UID = '3690985523514020';
const DEFAULT_PAGE_SIZE = 30;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const uid = String(process.env.BILIBILI_UID ?? DEFAULT_UID).trim();
const pageSize = Number.parseInt(process.env.BILIBILI_PAGE_SIZE ?? `${DEFAULT_PAGE_SIZE}`, 10) || DEFAULT_PAGE_SIZE;
const textOutputPath = path.resolve(repoRoot, process.env.FANS_TEXT_OUTPUT ?? 'fans.txt');
const jsonOutputPath = path.resolve(repoRoot, process.env.FANS_JSON_OUTPUT ?? 'fans.json');

async function fetchJson(url) {
    const response = await fetch(url, {
        headers: {
            'user-agent': 'KansatsuOfficial.github.io fan list updater'
        }
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Request failed (${response.status}) for ${url}: ${body.slice(0, 200)}`);
    }

    const payload = await response.json();
    if (payload?.code !== 0) {
        throw new Error(`API returned code ${payload?.code} for ${url}: ${payload?.message ?? payload?.msg ?? 'Unknown error'}`);
    }

    return payload.data;
}

async function readFileIfExists(filePath) {
    try {
        return await fs.readFile(filePath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

function sanitizeName(name) {
    return String(name ?? '')
        .replace(/\r?\n|\r/g, ' ')
        .trim();
}

function compareFans(a, b) {
    if (b.isCaptain !== a.isCaptain) return Number(b.isCaptain) - Number(a.isCaptain);
    if (b.level !== a.level) return b.level - a.level;
    return String(a.uid).localeCompare(String(b.uid), 'en');
}

function quoteCsvField(value) {
    const text = String(value ?? '');
    if (!/[",\n]/.test(text)) return text;
    return `"${text.replace(/"/g, '""')}"`;
}

function parseCsvLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        const next = line[index + 1];

        if (char === '"') {
            if (inQuotes && next === '"') {
                current += '"';
                index += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (char === ',' && !inQuotes) {
            fields.push(current);
            current = '';
            continue;
        }

        current += char;
    }

    fields.push(current);
    return fields;
}

function normalizeStoredFan(item) {
    return {
        uid: String(item?.uid ?? '').trim(),
        name: sanitizeName(item?.name),
        level: Number.parseInt(item?.level ?? 0, 10) || 0,
        isCaptain: item?.isCaptain === true || (Number.parseInt(item?.isCaptain ?? 0, 10) || 0) > 0,
        guardLevel: Number.parseInt(item?.guardLevel ?? item?.isCaptain ?? 0, 10) || 0
    };
}

function parseLegacyFansText(text) {
    const fans = [];

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const fields = parseCsvLine(line);
        if (fields.length < 3) continue;

        fans.push(
            normalizeStoredFan({
                uid: fields[0],
                name: fields[1],
                level: fields[2],
                isCaptain: fields[3] ?? 0
            })
        );
    }

    return fans;
}

function upsertFan(map, fan) {
    if (!fan.uid || !fan.name) return;

    const key = String(fan.uid);
    const existing = map.get(key);

    if (!existing) {
        map.set(key, {
            uid: key,
            name: fan.name,
            level: fan.level,
            isCaptain: fan.isCaptain,
            guardLevel: fan.guardLevel
        });
        return;
    }

    existing.name = fan.name || existing.name;
    existing.level = Math.max(existing.level, fan.level);
    existing.isCaptain = existing.isCaptain || fan.isCaptain;
    existing.guardLevel = Math.max(existing.guardLevel, fan.guardLevel);
}

function normalizeFanMember(item) {
    return {
        uid: String(item?.uid ?? '').trim(),
        name: sanitizeName(item?.name),
        level: Number.parseInt(item?.level ?? item?.uinfo_medal?.level ?? 0, 10) || 0,
        isCaptain: (Number.parseInt(item?.guard_level ?? item?.uinfo_medal?.guard_level ?? 0, 10) || 0) > 0,
        guardLevel: Number.parseInt(item?.guard_level ?? item?.uinfo_medal?.guard_level ?? 0, 10) || 0
    };
}

function normalizeGuardMember(item) {
    return {
        uid: String(item?.uinfo?.uid ?? item?.uid ?? '').trim(),
        name: sanitizeName(item?.uinfo?.base?.name ?? item?.name),
        level: Number.parseInt(item?.uinfo?.medal?.level ?? item?.level ?? 0, 10) || 0,
        isCaptain: (Number.parseInt(item?.uinfo?.guard?.level ?? item?.uinfo?.medal?.guard_level ?? 0, 10) || 0) > 0,
        guardLevel: Number.parseInt(item?.uinfo?.guard?.level ?? item?.uinfo?.medal?.guard_level ?? 0, 10) || 0
    };
}

async function getRoomId(anchorUid) {
    const data = await fetchJson(`https://api.live.bilibili.com/live_user/v1/Master/info?uid=${anchorUid}`);
    const roomId = data?.room_id;

    if (!roomId) {
        throw new Error(`Unable to resolve room_id for uid ${anchorUid}`);
    }

    return roomId;
}

async function fetchAllFanMembers(anchorUid) {
    const members = [];

    for (let page = 1; ; page += 1) {
        const data = await fetchJson(
            `https://api.live.bilibili.com/xlive/general-interface/v1/rank/getFansMembersRank?ruid=${anchorUid}&page_size=${pageSize}&page=${page}`
        );
        const items = Array.isArray(data?.item) ? data.item : [];

        members.push(...items);

        const total = Number.parseInt(data?.num ?? 0, 10) || members.length;
        if (!items.length || members.length >= total) {
            break;
        }
    }

    return members;
}

async function fetchAllGuards(anchorUid, roomId) {
    const guards = [];
    const seen = new Set();

    for (let page = 1; ; page += 1) {
        const data = await fetchJson(
            `https://api.live.bilibili.com/xlive/app-room/v2/guardTab/topListNew?ruid=${anchorUid}&roomid=${roomId}&page=${page}&page_size=${pageSize}`
        );

        const batch = [];
        if (page === 1 && Array.isArray(data?.top3)) {
            batch.push(...data.top3);
        }
        if (Array.isArray(data?.list)) {
            batch.push(...data.list);
        }

        for (const item of batch) {
            const member = normalizeGuardMember(item);
            if (!member.uid || seen.has(member.uid)) continue;
            seen.add(member.uid);
            guards.push(member);
        }

        const total = Number.parseInt(data?.info?.num ?? 0, 10) || guards.length;
        if (!batch.length || guards.length >= total) {
            break;
        }
    }

    return guards;
}

async function loadExistingFans() {
    const mergedFans = new Map();
    const sources = [];

    const existingJson = await readFileIfExists(jsonOutputPath);
    if (existingJson) {
        const payload = JSON.parse(existingJson);
        const fans = Array.isArray(payload) ? payload : payload?.fans;
        if (Array.isArray(fans)) {
            for (const item of fans) {
                upsertFan(mergedFans, normalizeStoredFan(item));
            }
            sources.push(path.relative(repoRoot, jsonOutputPath));
        }
    }

    const existingText = await readFileIfExists(textOutputPath);
    if (existingText) {
        for (const item of parseLegacyFansText(existingText)) {
            upsertFan(mergedFans, item);
        }
        sources.push(path.relative(repoRoot, textOutputPath));
    }

    return {
        fans: Array.from(mergedFans.values()).sort(compareFans),
        sources
    };
}

async function main() {
    if (!uid) {
        throw new Error('BILIBILI_UID is required.');
    }

    const existingData = await loadExistingFans();
    const roomId = await getRoomId(uid);
    const fanMembers = await fetchAllFanMembers(uid);
    const guardMembers = await fetchAllGuards(uid, roomId);

    const mergedFans = new Map();

    for (const item of existingData.fans) {
        upsertFan(mergedFans, item);
    }

    for (const item of fanMembers) {
        upsertFan(mergedFans, normalizeFanMember(item));
    }

    for (const item of guardMembers) {
        upsertFan(mergedFans, item);
    }

    const fans = Array.from(mergedFans.values()).sort(compareFans);

    const textOutput = fans
        .map((fan) => [fan.uid, fan.name, fan.level, fan.isCaptain ? 1 : 0].map(quoteCsvField).join(','))
        .join('\n')
        .concat('\n');

    const jsonOutput = {
        uid,
        roomId,
        generatedAt: new Date().toISOString(),
        fans
    };

    await fs.writeFile(textOutputPath, textOutput, 'utf8');
    await fs.writeFile(jsonOutputPath, `${JSON.stringify(jsonOutput, null, 2)}\n`, 'utf8');

    console.log(`Updated ${fans.length} fan records for uid ${uid} (room ${roomId}).`);
    console.log(
        existingData.sources.length
            ? `Merged existing records from ${existingData.sources.join(', ')}.`
            : 'No existing local fan files found; created a fresh list.'
    );
    console.log(`Fan members: ${fanMembers.length}, guards: ${guardMembers.length}.`);
    console.log(`Wrote ${path.relative(repoRoot, textOutputPath)} and ${path.relative(repoRoot, jsonOutputPath)}.`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
