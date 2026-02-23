import { Command } from 'commander';
import { resolve } from 'node:path';

export const usersCommand = new Command('users')
  .description('Manage Joule users and API keys');

usersCommand
  .command('create')
  .description('Create a new user')
  .requiredOption('-u, --username <username>', 'Username')
  .requiredOption('-p, --password <password>', 'Password')
  .option('-r, --role <role>', 'User role (user or admin)', 'user')
  .action(async (options) => {
    const { UserStore } = await import('@joule/server');

    const store = new UserStore(resolve('.joule', 'users.json'));
    await store.load();

    try {
      const user = await store.createUser(options.username, options.password, options.role);
      console.log(`User created:`);
      console.log(`  ID:       ${user.id}`);
      console.log(`  Username: ${user.username}`);
      console.log(`  Role:     ${user.role}`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

usersCommand
  .command('list')
  .description('List all users')
  .action(async () => {
    const { UserStore } = await import('@joule/server');

    const store = new UserStore(resolve('.joule', 'users.json'));
    await store.load();

    const users = store.listUsers();
    if (users.length === 0) {
      console.log('No users found.');
      return;
    }

    console.log(`${'ID'.padEnd(20)} ${'Username'.padEnd(20)} ${'Role'.padEnd(10)} ${'API Keys'.padEnd(10)} Created`);
    console.log('-'.repeat(80));
    for (const user of users) {
      console.log(
        `${user.id.padEnd(20)} ${user.username.padEnd(20)} ${user.role.padEnd(10)} ${String(user.apiKeys.length).padEnd(10)} ${user.createdAt}`,
      );
    }
  });

usersCommand
  .command('delete')
  .description('Delete a user')
  .requiredOption('-u, --username <username>', 'Username to delete')
  .action(async (options) => {
    const { UserStore } = await import('@joule/server');

    const store = new UserStore(resolve('.joule', 'users.json'));
    await store.load();

    const user = store.getByUsername(options.username);
    if (!user) {
      console.error(`User "${options.username}" not found.`);
      process.exit(1);
    }

    await store.deleteUser(user.id);
    console.log(`User "${options.username}" deleted.`);
  });

usersCommand
  .command('api-key')
  .description('Create an API key for a user')
  .requiredOption('-u, --username <username>', 'Username')
  .option('-n, --name <name>', 'Key name', 'default')
  .action(async (options) => {
    const { UserStore } = await import('@joule/server');

    const store = new UserStore(resolve('.joule', 'users.json'));
    await store.load();

    const user = store.getByUsername(options.username);
    if (!user) {
      console.error(`User "${options.username}" not found.`);
      process.exit(1);
    }

    const apiKey = await store.createApiKey(user.id, options.name);
    console.log(`API key created for "${options.username}":`);
    console.log(`  Key: ${apiKey.key}`);
    console.log(`  ID:  ${apiKey.id}`);
    console.log('');
    console.log('Save this key now - it will not be shown again.');
  });
