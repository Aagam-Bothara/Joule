import { Command } from 'commander';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const authCommand = new Command('auth')
  .description('Authenticate with external services');

authCommand
  .command('google')
  .description('Authenticate with Google (Gmail + Calendar)')
  .option('--client-id <id>', 'Google OAuth client ID')
  .option('--client-secret <secret>', 'Google OAuth client secret')
  .action(async (options) => {
    // Read existing config
    const configPath = resolve('joule.config.yaml');
    let configText: string;
    try {
      configText = await readFile(configPath, 'utf-8');
    } catch {
      console.error('Error: joule.config.yaml not found. Run from your Joule project root.');
      process.exit(1);
    }

    const clientId = options.clientId || process.env.GOOGLE_CLIENT_ID;
    const clientSecret = options.clientSecret || process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      console.log('Google OAuth Setup');
      console.log('==================');
      console.log('');
      console.log('1. Go to https://console.cloud.google.com/apis/credentials');
      console.log('2. Create an OAuth 2.0 Client ID (Desktop application)');
      console.log('3. Enable Gmail API and Google Calendar API');
      console.log('4. Run again with:');
      console.log('');
      console.log('   joule auth google --client-id YOUR_ID --client-secret YOUR_SECRET');
      console.log('');
      console.log('Or set environment variables:');
      console.log('   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy joule auth google');
      process.exit(1);
    }

    const PORT = 8091;
    const REDIRECT_URI = `http://localhost:${PORT}/callback`;
    const SCOPES = [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/calendar',
    ].join(' ');

    const authUrl =
      `https://accounts.google.com/o/oauth2/v2/auth` +
      `?client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(SCOPES)}` +
      `&access_type=offline` +
      `&prompt=consent`;

    console.log('Opening browser for Google authorization...');
    console.log('');
    console.log('If the browser does not open, visit this URL:');
    console.log(authUrl);
    console.log('');

    // Open browser
    const { exec } = await import('node:child_process');
    const platform = process.platform;
    if (platform === 'win32') exec(`start "" "${authUrl}"`);
    else if (platform === 'darwin') exec(`open "${authUrl}"`);
    else exec(`xdg-open "${authUrl}"`);

    // Start callback server
    const code = await new Promise<string>((resolveCode, reject) => {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url!, `http://localhost:${PORT}`);
        if (url.pathname !== '/callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const authCode = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
          server.close();
          reject(new Error(`Google auth error: ${error}`));
          return;
        }

        if (!authCode) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<h1>Missing authorization code</h1>');
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<h1 style="font-family:sans-serif;color:#4ecdc4">Joule — Google Authorization Successful!</h1>' +
          '<p style="font-family:sans-serif">You can close this window and return to the terminal.</p>',
        );

        server.close();
        resolveCode(authCode);
      });

      server.listen(PORT, () => {
        console.log(`Waiting for authorization callback on port ${PORT}...`);
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        server.close();
        reject(new Error('Authorization timed out (5 minutes)'));
      }, 5 * 60 * 1000);
    });

    // Exchange code for tokens
    console.log('Exchanging authorization code for tokens...');

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error(`Token exchange failed: ${err}`);
      process.exit(1);
    }

    const tokens = await tokenRes.json();

    if (!tokens.refresh_token) {
      console.error('Error: No refresh token received. Try revoking access at https://myaccount.google.com/permissions and re-running.');
      process.exit(1);
    }

    // Write to config
    const oauthSection = `
googleOAuth:
  clientId: "${clientId}"
  clientSecret: "${clientSecret}"
  refreshToken: "${tokens.refresh_token}"
`;

    if (configText.includes('googleOAuth:')) {
      // Replace existing section
      configText = configText.replace(
        /googleOAuth:[\s\S]*?(?=\n\w|\n$|$)/,
        oauthSection.trim(),
      );
    } else {
      // Append
      configText += '\n' + oauthSection;
    }

    await writeFile(configPath, configText, 'utf-8');

    console.log('');
    console.log('Google OAuth configured successfully!');
    console.log(`  Refresh token saved to ${configPath}`);
    console.log('');
    console.log('You can now use these tools:');
    console.log('  gmail_search, gmail_read, gmail_send, gmail_modify, gmail_draft');
    console.log('  calendar_list, calendar_create, calendar_update, calendar_delete');
  });
