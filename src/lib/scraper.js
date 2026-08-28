'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.svg']);

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

/**
 * Downloads every image attachment in a channel authored by `authorId`
 * (or every author if `authorId` is null) and zips them into `outputPath`.
 * Returns { fileCount, zipPath, zipSizeBytes }.
 */
async function backupChannelImages(channel, authorId, outputPath, { maxMessages, onProgress } = {}) {
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
  const usedNames = new Set();

  for await (const batch of iterateChannelMessages(channel, { maxMessages })) {
    for (const message of batch.values()) {
      scanned += 1;
      if (authorId && message.author.id !== authorId) continue;

      const imageAttachments = [...message.attachments.values()].filter(isImageAttachment);
      for (const attachment of imageAttachments) {
        const response = await fetch(attachment.url);
        if (!response.ok) continue;
        const buffer = Buffer.from(await response.arrayBuffer());

        const ext = path.extname(attachment.name || '') || '.png';
        const base = path.basename(attachment.name || attachment.id, ext);
        let entryName = `${message.createdTimestamp}_${base}${ext}`;
        let dedupeSuffix = 1;
        while (usedNames.has(entryName)) {
          entryName = `${message.createdTimestamp}_${base}_${dedupeSuffix}${ext}`;
          dedupeSuffix += 1;
        }
        usedNames.add(entryName);

        archive.append(buffer, { name: entryName });
        fileCount += 1;
      }
    }

    if (onProgress) onProgress({ scanned, fileCount });
  }

  await archive.finalize();
  await closed;

  const stats = await fs.promises.stat(outputPath);
  return { fileCount, zipPath: outputPath, zipSizeBytes: stats.size };
}

module.exports = {
  isImageAttachment,
  scanChannelForImageAuthors,
  backupChannelImages,
};
