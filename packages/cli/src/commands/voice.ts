import { Command } from 'commander';

export const voiceCommand = new Command('voice')
  .description('Start JARVIS voice mode — voice-activated AI assistant')
  .option('--no-wake-word', 'Skip wake word detection (push-to-talk mode)')
  .option('--tts <provider>', 'TTS provider: system, elevenlabs, none', 'system')
  .option('--stt <provider>', 'STT provider: windows, ollama, openai, local')
  .option('--wake-word <phrase>', 'Custom wake word', 'hey joule')
  .action(async (options) => {
    const { Joule, SessionManager, VoiceEngine } = await import('@joule/core');
    const { setupJoule } = await import('../setup.js');
    const { generateId, isoNow } = await import('@joule/shared');

    const joule = new Joule();
    await joule.initialize();
    await setupJoule(joule);

    const sessionManager = new SessionManager();
    const session = await sessionManager.create();

    const voice = new VoiceEngine({
      wakeWord: options.wakeWord,
      sttProvider: options.stt,
      ttsProvider: options.tts,
    });

    const sttLabel = options.stt ?? (process.platform === 'win32' ? 'windows' : 'ollama');

    console.log('\n  JOULE VOICE MODE (JARVIS)');
    console.log('  ========================\n');
    console.log(`  Wake word: ${options.wakeWord ? `"${options.wakeWord}"` : 'disabled'}`);
    console.log(`  STT: ${sttLabel} | TTS: ${options.tts}`);
    console.log(`  Say "exit" or press Ctrl+C to quit.\n`);

    // Shared command handler: sends text to Joule and returns the response
    const handleCommand = async (text: string): Promise<string> => {
      sessionManager.addMessage(session, {
        role: 'user',
        content: text,
        timestamp: isoNow(),
      });

      const task = {
        id: generateId('task'),
        description: text,
        budget: 'medium' as const,
        messages: session.messages,
        createdAt: isoNow(),
      };

      let result = '';
      for await (const event of joule.executeStream(task)) {
        if (event.type === 'chunk' && event.chunk) {
          result += event.chunk.content;
        }
      }

      const response = result || 'Task completed.';

      sessionManager.addMessage(session, {
        role: 'assistant',
        content: response,
        timestamp: isoNow(),
      });

      return response;
    };

    if (!options.wakeWord) {
      // Push-to-talk mode (text input)
      const readline = await import('node:readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      let closed = false;
      let processing: Promise<void> | null = null;

      rl.on('close', async () => {
        if (!closed) {
          closed = true;
          // Wait for any pending command to finish before exiting
          if (processing) await processing;
          console.log('\n  Goodbye!\n');
          process.exit(0);
        }
      });

      const askQuestion = (): void => {
        if (closed) return;
        rl.question('  You > ', (input) => {
          if (closed) return;
          const text = input.trim();
          if (!text || text === 'exit' || text === 'quit') {
            closed = true;
            console.log('\n  Goodbye!\n');
            rl.close();
            process.exit(0);
          }

          console.log('  Processing...');

          processing = (async () => {
            try {
              const response = await handleCommand(text);
              console.log(`\n  Joule > ${response}\n`);
              await voice.speak(response);
            } catch (err) {
              console.error(`  Error: ${err instanceof Error ? err.message : String(err)}\n`);
            }
            processing = null;
            askQuestion();
          })();
        });
      };

      askQuestion();
    } else {
      // Wake word mode — full voice with microphone
      console.log(`  Listening for "${options.wakeWord}"...\n`);

      voice.startLoop(
        // Event handler
        (event) => {
          switch (event.type) {
            case 'listening':
              process.stdout.write('  🎤 Speak now...                    \r');
              break;
            case 'wake_word':
              console.log('  Wake word detected!');
              break;
            case 'recording':
              process.stdout.write('  [Recording...]                    \r');
              break;
            case 'transcribing':
              process.stdout.write('  [Transcribing...]                 \r');
              break;
            case 'processing':
              console.log(`\n  You > ${event.text}`);
              console.log('  Processing...');
              break;
            case 'speaking':
              console.log(`\n  Joule > ${event.text}\n`);
              break;
            case 'error':
              console.error(`\n  Error: ${event.error}\n`);
              break;
            case 'stopped':
              console.log('\n  Voice mode stopped.\n');
              break;
          }
        },
        // Command handler — executes through Joule
        async (text) => {
          return handleCommand(text);
        },
      );

      // Handle Ctrl+C
      process.on('SIGINT', () => {
        voice.stopLoop();
        console.log('\n  Goodbye!\n');
        process.exit(0);
      });
    }
  });
