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
const DOWNLOAD_TIMEOUT_MS = 30 * 1000;

/**
 * Makes an attachment's file name safe to use as a zip entry: strips path
 * separators (both kinds, since path.basename only understands the host
 * OS's), control characters, and leading dots. Never throws — a weird
 * filename must not abort a whole backup.
 */
function safeEntryBaseName(name, fallback) {
  const cleaned = String(name || '')
    .replace(/[\\/\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || fallback;
}

class AttachmentTooLargeError extends Error {}

/**
 * Downloads a URL into a Buffer, giving up as soon as the body exceeds
 * `maxBytes` (rather than buffering the whole thing first) or the request
 * exceeds DOWNLOAD_TIMEOUT_MS.
 */
async function downloadCapped(url, maxBytes) {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new AttachmentTooLargeError();
  }

  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.length;
    if (received > maxBytes) {
      await response.body.cancel().catch(() => {});
      throw new AttachmentTooLargeError();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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
    isAllowedUrl = isAllowedAttachmentUrl,
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
          if (!isAllowedUrl(attachment.url)) {
            skipped += 1;
            continue;
          }
          if (attachment.size && attachment.size > maxAttachmentBytes) {
            skipped += 1;
            continue;
          }

          let buffer;
          try {
            buffer = await downloadCapped(attachment.url, maxAttachmentBytes);
          } catch (err) {
            // Oversized, timed out, or a bad HTTP status: skip this one file
            // and keep going rather than failing the whole backup.
            if (!(err instanceof AttachmentTooLargeError)) {
              console.warn(`Skipping attachment ${attachment.id}: ${err.message}`);
            }
            skipped += 1;
            continue;
          }

          if (totalBytes + buffer.length > maxTotalBytes) {
            throw new BackupLimitExceededError(
              `Total backup size exceeded the ${maxTotalBytes}-byte limit; stopped after ${fileCount} image(s).`
            );
          }
          totalBytes += buffer.length;

          const safeName = safeEntryBaseName(attachment.name, attachment.id);
          const ext = path.extname(safeName) || '.png';
          const base = path.basename(safeName, ext) || attachment.id;
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

      if (onProgress) onProgress({ scanned, fileCount, totalBytes, skipped });
    }
  } catch (err) {
    // Tear down cleanly: stop the archive feeding the file, swallow the
    // stream errors that teardown itself produces (otherwise `closed`
    // rejects with nobody awaiting it and the process dies with an
    // unhandled rejection), wait for the file handle to close, then
    // remove the partial zip.
    closed.catch(() => {});
    archive.unpipe(output);
    archive.abort();
    await new Promise((resolve) => {
      if (output.closed || output.destroyed) return resolve();
      output.once('close', resolve);
      output.destroy();
    });
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
