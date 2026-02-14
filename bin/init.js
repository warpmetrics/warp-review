#!/usr/bin/env node

import { createInterface } from 'readline';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultsDir = join(__dirname, '..', 'defaults');

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function log(msg) {
  console.log(msg);
}

async function main() {
  log('');
  log('  warp-review \u2014 AI code reviewer powered by WarpMetrics');
  log('');

  // 1. Anthropic API key
  const llmKey = await ask('  ? Anthropic API key: ');
  if (!llmKey.startsWith('sk-ant-')) {
    log('  \u26a0 Warning: key doesn\'t start with sk-ant- — make sure this is a valid Anthropic API key');
  }

  // 2. WarpMetrics API key
  const wmKey = await ask('  ? WarpMetrics API key (get one at warpmetrics.com/app/api-keys): ');
  if (!wmKey.startsWith('wm_')) {
    log('  \u26a0 Warning: key doesn\'t start with wm_ — make sure this is a valid WarpMetrics API key');
  }

  // 3. Model
  const modelInput = await ask('  ? Model (default: claude-sonnet-4-20250514): ');
  const model = modelInput.trim() || 'claude-sonnet-4-20250514';

  log('');

  // 4. Set GitHub secrets
  let ghAvailable = false;
  try {
    execSync('gh --version', { stdio: 'ignore' });
    ghAvailable = true;
  } catch {
    ghAvailable = false;
  }

  if (ghAvailable) {
    log('  Setting GitHub secrets...');
    try {
      execSync('gh secret set WARP_REVIEW_LLM_API_KEY', { input: llmKey, stdio: ['pipe', 'ignore', 'ignore'] });
      log('  \u2713 WARP_REVIEW_LLM_API_KEY set');
    } catch (e) {
      log(`  \u2717 Failed to set WARP_REVIEW_LLM_API_KEY: ${e.message}`);
    }
    try {
      execSync('gh secret set WARP_REVIEW_WARPMETRICS_API_KEY', { input: wmKey, stdio: ['pipe', 'ignore', 'ignore'] });
      log('  \u2713 WARP_REVIEW_WARPMETRICS_API_KEY set');
    } catch (e) {
      log(`  \u2717 Failed to set WARP_REVIEW_WARPMETRICS_API_KEY: ${e.message}`);
    }
  } else {
    log('  gh (GitHub CLI) not found. Set these secrets manually:');
    log('');
    log('  gh secret set WARP_REVIEW_LLM_API_KEY');
    log('  gh secret set WARP_REVIEW_WARPMETRICS_API_KEY');
    log('  (gh will prompt for the value interactively)');
  }
  log('');

  // 5. Create .warp-review/skills.md
  const warpReviewDir = '.warp-review';
  if (existsSync(warpReviewDir)) {
    const overwrite = await ask('  warp-review is already configured. Overwrite? (y/N): ');
    if (overwrite.toLowerCase() !== 'y') {
      log('  Skipping .warp-review/ creation');
    } else {
      createWarpReviewDir(model);
    }
  } else {
    createWarpReviewDir(model);
  }

  // 6. Create workflow
  const workflowPath = '.github/workflows/warp-review.yml';
  if (existsSync(workflowPath)) {
    const overwrite = await ask('  Workflow already exists. Overwrite? (y/N): ');
    if (overwrite.toLowerCase() !== 'y') {
      log('  Skipping workflow creation');
    } else {
      createWorkflow();
    }
  } else {
    createWorkflow();
  }

  log('');

  // 7. Register outcome classifications
  log('  Registering outcome classifications with WarpMetrics...');
  const classifications = [
    { name: 'Accepted', classification: 'success' },
    { name: 'Merged', classification: 'success' },
    { name: 'Active', classification: 'neutral' },
    { name: 'Superseded', classification: 'neutral' },
    { name: 'Closed', classification: 'neutral' },
    { name: 'Ignored', classification: 'failure' },
  ];

  let classOk = true;
  for (const { name, classification } of classifications) {
    try {
      const res = await fetch(`https://api.warpmetrics.com/v1/outcomes/classifications/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${wmKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ classification }),
      });
      if (!res.ok) {
        classOk = false;
        console.warn(`  \u26a0 Failed to set classification ${name}: ${res.status}`);
      }
    } catch (e) {
      classOk = false;
      console.warn(`  \u26a0 Failed to set classification ${name}: ${e.message}`);
    }
  }
  if (classOk) {
    log('  \u2713 Outcomes configured');
  } else {
    log('  \u26a0 Some classifications failed — you can set them manually in the WarpMetrics dashboard');
  }

  // 8. Print next steps
  log('');
  log('  Done! Next steps:');
  log('  1. git add .warp-review .github/workflows/warp-review.yml');
  log('  2. git commit -m "Add warp-review"');
  log('  3. Open a PR to see your first AI review');
  log('  4. View analytics at https://app.warpmetrics.com');
  log('');
  log('  Optional \u2014 add this badge to your README:');
  log('  ![warp-review](https://img.shields.io/badge/warp--review---%25%20accepted-purple)');
  log('  (copy the line above into your README.md)');
  log('');

  rl.close();
}

function createWarpReviewDir(model) {
  mkdirSync('.warp-review', { recursive: true });

  log('  Creating .warp-review/skills.md...');
  copyFileSync(join(defaultsDir, 'skills.md'), '.warp-review/skills.md');
  log('  \u2713 Default skills file created');

  log('  Creating .warp-review/config.json...');
  const config = JSON.parse(readFileSync(join(defaultsDir, 'config.json'), 'utf8'));
  config.model = model;
  writeFileSync('.warp-review/config.json', JSON.stringify(config, null, 2) + '\n');
  log('  \u2713 Config created');
}

function createWorkflow() {
  log('  Creating .github/workflows/warp-review.yml...');
  mkdirSync('.github/workflows', { recursive: true });
  copyFileSync(join(defaultsDir, 'warp-review.yml'), '.github/workflows/warp-review.yml');
  log('  \u2713 Workflow created');
}

main().catch(err => {
  console.error('init failed:', err.message);
  process.exitCode = 1;
  rl.close();
});
