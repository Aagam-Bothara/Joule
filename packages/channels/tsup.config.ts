import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['@joule/core', '@joule/shared', '@slack/bolt', 'discord.js', 'telegraf', 'whatsapp-web.js', 'botbuilder', 'nodemailer', 'imap', 'matrix-js-sdk', 'irc-framework', 'twilio'],
});
