'use strict';

const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');

/**
 * The exact permissions this bot needs to do its job: read a channel's
 * history and post an embed + zip file back. Used to build the minimal
 * invite link so operators never over-provision the bot at creation time.
 */
const REQUIRED_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
];

/**
 * Permissions that have no legitimate use for a read-only photo scraper and
 * would meaningfully raise the blast radius of a leaked bot token. If the
 * bot's effective permissions (guild-wide role grant OR a channel overwrite)
 * include any of these, the bot refuses to operate until an admin removes
 * them. This is a denylist rather than a strict allowlist because Discord's
 * default @everyone role already grants harmless extras (reactions,
 * nicknames, voice) that every bot inherits — a strict allowlist would block
 * the bot in almost every real server.
 */
const DANGEROUS_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ViewAuditLog,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.CreateInstantInvite,
  PermissionFlagsBits.DeafenMembers,
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.MoveMembers,
];

/** Only fetch/proxy attachments from Discord's own CDN hosts. */
const ALLOWED_ATTACHMENT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

function minimalPermissionsBitfield() {
  return new PermissionsBitField(REQUIRED_PERMISSIONS);
}

function buildMinimalInviteURL(clientId) {
  const permissions = minimalPermissionsBitfield().bitfield.toString();
  const params = new URLSearchParams({
    client_id: clientId,
    scope: 'bot applications.commands',
    permissions,
  });
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

function nameOfPermission(flag) {
  return Object.entries(PermissionFlagsBits).find(([, value]) => value === flag)?.[0] ?? String(flag);
}

function findDangerousPermissions(permissions) {
  // Administrator implicitly grants every other permission, which would
  // otherwise make PermissionsBitField#has() report every single dangerous
  // permission as present. Check raw bits (checkAdmin = false) and, if
  // Administrator itself is set, report just that — it already subsumes
  // (and is a stronger justification to block than) everything else.
  if (permissions.has(PermissionFlagsBits.Administrator, false)) {
    return ['Administrator'];
  }
  return DANGEROUS_PERMISSIONS.filter((flag) => permissions.has(flag, false)).map(nameOfPermission);
}

/**
 * Checks the bot's guild-wide role permissions (ignores channel overwrites)
 * so a dangerous permission granted anywhere in the guild is caught even if
 * a channel overwrite happens to hide it locally.
 */
async function auditGuildPermissions(guild) {
  // Force a fresh fetch rather than trusting the cache: a role change can
  // happen at any moment and this check exists specifically to catch that.
  const me = await guild.members.fetchMe({ force: true });
  const excess = findDangerousPermissions(me.permissions);
  return { safe: excess.length === 0, excess, scope: 'guild-role' };
}

/** Checks the bot's effective, resolved permissions in one specific channel. */
function auditChannelPermissions(channel, botMember) {
  const permissions = channel.permissionsFor(botMember);
  if (!permissions) return { safe: true, excess: [], scope: 'channel' };
  const excess = findDangerousPermissions(permissions);
  return { safe: excess.length === 0, excess, scope: 'channel' };
}

function isAllowedAttachmentUrl(url) {
  try {
    return ALLOWED_ATTACHMENT_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

module.exports = {
  REQUIRED_PERMISSIONS,
  DANGEROUS_PERMISSIONS,
  buildMinimalInviteURL,
  findDangerousPermissions,
  auditGuildPermissions,
  auditChannelPermissions,
  isAllowedAttachmentUrl,
};
