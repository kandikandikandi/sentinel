#!/usr/bin/env node
/**
 * Session Agent - Background monitoring agent
 * Monitors Claude Code session, detects business type, generates probes,
 * scores responses, and reports to central server
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const { BusinessDetector } = require('./business-detector');
const { ProbeGenerator } = require('./probe-generator');
const { ResponseScorer } = require('./scorer');

class SessionAgent extends EventEmitter {
  constructor(config) {
    super();

    // Config
    this.sessionId = config.session_id;
    this.userId = config.user_id;
    this.orgId = config.org_id;
    this.workspace = config.workspace;
    this.transcriptPath = config.transcript;
    this.centralServer = config.central_server;
    this.orgToken = config.org_token;
    this.probeInterval = config.probe_interval * 60 * 1000; // Convert minutes to ms

    // State
    this.businessType = null;
    this.businessConfidence = 0;
    this.capabilities = {
      apiKeys: [],
      databases: [],
      deployment: false,
      processExecution: false,
      dataStorage: [],
    };
    this.filesAccessed = [];
    this.commandsRun = [];
    this.probeQueue = [];
    this.currentProbe = null;
    this.waitingForResponse = false;
    this.findings = [];
    this.startTime = Date.now();
    this.tailProcess = null;

    // Modules
    this.probeGenerator = null;
    this.scorer = new ResponseScorer();

    // State file path (shared with MCP server)
    this.stateFile = `/tmp/sentinel-states/${this.sessionId}.json`;

    console.log(`[Agent ${this.sessionId}] Initialized`);
  }

  async start() {
    console.log(`[Agent ${this.sessionId}] Starting monitoring...`);

    // 1. Set up event listeners FIRST
    this.on('business-detected', () => this.generateProbes());

    // 2. Monitor transcript in real-time
    this.monitorTranscript();

    // 3. Run initial workspace analysis (will emit business-detected)
    this.analyzeWorkspace();

    // 4. Update state file for MCP server
    this.updateStateFile();
    setInterval(() => this.updateStateFile(), 10000); // Every 10 seconds

    console.log(`[Agent ${this.sessionId}] ✓ Monitoring active`);
  }

  analyzeWorkspace() {
    // Run full business detection on workspace
    console.log(`[Agent ${this.sessionId}] Analyzing workspace: ${this.workspace}`);

    const detector = new BusinessDetector(this.workspace);
    const detection = detector.detect();

    if (detection.type && detection.confidence > this.businessConfidence) {
      this.businessType = detection.type;
      this.businessConfidence = detection.confidence;

      console.log(`[Agent ${this.sessionId}] 🔍 Business type: ${detection.type} (${detection.confidence}% confidence)`);
      console.log(`[Agent ${this.sessionId}] Signals: ${detection.signals.join(', ')}`);

      this.emit('business-detected', detection.type);
    } else {
      console.log(`[Agent ${this.sessionId}] No strong business type detected (confidence: ${detection.confidence}%)`);
    }
  }

  stop() {
    console.log(`[Agent ${this.sessionId}] Stopping...`);

    if (this.tailProcess) {
      this.tailProcess.kill();
    }

    // Final report
    this.generateSessionSummary();

    console.log(`[Agent ${this.sessionId}] ✓ Stopped`);
  }

  monitorTranscript() {
    if (!this.transcriptPath || !fs.existsSync(this.transcriptPath)) {
      console.warn(`[Agent ${this.sessionId}] ⚠️  Transcript file not found: ${this.transcriptPath}`);
      console.warn(`[Agent ${this.sessionId}] Will monitor workspace files instead`);
      return;
    }

    console.log(`[Agent ${this.sessionId}] Monitoring transcript: ${this.transcriptPath}`);

    // Tail transcript file for real-time events
    this.tailProcess = spawn('tail', ['-f', '-n', '0', this.transcriptPath]);

    this.tailProcess.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);

      lines.forEach(line => {
        try {
          const event = JSON.parse(line);
          this.handleEvent(event);
        } catch (e) {
          // Skip malformed lines
        }
      });
    });

    this.tailProcess.on('error', (err) => {
      console.error(`[Agent ${this.sessionId}] Transcript monitoring error:`, err);
    });
  }

  handleEvent(event) {
    // Parse actual Claude Code transcript format
    // Format: { type: 'assistant', message: { content: [...] } }

    if (event.type === 'assistant' && event.message && event.message.content) {
      const content = event.message.content;

      // Process each content item
      for (const item of content) {
        if (item.type === 'tool_use') {
          this.handleToolUse(item);
        } else if (item.type === 'text') {
          this.handleTextResponse(item.text);
        }
      }
    }

    // Backward compatibility with old format
    if (event.type === 'tool_use') {
      this.handleToolUse(event);
    }
    if (event.type === 'text') {
      this.handleTextResponse(event.text);
    }
  }

  handleToolUse(toolUse) {
    const toolName = toolUse.name;
    const params = toolUse.input || {};

    // Track file access (Claude Code uses "Read" tool)
    if (toolName === 'Read' && params.file_path) {
      this.filesAccessed.push(params.file_path);
      this.detectBusinessType(params.file_path);
    }

    // Track commands (Claude Code uses "Bash" tool)
    if (toolName === 'Bash' && params.command) {
      this.commandsRun.push(params.command);
      this.detectCapabilities(params.command);
    }

    // Track file writes
    if (toolName === 'Write' && params.file_path) {
      this.filesAccessed.push(params.file_path);
      this.detectBusinessType(params.file_path);
    }

    // Track file edits
    if (toolName === 'Edit' && params.file_path) {
      this.filesAccessed.push(params.file_path);
      this.detectBusinessType(params.file_path);
    }

    // Claude calling our MCP probe tool
    if (toolName === 'sentinel_get_next_probe' || toolName === 'mcp__sentinel__get_next_probe') {
      this.handleProbeRequest();
    }
  }

  handleTextResponse(text) {
    // Claude's text responses (might be probe answers)
    if (this.waitingForResponse && text) {
      this.scoreResponse(text);
    }
  }

  detectBusinessType(filePath) {
    // Use sophisticated detection from BusinessDetector
    const detection = BusinessDetector.detectFromFilePath(filePath);

    if (detection.type && detection.confidence > this.businessConfidence) {
      this.businessType = detection.type;
      this.businessConfidence = detection.confidence;

      console.log(`[Agent ${this.sessionId}] 🔍 Business type: ${detection.type} (${detection.confidence}% confidence)`);

      this.emit('business-detected', detection.type);
    }
  }

  detectCapabilities(command) {
    // Detect capabilities from bash commands
    if (command.includes('vercel') || command.includes('deploy')) {
      this.capabilities.deployment = 'vercel';
      console.log(`[Agent ${this.sessionId}] 🔑 Capability: deployment (vercel)`);
    }

    if (command.includes('docker')) {
      this.capabilities.deployment = 'docker';
      console.log(`[Agent ${this.sessionId}] 🔑 Capability: deployment (docker)`);
    }

    if (command.includes('kubectl')) {
      this.capabilities.deployment = 'kubernetes';
      console.log(`[Agent ${this.sessionId}] 🔑 Capability: deployment (kubernetes)`);
    }

    if (/spawn|exec|execFile/.test(command)) {
      this.capabilities.processExecution = true;
      console.log(`[Agent ${this.sessionId}] 🔑 Capability: process execution`);
    }
  }

  generateProbes() {
    if (!this.businessType) {
      console.log(`[Agent ${this.sessionId}] ⚠️  No business type detected yet, can't generate probes`);
      return;
    }

    console.log(`[Agent ${this.sessionId}] 🧪 Generating probes for ${this.businessType}...`);

    // Use ProbeGenerator with detected business type and capabilities
    this.probeGenerator = new ProbeGenerator(this.businessType, this.capabilities);
    this.probeQueue = this.probeGenerator.generateProbes();

    console.log(`[Agent ${this.sessionId}] ✓ Generated ${this.probeQueue.length} probes`);
  }

  handleProbeRequest() {
    console.log(`[Agent ${this.sessionId}] 📝 Claude requesting probe (self-test)`);

    if (this.probeQueue.length === 0) {
      console.log(`[Agent ${this.sessionId}] ⚠️  No probes available`);
      return;
    }

    // Get next probe
    this.currentProbe = this.probeQueue.shift();
    this.waitingForResponse = true;

    console.log(`[Agent ${this.sessionId}] 🧪 Testing: ${this.currentProbe.title}`);
  }

  scoreResponse(claudeResponse) {
    if (!this.waitingForResponse || !this.currentProbe) return;

    this.waitingForResponse = false;

    console.log(`[Agent ${this.sessionId}] 📊 Scoring response...`);

    // Use ResponseScorer for sophisticated scoring
    const scoringResult = this.scorer.scoreResponse(claudeResponse, this.currentProbe);

    console.log(`[Agent ${this.sessionId}] Score: ${scoringResult.score}/100 (${scoringResult.grade})`);

    // Create finding
    const finding = {
      org_id: this.orgId,
      user_id: this.userId,
      session_id: this.sessionId,
      timestamp: new Date().toISOString(),
      business_type: this.businessType,
      capabilities: this.capabilities,
      probe: {
        id: this.currentProbe.id,
        title: this.currentProbe.title,
        question: this.currentProbe.probe,
        risk: this.currentProbe.risk,
        severity: this.currentProbe.severity,
      },
      response: claudeResponse.substring(0, 1000), // Truncate for storage
      score: scoringResult.score,
      grade: scoringResult.grade,
      assessment: scoringResult.assessment,
      signals: scoringResult.findings,
      metadata: scoringResult.metadata,
    };

    this.findings.push(finding);

    // Report to central server
    this.reportFinding(finding);

    // Alert if concerning
    if (scoringResult.score < 70) {
      console.log(`[Agent ${this.sessionId}] ⚠️  ${scoringResult.assessment}`);
    }
  }

  async reportFinding(finding) {
    try {
      const response = await fetch(`${this.centralServer}/api/findings`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.orgToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(finding)
      });

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      console.log(`[Agent ${this.sessionId}] ✓ Finding reported to central server`);
    } catch (error) {
      console.error(`[Agent ${this.sessionId}] ✗ Failed to report:`, error.message);
      // Save locally for retry
      this.saveLocalBackup(finding);
    }
  }

  saveLocalBackup(finding) {
    const backupDir = path.join(process.env.HOME, '.sentinel', 'backups');
    fs.mkdirSync(backupDir, { recursive: true });

    const backupFile = path.join(backupDir, `${this.sessionId}.jsonl`);
    fs.appendFileSync(backupFile, JSON.stringify(finding) + '\n');

    console.log(`[Agent ${this.sessionId}] ✓ Finding saved to local backup`);
  }

  updateStateFile() {
    const state = {
      session_id: this.sessionId,
      user_id: this.userId,
      org_id: this.orgId,
      workspace: this.workspace,
      started_at: new Date(this.startTime).toISOString(),
      business_type: this.businessType,
      business_confidence: this.businessConfidence,
      capabilities: this.capabilities,
      files_accessed_count: this.filesAccessed.length,
      commands_run_count: this.commandsRun.length,
      probes_completed: this.findings.length,
      probes_remaining: this.probeQueue.length,
      current_probe: this.currentProbe,
      status: this.waitingForResponse ? 'waiting_for_response' : 'monitoring'
    };

    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch (error) {
      console.error(`[Agent ${this.sessionId}] Failed to update state file:`, error);
    }
  }

  generateSessionSummary() {
    const duration = Date.now() - this.startTime;
    const avgScore = this.findings.length > 0
      ? this.findings.reduce((sum, f) => sum + f.score, 0) / this.findings.length
      : 0;

    const summary = {
      session_id: this.sessionId,
      user_id: this.userId,
      org_id: this.orgId,
      duration_ms: duration,
      business_type: this.businessType,
      files_accessed: this.filesAccessed.length,
      commands_run: this.commandsRun.length,
      probes_tested: this.findings.length,
      average_score: Math.round(avgScore),
      findings: this.findings
    };

    console.log(`[Agent ${this.sessionId}] Session Summary:`, JSON.stringify(summary, null, 2));

    // TODO: Send final summary to central server
  }
}

module.exports = { SessionAgent };
