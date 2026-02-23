import { Command } from 'commander';

export const serveCommand = new Command('serve')
  .description('Start the Joule HTTP API server')
  .option('-p, --port <port>', 'Server port')
  .option('-H, --host <host>', 'Server host')
  .option('--docker', 'Read configuration from environment variables (container mode)')
  .action(async (options) => {
    // Dynamic import to avoid loading server deps in CLI-only mode
    const { startServer } = await import('@joule/server');
    const { Joule } = await import('@joule/core');
    const { setupJoule } = await import('../setup.js');

    // Build config from flags or environment variables (Docker mode)
    const port = parseInt(options.port || process.env.JOULE_PORT || '3927', 10);
    const host = options.host || process.env.JOULE_HOST || '127.0.0.1';

    const overrides: Record<string, unknown> = {
      server: { port, host },
    };

    // Docker mode: read provider config from environment
    if (options.docker || process.env.OLLAMA_BASE_URL) {
      const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
      const defaultModel = process.env.JOULE_DEFAULT_MODEL || 'qwen2.5:1.5b';
      overrides.providers = {
        ollama: {
          baseUrl: ollamaUrl,
          models: { slm: defaultModel },
          enabled: true,
        },
      };
    }

    // Auth from environment
    if (process.env.JOULE_AUTH_ENABLED === 'true') {
      overrides.auth = {
        enabled: true,
        jwtSecret: process.env.JOULE_JWT_SECRET || 'joule-dev-secret',
        tokenExpirySeconds: 86400,
        store: 'file',
      };
    }

    const joule = new Joule(overrides as any);
    await joule.initialize();
    await setupJoule(joule);

    await startServer(joule);

    // Start messaging channels if configured
    const config = joule.config.getAll();
    if (config.channels?.slack) {
      try {
        const { SlackChannel } = await import('@joule/channels');
        const { SessionManager } = await import('@joule/core');
        const slack = new SlackChannel(joule, new SessionManager(), config.channels.slack as any);
        await slack.start();
      } catch (err) {
        console.warn(`Slack: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (config.channels?.discord) {
      try {
        const { DiscordChannel } = await import('@joule/channels');
        const { SessionManager } = await import('@joule/core');
        const discord = new DiscordChannel(joule, new SessionManager(), config.channels.discord as any);
        await discord.start();
      } catch (err) {
        console.warn(`Discord: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (config.channels?.telegram) {
      try {
        const { TelegramChannel } = await import('@joule/channels');
        const { SessionManager } = await import('@joule/core');
        const telegram = new TelegramChannel(joule, new SessionManager(), config.channels.telegram as any);
        await telegram.start();
      } catch (err) {
        console.warn(`Telegram: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (config.channels?.whatsapp) {
      try {
        const { WhatsAppChannel } = await import('@joule/channels');
        const { SessionManager } = await import('@joule/core');
        const whatsapp = new WhatsAppChannel(joule, new SessionManager(), config.channels.whatsapp as any);
        await whatsapp.start();
      } catch (err) {
        console.warn(`WhatsApp: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (config.channels?.signal) {
      try {
        const { SignalChannel } = await import('@joule/channels');
        const { SessionManager } = await import('@joule/core');
        const signal = new SignalChannel(joule, new SessionManager(), config.channels.signal as any);
        await signal.start();
      } catch (err) {
        console.warn(`Signal: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (config.channels?.teams) {
      try {
        const { TeamsChannel } = await import('@joule/channels');
        const { SessionManager } = await import('@joule/core');
        const teams = new TeamsChannel(joule, new SessionManager(), config.channels.teams as any);
        await teams.start();
      } catch (err) {
        console.warn(`Teams: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (config.channels?.email) {
      try {
        const { EmailChannel } = await import('@joule/channels');
        const { SessionManager } = await import('@joule/core');
        const email = new EmailChannel(joule, new SessionManager(), config.channels.email as any);
        await email.start();
      } catch (err) {
        console.warn(`Email: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (config.channels?.matrix) {
      try {
        const { MatrixChannel } = await import('@joule/channels');
        const { SessionManager } = await import('@joule/core');
        const matrix = new MatrixChannel(joule, new SessionManager(), config.channels.matrix as any);
        await matrix.start();
      } catch (err) {
        console.warn(`Matrix: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (config.channels?.irc) {
      try {
        const { IrcChannel } = await import('@joule/channels');
        const { SessionManager } = await import('@joule/core');
        const irc = new IrcChannel(joule, new SessionManager(), config.channels.irc as any);
        await irc.start();
      } catch (err) {
        console.warn(`IRC: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (config.channels?.twilioSms) {
      try {
        const { TwilioSmsChannel } = await import('@joule/channels');
        const { SessionManager } = await import('@joule/core');
        const sms = new TwilioSmsChannel(joule, new SessionManager(), config.channels.twilioSms as any);
        await sms.start();
      } catch (err) {
        console.warn(`Twilio SMS: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (config.channels?.webhook) {
      try {
        const { WebhookChannel } = await import('@joule/channels');
        const { SessionManager } = await import('@joule/core');
        const webhook = new WebhookChannel(joule, new SessionManager(), config.channels.webhook as any);
        await webhook.start();
      } catch (err) {
        console.warn(`Webhook: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Start proactive engine if configured
    if (config.proactive?.enabled) {
      try {
        const { ProactiveEngine } = await import('@joule/core');
        const engine = new ProactiveEngine(joule, config.proactive.tickIntervalMs);
        engine.start((event) => {
          console.log(`[Proactive] ${event.message}`);
        });
        console.log('Proactive engine started');
      } catch (err) {
        console.warn(`Proactive: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Start scheduler if configured
    if (config.schedule?.enabled) {
      try {
        const { Scheduler } = await import('@joule/core');
        const scheduler = new Scheduler(joule, {
          scheduleFile: config.schedule.scheduleFile,
          maxConcurrent: config.schedule.maxConcurrent,
        });
        scheduler.start();
        console.log('Scheduler started');
      } catch (err) {
        console.warn(`Scheduler: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
