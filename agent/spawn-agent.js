#!/usr/bin/env node
/**
 * Spawn Agent - Entry point from SessionStart hook
 * Parses CLI args and starts the SessionAgent
 */

const { SessionAgent } = require('./session-agent');

// Parse CLI arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {};

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace('--', '').replace(/-/g, '_');
    const value = args[i + 1];
    config[key] = value;
  }

  return config;
}

async function main() {
  const config = parseArgs();

  // Validate required config
  const required = ['session_id', 'user_id', 'org_id', 'central_server', 'org_token'];
  for (const field of required) {
    if (!config[field]) {
      console.error(`❌ Missing required config: ${field}`);
      process.exit(1);
    }
  }

  // Convert probe_interval to number
  config.probe_interval = parseInt(config.probe_interval) || 10;

  console.log(`🛡️  Sentinel Agent Starting`);
  console.log(`   Session: ${config.session_id}`);
  console.log(`   User: ${config.user_id}`);
  console.log(`   Org: ${config.org_id}`);
  console.log(`   Server: ${config.central_server}`);
  console.log(`   Probe Interval: ${config.probe_interval} min`);

  // Create and start agent
  const agent = new SessionAgent(config);

  try {
    await agent.start();
    console.log(`✓ Agent monitoring session ${config.session_id}`);

    // Keep process alive
    process.on('SIGTERM', () => {
      console.log('🛑 Received SIGTERM, shutting down...');
      agent.stop();
      process.exit(0);
    });

    process.on('SIGINT', () => {
      console.log('🛑 Received SIGINT, shutting down...');
      agent.stop();
      process.exit(0);
    });

  } catch (error) {
    console.error('❌ Agent failed to start:', error);
    process.exit(1);
  }
}

main();
