'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Collection } = require('discord.js');
const {
  scanChannelForImageAuthors,
  backupChannelImages,
  BackupLimitExceededError,
  isImageAttachment,
} = require('../src/lib/scraper');

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108020000009077', 'hex');

function makeMessage({ id, authorId, ts, attachments = [] }) {
  const collection = new Collection();
  for (const att of attachments) {
    collection.set(att.id ?? att.name, { contentType: 'image/png', size: 32, ...att, id: att.id ?? att.name });
  }
  return {
    id,
    createdTimestamp: ts,
    author: { id: authorId, username: `user_${authorId}`, globalName: null, displayAvatarURL: () => 'x' },
    attachments: collection,
  };
}

/** Mimics Discord's newest-first, `before`-cursor paginated history. */
function fakeChannel(messagesOldestFirst) {
  const newestFirst = [...messagesOldestFirst].reverse();
  const channel = {
    fetchCalls: 0,
    messages: {
      fetch: async ({ limit, before }) => {
        channel.fetchCalls += 1;
        const start = before ? newestFirst.findIndex((m) => m.id === before) + 1 : 0;
        const col = new Collection();
        for (const m of newestFirst.slice(start, start + limit)) col.set(m.id, m);
        return col;
      },
    },
  };
  return channel;
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url.includes('big')) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': '2000' });
      res.end(Buffer.alloc(2000));
    } else if (req.url.includes('nolength')) {
      // Chunked (no Content-Length) so the streaming cap has to catch it.
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.write(Buffer.alloc(1500));
      res.end(Buffer.alloc(1500));
    } else if (req.url.includes('missing')) {
      res.writeHead(404);
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG_BYTES);
    }
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

const allowAll = () => true;

test('isImageAttachment uses content type, then extension', () => {
  assert.equal(isImageAttachment({ contentType: 'image/webp', name: 'x' }), true);
  assert.equal(isImageAttachment({ contentType: null, name: 'photo.JPG' }), true);
  assert.equal(isImageAttachment({ contentType: 'video/mp4', name: 'clip.mp4' }), false);
});

test('scan groups images by author across multiple fetch pages', async () => {
  const messages = [];
  for (let i = 1; i <= 250; i++) {
    messages.push(
      makeMessage({ id: `m${i}`, authorId: `a${i % 3}`, ts: i, attachments: i % 10 === 0 ? [{ name: `p${i}.png`, url: 'u' }] : [] })
    );
  }
  const channel = fakeChannel(messages);
  const authors = await scanChannelForImageAuthors(channel, { maxMessages: 1000 });

  assert.equal(channel.fetchCalls, 3);
  const total = [...authors.values()].reduce((s, a) => s + a.count, 0);
  assert.equal(total, 25);
});

test('scan respects maxMessages', async () => {
  const messages = Array.from({ length: 300 }, (_, i) => makeMessage({ id: `m${i}`, authorId: 'a', ts: i }));
  const channel = fakeChannel(messages);
  await scanChannelForImageAuthors(channel, { maxMessages: 150 });
  assert.equal(channel.fetchCalls, 2);
});

test('backup zips one author, skips oversized/failed/disallowed files, never aborts on odd names', async () => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-test-'));
  try {
    const channel = fakeChannel([
      makeMessage({ id: 'm1', authorId: 'a1', ts: 1, attachments: [{ name: 'good.png', url: `${base}/good.png` }] }),
      makeMessage({ id: 'm2', authorId: 'a1', ts: 2, attachments: [{ name: 'big.png', url: `${base}/big.png`, size: 2000 }] }),
      makeMessage({ id: 'm3', authorId: 'a1', ts: 3, attachments: [{ name: 'nolength.png', url: `${base}/nolength.png`, size: 0 }] }),
      makeMessage({ id: 'm4', authorId: 'a1', ts: 4, attachments: [{ name: 'missing.png', url: `${base}/missing.png` }] }),
      makeMessage({ id: 'm5', authorId: 'a1', ts: 5, attachments: [{ name: 'evil.png', url: 'https://evil.example/x.png' }] }),
      // Names that used to abort the whole run:
      makeMessage({ id: 'm6', authorId: 'a1', ts: 6, attachments: [{ name: 'photo..png', url: `${base}/ok1.png` }] }),
      makeMessage({ id: 'm7', authorId: 'a1', ts: 7, attachments: [{ name: '..\\..\\etc\\passwd.png', url: `${base}/ok2.png` }] }),
      makeMessage({ id: 'm8', authorId: 'a1', ts: 8, attachments: [{ name: '../../x.png', url: `${base}/ok3.png` }] }),
      makeMessage({ id: 'm9', authorId: 'a2', ts: 9, attachments: [{ name: 'other.png', url: `${base}/other.png` }] }),
    ]);

    const zipPath = path.join(outDir, 'a1.zip');
    const result = await backupChannelImages(channel, 'a1', zipPath, {
      maxMessages: 1000,
      maxAttachmentBytes: 500,
      isAllowedUrl: (url) => url.startsWith(base),
    });

    assert.equal(result.fileCount, 4, 'good + three odd-named files');
    assert.equal(result.skipped, 4, 'big, nolength, missing, evil');
    assert.ok(fs.statSync(zipPath).size > 0);

    const all = await backupChannelImages(channel, null, path.join(outDir, 'all.zip'), {
      maxMessages: 1000,
      maxAttachmentBytes: 500,
      isAllowedUrl: (url) => url.startsWith(base),
    });
    assert.equal(all.fileCount, 5);
  } finally {
    server.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('backup aborts and removes the partial zip when the total cap is hit', async () => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-test-'));
  try {
    const channel = fakeChannel([
      makeMessage({ id: 'm1', authorId: 'a1', ts: 1, attachments: [{ name: 'one.png', url: `${base}/one.png` }] }),
      makeMessage({ id: 'm2', authorId: 'a1', ts: 2, attachments: [{ name: 'two.png', url: `${base}/two.png` }] }),
    ]);
    const zipPath = path.join(outDir, 'capped.zip');
    await assert.rejects(
      backupChannelImages(channel, 'a1', zipPath, { maxMessages: 1000, maxTotalBytes: 40, isAllowedUrl: allowAll }),
      BackupLimitExceededError
    );
    assert.equal(fs.existsSync(zipPath), false);
  } finally {
    server.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('default URL allow-list rejects anything that is not the Discord CDN', async () => {
  const channel = fakeChannel([
    makeMessage({ id: 'm1', authorId: 'a1', ts: 1, attachments: [{ name: 'x.png', url: 'https://evil.example/x.png' }] }),
  ]);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-test-'));
  try {
    const result = await backupChannelImages(channel, 'a1', path.join(outDir, 'z.zip'), { maxMessages: 10 });
    assert.equal(result.fileCount, 0);
    assert.equal(result.skipped, 1);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
