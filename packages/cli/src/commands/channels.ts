import { Command } from 'commander';

export const channelsCommand = new Command('channels')
  .description('Manage messaging channel integrations');

channelsCommand
  .command('status')
  .description('Show configured channel integrations')
  .action(async () => {
    const { Joule } = await import('@joule/core');

    const joule = new Joule();
    joule.initializeDatabase();
    await joule.initialize();
    const config = joule.config.getAll();

    console.log('Channel Integrations:\n');

    if (config.channels?.slack) {
      const slack = config.channels.slack;
      console.log('  Slack:');
      console.log(`    Status: configured`);
      console.log(`    Bot Token: ${slack.botToken.slice(0, 10)}...`);
      console.log(`    Budget Preset: ${slack.budgetPreset ?? 'medium'}`);
      if (slack.allowedChannels) {
        console.log(`    Allowed Channels: ${slack.allowedChannels.join(', ')}`);
      }
    } else {
      console.log('  Slack: not configured');
    }

    console.log('');

    if (config.channels?.discord) {
      const discord = config.channels.discord;
      console.log('  Discord:');
      console.log(`    Status: configured`);
      console.log(`    Bot Token: ${discord.botToken.slice(0, 10)}...`);
      console.log(`    Budget Preset: ${discord.budgetPreset ?? 'medium'}`);
      if (discord.allowedGuilds) {
        console.log(`    Allowed Guilds: ${discord.allowedGuilds.join(', ')}`);
      }
      if (discord.allowedChannels) {
        console.log(`    Allowed Channels: ${discord.allowedChannels.join(', ')}`);
      }
    } else {
      console.log('  Discord: not configured');
    }

    console.log('');

    if (config.channels?.telegram) {
      const tg = config.channels.telegram;
      console.log('  Telegram:');
      console.log(`    Status: configured`);
      console.log(`    Bot Token: ${tg.botToken.slice(0, 10)}...`);
      console.log(`    Budget Preset: ${tg.budgetPreset ?? 'medium'}`);
      if (tg.allowedChats) {
        console.log(`    Allowed Chats: ${tg.allowedChats.join(', ')}`);
      }
    } else {
      console.log('  Telegram: not configured');
    }

    console.log('');

    if (config.channels?.whatsapp) {
      const wa = config.channels.whatsapp;
      console.log('  WhatsApp:');
      console.log(`    Status: configured`);
      console.log(`    Budget Preset: ${wa.budgetPreset ?? 'medium'}`);
      if (wa.allowedNumbers) {
        console.log(`    Allowed Numbers: ${wa.allowedNumbers.join(', ')}`);
      }
    } else {
      console.log('  WhatsApp: not configured');
    }

    console.log('');

    if (config.channels?.signal) {
      const sig = config.channels.signal;
      console.log('  Signal:');
      console.log(`    Status: configured`);
      console.log(`    Account: ${sig.account}`);
      console.log(`    Budget Preset: ${sig.budgetPreset ?? 'medium'}`);
      if (sig.allowedNumbers) {
        console.log(`    Allowed Numbers: ${sig.allowedNumbers.join(', ')}`);
      }
    } else {
      console.log('  Signal: not configured');
    }

    console.log('');

    if (config.channels?.teams) {
      const teams = config.channels.teams;
      console.log('  Teams:');
      console.log(`    Status: configured`);
      console.log(`    App ID: ${teams.appId.slice(0, 10)}...`);
      console.log(`    Port: ${teams.port ?? 3978}`);
      console.log(`    Budget Preset: ${teams.budgetPreset ?? 'medium'}`);
    } else {
      console.log('  Teams: not configured');
    }

    console.log('');

    if (config.channels?.email) {
      const email = config.channels.email;
      console.log('  Email:');
      console.log(`    Status: configured`);
      console.log(`    IMAP: ${email.imap.host} (${email.imap.user})`);
      console.log(`    SMTP: ${email.smtp.host} (${email.smtp.user})`);
      console.log(`    Budget Preset: ${email.budgetPreset ?? 'medium'}`);
      if (email.allowedSenders) {
        console.log(`    Allowed Senders: ${email.allowedSenders.join(', ')}`);
      }
    } else {
      console.log('  Email: not configured');
    }

    console.log('');

    if (config.channels?.matrix) {
      const mx = config.channels.matrix;
      console.log('  Matrix:');
      console.log(`    Status: configured`);
      console.log(`    Homeserver: ${mx.homeserverUrl}`);
      console.log(`    User ID: ${mx.userId}`);
      console.log(`    Budget Preset: ${mx.budgetPreset ?? 'medium'}`);
      if (mx.allowedRooms) {
        console.log(`    Allowed Rooms: ${mx.allowedRooms.join(', ')}`);
      }
    } else {
      console.log('  Matrix: not configured');
    }

    console.log('');

    if (config.channels?.irc) {
      const irc = config.channels.irc;
      console.log('  IRC:');
      console.log(`    Status: configured`);
      console.log(`    Server: ${irc.server}:${irc.port ?? 6667}`);
      console.log(`    Nick: ${irc.nick}`);
      if (irc.channels) {
        console.log(`    Channels: ${irc.channels.join(', ')}`);
      }
    } else {
      console.log('  IRC: not configured');
    }

    console.log('');

    if (config.channels?.twilioSms) {
      const sms = config.channels.twilioSms;
      console.log('  Twilio SMS:');
      console.log(`    Status: configured`);
      console.log(`    Phone: ${sms.phoneNumber}`);
      console.log(`    Webhook Port: ${sms.webhookPort ?? 3080}`);
    } else {
      console.log('  Twilio SMS: not configured');
    }

    console.log('');

    if (config.channels?.webhook) {
      const wh = config.channels.webhook;
      console.log('  Webhook:');
      console.log(`    Status: configured`);
      console.log(`    Port: ${wh.port ?? 3081}`);
      console.log(`    Path: ${wh.path ?? '/webhook'}`);
      console.log(`    Auth: ${wh.secret ? 'enabled' : 'none'}`);
    } else {
      console.log('  Webhook: not configured');
    }

    const ch = config.channels;
    const hasAny = ch?.slack || ch?.discord || ch?.telegram || ch?.whatsapp
      || ch?.signal || ch?.teams || ch?.email || ch?.matrix
      || ch?.irc || ch?.twilioSms || ch?.webhook;
    if (!hasAny) {
      console.log('\nAdd channel config to joule.config.yaml:');
      console.log('  channels:');
      console.log('    slack:');
      console.log('      botToken: xoxb-...');
      console.log('      appToken: xapp-...');
      console.log('    discord:');
      console.log('      botToken: ...');
      console.log('    telegram:');
      console.log('      botToken: ...');
      console.log('    whatsapp:');
      console.log('      allowedNumbers: ["+1234567890"]');
      console.log('    signal:');
      console.log('      account: "+1234567890"');
      console.log('    teams:');
      console.log('      appId: ...');
      console.log('      appPassword: ...');
      console.log('    email:');
      console.log('      imap: { host: imap.gmail.com, user: ..., pass: ... }');
      console.log('      smtp: { host: smtp.gmail.com, user: ..., pass: ... }');
      console.log('    matrix:');
      console.log('      homeserverUrl: https://matrix.org');
      console.log('      accessToken: ...');
      console.log('      userId: "@bot:matrix.org"');
    }
  });

