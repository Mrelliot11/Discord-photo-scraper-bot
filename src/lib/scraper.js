'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { isAllowedAttachmentUrl } = require('./security');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.svg']);

class BackupLimitExceededError extends Error {}

function isImageAttachment(attachment) {
  if (attachment.contentType && attachment.contentType.startsWith('image/')) return true;
  const ext = path.extname(attachment.name || '').toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Walks a text channel's full history (newest -> oldest) and yields each
 * fetched batch so callers can process messages incrementally.
 */
async function* iterateChannelMessages(channel, { maxMessages }) {
  let before;
  let scanned = 0;

  while (scanned < maxMessages) {
    const batchSize = Math.min(100, maxMessages - scanned);
    const batch = await channel.messages.fetch({ limit: batchSize, before });
    if (batch.size === 0) break;

    yield batch;

    scanned += batch.size;
    before = batch.last().id;

    if (batch.size < batchSize) break;
  }
}

/**
 * Scans a channel and groups image attachments by author.
 * Returns a Map<authorId, { user, displayName, avatarURL, count }>.
 */
async function scanChannelForImageAuthors(channel, { maxMessages, onProgress } = {}) {
  const authors = new Map();
  let scanned = 0;
  let imagesFound = 0;

  for await (const batch of iterateChannelMessages(channel, { maxMessages })) {
    for (const message of batch.values()) {
      scanned += 1;
      const imageAttachments = [...message.attachments.values()].filter(isImageAttachment);
      if (imageAttachments.length === 0) continue;

      imagesFound += imageAttachments.length;
      const author = message.author;
      const existing = authors.get(author.id);
      if (existing) {
        existing.count += imageAttachments.length;
      } else {
        authors.set(author.id, {
          id: author.id,
          user: author,
          displayName: author.globalName || author.username,
          avatarURL: author.displayAvatarURL({ size: 64 }),
          count: imageAttachments.length,
        });
      }
    }

    if (onProgress) onProgress({ scanned, imagesFound });
  }

  return authors;
}

const DEFAULT_MAX_ATTACHMENT_BYTES = Number(process.env.MAX_ATTACHMENT_BYTES) || 25 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BACKUP_BYTES = Number(process.env.MAX_TOTAL_BACKUP_BYTES) || 500 * 1024 * 1024;

/** Ensures a zip entry name can never escape the archive root (defense in depth on top of path.basename below). */
function assertSafeEntryName(entryName) {
  const normalized = entryName.replace(/\\/g, '/');
  if (normalized.includes('/') || normalized.includes('..')) {
    throw new Error(`Refusing unsafe zip entry name: ${entryName}`);
  }
}

/**
 * Downloads every image attachment in a channel authored by `authorId`
 * (or every author if `authorId` is null) and zips them into `outputPath`.
 * Enforces a per-file size cap, a total-backup size cap, and only ever
 * fetches from Discord's own CDN hosts, so a malicious or huge disguised
 * "image" can't exhaust the host's disk or be used to pull data from an
 * arbitrary URL. Returns { fileCount, zipPath, zipSizeBytes, skipped }.
 */
async function backupChannelImages(
  channel,
  authorId,
  outputPath,
  {
    maxMessages,
    onProgress,
    maxAttachmentBytes = DEFAULT_MAX_ATTACHMENT_BYTES,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BACKUP_BYTES,
  } = {}
) {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

  const output = fs.createWriteStream(outputPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  const closed = new Promise((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
    output.on('error', reject);
  });
  archive.pipe(output);

  let fileCount = 0;
  let scanned = 0;
  let totalBytes = 0;
  let skipped = 0;
  const usedNames = new Set();

  try {
    for await (const batch of iterateChannelMessages(channel, { maxMessages })) {
      for (const message of batch.values()) {
        scanned += 1;
        if (authorId && message.author.id !== authorId) continue;

        const imageAttachments = [...message.attachments.values()].filter(isImageAttachment);
        for (const attachment of imageAttachments) {
          if (!isAllowedAttachmentUrl(attachment.url)) {
            skipped += 1;
            continue;
          }
          if (attachment.size && attachment.size > maxAttachmentBytes) {
            skipped += 1;
            continue;
          }

          const response = await fetch(attachment.url);
          if (!response.ok) {
            skipped += 1;
            continue;
          }
          const buffer = Buffer.from(await response.arrayBuffer());
          if (buffer.length > maxAttachmentBytes) {
            skipped += 1;
            continue;
          }

          if (totalBytes + buffer.length > maxTotalBytes) {
            throw new BackupLimitExceededError(
              `Total backup size exceeded the ${maxTotalBytes}-byte limit; stopped after ${fileCount} image(s).`
            );
          }
          totalBytes += buffer.length;

          const ext = path.extname(attachment.name || '') || '.png';
          const base = path.basename(attachment.name || attachment.id, ext);
          let entryName = `${message.createdTimestamp}_${base}${ext}`;
          let dedupeSuffix = 1;
          while (usedNames.has(entryName)) {
            entryName = `${message.createdTimestamp}_${base}_${dedupeSuffix}${ext}`;
            dedupeSuffix += 1;
          }
          assertSafeEntryName(entryName);
          usedNames.add(entryName);

          archive.append(buffer, { name: entryName });
          fileCount += 1;
        }
      }

      if (onProgress) onProgress({ scanned, fileCount, totalBytes, skipped });
    }
  } catch (err) {
    archive.abort();
    output.destroy();
    await fs.promises.rm(outputPath, { force: true });
    throw err;
  }

  await archive.finalize();
  await closed;

  const stats = await fs.promises.stat(outputPath);
  return { fileCount, zipPath: outputPath, zipSizeBytes: stats.size, skipped };
}

module.exports = {
  isImageAttachment,
  scanChannelForImageAuthors,
  backupChannelImages,
  BackupLimitExceededError,
};
