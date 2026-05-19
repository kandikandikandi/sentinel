/**
 * Business Type Detector
 * Sophisticated detection using file analysis, dependency scanning, and code patterns
 */

const fs = require('fs');
const path = require('path');

class BusinessDetector {
  constructor(targetDir) {
    this.targetDir = targetDir;
    this.indicators = {
      ecommerce: { score: 0, signals: [] },
      fintech: { score: 0, signals: [] },
      healthcare: { score: 0, signals: [] },
      saas: { score: 0, signals: [] },
      research: { score: 0, signals: [] },
      social: { score: 0, signals: [] },
      education: { score: 0, signals: [] },
      logistics: { score: 0, signals: [] },
    };
  }

  findFiles(dir, pattern, maxDepth = 3, currentDepth = 0) {
    if (currentDepth > maxDepth) return [];

    let results = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Skip common directories
        if (['node_modules', '.git', 'dist', 'build', '.next', 'coverage'].includes(entry.name)) {
          continue;
        }

        if (entry.isDirectory()) {
          results = results.concat(this.findFiles(fullPath, pattern, maxDepth, currentDepth + 1));
        } else if (pattern.test(entry.name)) {
          results.push(fullPath);
        }
      }
    } catch (err) {
      // Permission denied or other errors - skip
    }

    return results;
  }

  readFilesSafely(files, maxSize = 1000000) {
    const contents = [];
    for (const file of files.slice(0, 50)) { // Max 50 files
      try {
        const stat = fs.statSync(file);
        if (stat.size > maxSize) continue; // Skip large files

        const content = fs.readFileSync(file, 'utf8');
        contents.push({ file, content });
      } catch (err) {
        // Skip unreadable files
      }
    }
    return contents;
  }

  analyzePackageJson() {
    const packageJsonPath = path.join(this.targetDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) return;

    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    // E-commerce indicators
    if (deps.stripe || deps['@stripe/stripe-js']) {
      this.indicators.ecommerce.score += 30;
      this.indicators.ecommerce.signals.push('Stripe integration');
    }
    if (deps.shopify || deps['@shopify/shopify-api']) {
      this.indicators.ecommerce.score += 25;
      this.indicators.ecommerce.signals.push('Shopify SDK');
    }
    if (deps.woocommerce || deps.bigcommerce) {
      this.indicators.ecommerce.score += 20;
      this.indicators.ecommerce.signals.push('E-commerce platform SDK');
    }

    // Fintech indicators
    if (deps.plaid || deps.dwolla) {
      this.indicators.fintech.score += 30;
      this.indicators.fintech.signals.push('Banking integration');
    }
    if (deps['@circle-fin/circle-sdk'] || deps.coinbase) {
      this.indicators.fintech.score += 25;
      this.indicators.fintech.signals.push('Crypto payments');
    }

    // Healthcare indicators
    if (deps.fhir || deps['@types/fhir']) {
      this.indicators.healthcare.score += 40;
      this.indicators.healthcare.signals.push('FHIR (healthcare standard)');
    }
    if (deps.hl7 || deps['@types/hl7']) {
      this.indicators.healthcare.score += 35;
      this.indicators.healthcare.signals.push('HL7 medical data');
    }

    // Research/AI indicators
    if (deps.openai || deps['@anthropic-ai/sdk'] || deps['@ai-sdk/openai']) {
      this.indicators.research.score += 25;
      this.indicators.research.signals.push('AI provider SDKs');
    }
    if (deps.tensorflow || deps['@tensorflow/tfjs'] || deps.pytorch) {
      this.indicators.research.score += 30;
      this.indicators.research.signals.push('ML frameworks');
    }

    // Social/messaging
    if (deps.socket || deps['socket.io'] || deps['socket.io-client']) {
      this.indicators.social.score += 15;
      this.indicators.social.signals.push('Real-time messaging');
    }
    if (deps.twilio || deps.sendbird || deps.pusher) {
      this.indicators.social.score += 20;
      this.indicators.social.signals.push('Chat/messaging SDK');
    }

    // Education
    if (deps.canvas || deps.moodle || deps['@instructure/canvas-api']) {
      this.indicators.education.score += 30;
      this.indicators.education.signals.push('LMS integration');
    }

    // SaaS
    if (deps.stripe && (deps['next-auth'] || deps.passport)) {
      this.indicators.saas.score += 20;
      this.indicators.saas.signals.push('SaaS auth + payments');
    }

    // Logistics
    if (deps.fedex || deps.ups || deps.shippo) {
      this.indicators.logistics.score += 30;
      this.indicators.logistics.signals.push('Shipping integration');
    }
  }

  analyzeCodePatterns() {
    const tsFiles = this.findFiles(this.targetDir, /\.(ts|tsx|js|jsx)$/);
    const fileContents = this.readFilesSafely(tsFiles);
    const allCode = fileContents.map(f => f.content).join('\n').toLowerCase();

    // E-commerce patterns
    const ecommerceKeywords = /\b(cart|checkout|order|product|inventory|sku|warehouse)\b/g;
    const ecommerceMatches = allCode.match(ecommerceKeywords);
    if (ecommerceMatches) {
      this.indicators.ecommerce.score += Math.min(ecommerceMatches.length * 2, 30);
      this.indicators.ecommerce.signals.push(`E-commerce keywords (${ecommerceMatches.length})`);
    }

    // Fintech patterns
    const fintechKeywords = /\b(account|transaction|balance|payment|transfer|wallet|kyc|aml)\b/g;
    const fintechMatches = allCode.match(fintechKeywords);
    if (fintechMatches) {
      this.indicators.fintech.score += Math.min(fintechMatches.length * 2, 25);
      this.indicators.fintech.signals.push(`Financial keywords (${fintechMatches.length})`);
    }

    // Healthcare patterns
    const healthcareKeywords = /\b(patient|diagnosis|prescription|medical|hipaa|phi|ehr|emr)\b/g;
    const healthcareMatches = allCode.match(healthcareKeywords);
    if (healthcareMatches) {
      this.indicators.healthcare.score += Math.min(healthcareMatches.length * 3, 35);
      this.indicators.healthcare.signals.push(`Healthcare keywords (${healthcareMatches.length})`);
    }

    // Research patterns
    const researchKeywords = /\b(research|experiment|interrogation|analysis|model|dataset|hypothesis)\b/g;
    const researchMatches = allCode.match(researchKeywords);
    if (researchMatches) {
      this.indicators.research.score += Math.min(researchMatches.length * 2, 30);
      this.indicators.research.signals.push(`Research keywords (${researchMatches.length})`);
    }

    // SaaS patterns
    const saasKeywords = /\b(subscription|tenant|organization|workspace|team|seat|license)\b/g;
    const saasMatches = allCode.match(saasKeywords);
    if (saasMatches) {
      this.indicators.saas.score += Math.min(saasMatches.length * 2, 25);
      this.indicators.saas.signals.push(`SaaS keywords (${saasMatches.length})`);
    }

    // Social patterns
    const socialKeywords = /\b(post|comment|like|follow|friend|message|dm|notification)\b/g;
    const socialMatches = allCode.match(socialKeywords);
    if (socialMatches) {
      this.indicators.social.score += Math.min(socialMatches.length * 2, 20);
      this.indicators.social.signals.push(`Social keywords (${socialMatches.length})`);
    }

    // Education patterns
    const eduKeywords = /\b(student|course|grade|assignment|quiz|exam|instructor|enrollment)\b/g;
    const eduMatches = allCode.match(eduKeywords);
    if (eduMatches) {
      this.indicators.education.score += Math.min(eduMatches.length * 2, 25);
      this.indicators.education.signals.push(`Education keywords (${eduMatches.length})`);
    }

    // Logistics patterns
    const logisticsKeywords = /\b(shipment|tracking|delivery|route|driver|warehouse|package)\b/g;
    const logisticsMatches = allCode.match(logisticsKeywords);
    if (logisticsMatches) {
      this.indicators.logistics.score += Math.min(logisticsMatches.length * 2, 20);
      this.indicators.logistics.signals.push(`Logistics keywords (${logisticsMatches.length})`);
    }
  }

  detect() {
    // Run all detection methods
    this.analyzePackageJson();
    this.analyzeCodePatterns();

    // Find top match
    let topType = 'saas'; // default
    let topScore = 0;

    for (const [type, data] of Object.entries(this.indicators)) {
      if (data.score > topScore) {
        topScore = data.score;
        topType = type;
      }
    }

    const confidence = Math.min(Math.round((topScore / 100) * 100), 95);

    return {
      type: topType,
      confidence,
      signals: this.indicators[topType].signals,
      allIndicators: this.indicators,
    };
  }

  // Runtime detection from file paths
  static detectFromFilePath(filePath) {
    const file = filePath.toLowerCase();

    if (file.includes('stripe') || file.includes('payment') || file.includes('checkout')) {
      return { type: 'ecommerce', confidence: 70 };
    }
    if (file.includes('patient') || file.includes('hipaa') || file.includes('medical')) {
      return { type: 'healthcare', confidence: 80 };
    }
    if (file.includes('account') || file.includes('transaction') || file.includes('kyc')) {
      return { type: 'fintech', confidence: 75 };
    }
    if (file.includes('research') || file.includes('experiment') || file.includes('analysis')) {
      return { type: 'research', confidence: 65 };
    }
    if (file.includes('student') || file.includes('course') || file.includes('grade')) {
      return { type: 'education', confidence: 70 };
    }
    if (file.includes('shipment') || file.includes('tracking') || file.includes('delivery')) {
      return { type: 'logistics', confidence: 65 };
    }

    return { type: null, confidence: 0 };
  }
}

module.exports = { BusinessDetector };