channelsCommand
  .command('test <platform>')
  .description('Test connection to a channel')
  .action(async (platform: string) => {
    const supported = ['slack', 'discord', 'telegram', 'whatsapp', 'signal', 'teams', 'email', 'matrix', 'irc', 'twilio-sms', 'webhook'];
    if (!supported.includes(platform)) {
      console.error(`Supported platforms: ${supported.join(', ')}`);
      process.exit(1);
    }

    const { Joule } = await import('@joule/core');
    const joule = new Joule();
    joule.initializeDatabase();
    await joule.initialize();
    const config = joule.config.getAll();

    if (platform === 'slack') {
      if (!config.channels?.slack) {
        console.error('Slack is not configured. Add slack config to joule.config.yaml');
        process.exit(1);
      }
      console.log('Testing Slack connection...');
      try {
        const { SlackChannel } = await import('@joule/channels');
        const { SessionManager } = await import('@joule/core');
        const channel = new SlackChannel(joule, new SessionManager(), config.channels.slack as any);
        await channel.start();
        console.log('Slack connection successful!');
        await channel.stop();
      } catch (err) {
        console.error(`Slack connection failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }

    if (platform === 'discord') {
      if (!config.channels?.discord) {
        console.error('Discord is not configured. Add discord config to joule.config.yaml');
        process.exit(1);
      }
      console.log('Testing Discord connection...');
      try {
        const { DiscordChannel } = await import('@joule/channels');
        const { SessionManager } = await import('@joule/core');
        const channel = new DiscordChannel(joule, new SessionManager(), config.channels.discord as any);
        await channel.start();
        console.log('Discord connection successful!');
        await channel.stop();
      } catch (err) {
        console.error(`Discord connection failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }

    if (platform === 'telegram') {
      if (!config.channels?.telegram) {
        console.error('Telegram is not configured. Add telegram config to joule.config.yaml');
        process.exit(1);
      }
      console.log('Testing Telegram connection...');
      try {
        const { TelegramChannel } = await import('@joule/channels');
        const { SessionManager } = await import('@joule/core');
        const channel = new TelegramChannel(joule, new SessionManager(), config.channels.telegram as any);
        await channel.start();
        console.log('Telegram connection successful!');
        await channel.stop();
      } catch (err) {
        console.error(`Telegram connection failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }

    if (platform === 'whatsapp') {
      if (!config.channels?.whatsapp) {
        console.error('WhatsApp is not configured. Add whatsapp config to joule.config.yaml');
        process.exit(1);
      }
      console.log('Testing WhatsApp connection...');
      try {
        const { WhatsAppChannel } = await import('@joule/channels');
        const { SessionManager } = await import('@joule/core');
        const channel = new WhatsAppChannel(joule, new SessionManager(), config.channels.whatsapp as any);
        await channel.start();
        console.log('WhatsApp connection successful!');
        await channel.stop();
      } catch (err) {
        console.error(`WhatsApp connection failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }

    if (platform === 'signal') {
      if (!config.channels?.signal) {
        console.error('Signal is not configured. Add signal config to joule.config.yaml');
        process.exit(1);
      }
      console.log('Testing Signal connection...');
      try {
        const { SignalChannel } = await import('@joule/channels');
        const { SessionManager } = await import('@joule/core');
        const channel = new SignalChannel(joule, new SessionManager(), config.channels.signal as any);
        await channel.start();
        console.log('Signal connection successful!');
        await channel.stop();
      } catch (err) {
        console.error(`Signal connection failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }

    if (platform === 'teams') {
      if (!config.channels?.teams) {
        console.error('Teams is not configured. Add teams config to joule.config.yaml');
        process.exit(1);
      }
      console.log('Testing Teams connection...');
      try {
        const { TeamsChannel } = await import('@joule/channels');
        const { SessionManager } = await import('@joule/core');
        const channel = new TeamsChannel(joule, new SessionManager(), config.channels.teams as any);
        await channel.start();
        console.log('Teams connection successful!');
        await channel.stop();
      } catch (err) {
        console.error(`Teams connection failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }

    if (platform === 'email') {
      if (!config.channels?.email) {
        console.error('Email is not configured. Add email config to joule.config.yaml');
        process.exit(1);
      }
      console.log('Testing Email connection...');
      try {
        const { EmailChannel } = await import('@joule/channels');
        const { SessionManager } = await import('@joule/core');
        const channel = new EmailChannel(joule, new SessionManager(), config.channels.email as any);
        await channel.start();
        console.log('Email connection successful!');
        await channel.stop();
      } catch (err) {
        console.error(`Email connection failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }

    if (platform === 'matrix') {
      if (!config.channels?.matrix) {
        console.error('Matrix is not configured. Add matrix config to joule.config.yaml');
        process.exit(1);
      }
      console.log('Testing Matrix connection...');
      try {
        const { MatrixChannel } = await import('@joule/channels');
        const { SessionManager } = await import('@joule/core');
        const channel = new MatrixChannel(joule, new SessionManager(), config.channels.matrix as any);
        await channel.start();
        console.log('Matrix connection successful!');
        await channel.stop();
      } catch (err) {
        console.error(`Matrix connection failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }

    if (platform === 'irc') {
      if (!config.channels?.irc) {
        console.error('IRC is not configured. Add irc config to joule.config.yaml');
        process.exit(1);
      }
      console.log('Testing IRC connection...');
      try {
        const { IrcChannel } = await import('@joule/channels');
        const { SessionManager } = await import('@joule/core');
        const channel = new IrcChannel(joule, new SessionManager(), config.channels.irc as any);
        await channel.start();
        console.log('IRC connection successful!');
        await channel.stop();
      } catch (err) {
        console.error(`IRC connection failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }

    if (platform === 'twilio-sms') {
      if (!config.channels?.twilioSms) {
        console.error('Twilio SMS is not configured. Add twilioSms config to joule.config.yaml');
        process.exit(1);
      }
      console.log('Testing Twilio SMS connection...');
      try {
        const { TwilioSmsChannel } = await import('@joule/channels');
        const { SessionManager } = await import('@joule/core');
        const channel = new TwilioSmsChannel(joule, new SessionManager(), config.channels.twilioSms as any);
        await channel.start();
        console.log('Twilio SMS connection successful!');
        await channel.stop();
      } catch (err) {
        console.error(`Twilio SMS connection failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }

    if (platform === 'webhook') {
      if (!config.channels?.webhook) {
        console.error('Webhook is not configured. Add webhook config to joule.config.yaml');
        process.exit(1);
      }
      console.log('Testing Webhook connection...');
      try {
        const { WebhookChannel } = await import('@joule/channels');
        const { SessionManager } = await import('@joule/core');
        const channel = new WebhookChannel(joule, new SessionManager(), config.channels.webhook as any);
        await channel.start();
        console.log('Webhook connection successful!');
        await channel.stop();
      } catch (err) {
        console.error(`Webhook connection failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }
  });
