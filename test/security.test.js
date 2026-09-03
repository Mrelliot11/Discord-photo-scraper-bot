'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const {
  findDangerousPermissions,
  auditChannelPermissions,
  buildMinimalInviteURL,
  isAllowedAttachmentUrl,
  REQUIRED_PERMISSIONS,
} = require('../src/lib/security');
const { buildBackupUI } = require('../src/lib/menuBuilder');
const { createSession, getSession, deleteSession } = require('../src/lib/sessionStore');
const { tryAcquire, release } = require('../src/lib/concurrencyLock');

// The permissions Discord grants @everyone in a brand-new server.
const DEFAULT_EVERYONE = new PermissionsBitField([
  PermissionFlagsBits.CreateInstantInvite,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.Stream,
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendTTSMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.UseExternalEmojis,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.UseVAD,
  PermissionFlagsBits.ChangeNickname,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.UseExternalStickers,
]);

test('a default @everyone role plus the required set is considered safe', () => {
  const perms = new PermissionsBitField([DEFAULT_EVERYONE, ...REQUIRED_PERMISSIONS]);
  assert.deepEqual(findDangerousPermissions(perms), []);
});

test('Administrator is reported alone, not as every permission it implies', () => {
  const perms = new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Administrator]);
  assert.deepEqual(findDangerousPermissions(perms), ['Administrator']);
});

test('moderation permissions are reported by their current names', () => {
  const perms = new PermissionsBitField([
    DEFAULT_EVERYONE,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ManageGuildExpressions,
  ]);
  assert.deepEqual(findDangerousPermissions(perms), ['KickMembers', 'ManageMessages', 'ManageGuildExpressions']);
});

test('channel audit reads the resolved channel permissions', () => {
  const channel = { permissionsFor: () => new PermissionsBitField([PermissionFlagsBits.ManageWebhooks]) };
  const audit = auditChannelPermissions(channel, {});
  assert.equal(audit.safe, false);
  assert.deepEqual(audit.excess, ['ManageWebhooks']);
  assert.equal(auditChannelPermissions({ permissionsFor: () => null }, {}).safe, true);
});

test('minimal invite URL carries exactly the required permission bits', () => {
  const url = new URL(buildMinimalInviteURL('123'));
  assert.equal(url.searchParams.get('client_id'), '123');
  assert.equal(url.searchParams.get('scope'), 'bot applications.commands');
  const bits = BigInt(url.searchParams.get('permissions'));
  assert.equal(bits, new PermissionsBitField(REQUIRED_PERMISSIONS).bitfield);
  assert.equal(bits & PermissionFlagsBits.Administrator, 0n);
});

test('attachment URL allow-list', () => {
  assert.equal(isAllowedAttachmentUrl('https://cdn.discordapp.com/attachments/1/2/a.png'), true);
  assert.equal(isAllowedAttachmentUrl('https://media.discordapp.net/attachments/1/2/a.png'), true);
  assert.equal(isAllowedAttachmentUrl('https://cdn.discordapp.com.evil.example/a.png'), false);
  assert.equal(isAllowedAttachmentUrl('https://evil.example/a.png'), false);
  assert.equal(isAllowedAttachmentUrl('not a url'), false);
});

test('user picker paginates 25 per page and clamps out-of-range pages', () => {
  const authors = Array.from({ length: 30 }, (_, i) => ({ id: `u${i}`, displayName: `User ${i}`, count: 30 - i }));
  const id = createSession({ channelId: 'c', guildId: 'g', requesterId: 'r', authors, page: 0 });
  const session = getSession(id);

  const page0 = buildBackupUI(session);
  assert.equal(page0.components[0].components[0].options.length, 25);

  session.page = 99;
  const last = buildBackupUI(session);
  assert.equal(session.page, 1);
  assert.equal(last.components[0].components[0].options.length, 5);

  deleteSession(id);
  assert.equal(getSession(id), null);
});

test('per-guild lock is exclusive and releasable', () => {
  assert.equal(tryAcquire('g1'), true);
  assert.equal(tryAcquire('g1'), false);
  assert.equal(tryAcquire('g2'), true);
  release('g1');
  assert.equal(tryAcquire('g1'), true);
  release('g1');
  release('g2');
});
