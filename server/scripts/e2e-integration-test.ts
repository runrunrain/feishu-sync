/**
 * End-to-End Integration Test Script
 *
 * Tests the complete server flow: health → auth → index → detect → sync
 * This is a M5 verification script to ensure all components work together.
 */

import { spawn } from 'child_process';
import fetch from 'node-fetch';

const SERVER_URL = 'http://127.0.0.1:4123';
const DESKTOP_TOKEN = 'test-token-12345'; // This should match the generated token
const REAL_ROOT_URL = 'https://qcnbafdrjx7n.feishu.cn/wiki/Wramw1XxRihIgnkCrhqcdEbRnHb';

// ANSI color codes for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

function log(message: string, color: keyof typeof colors = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testHealthCheck(): Promise<boolean> {
  try {
    const response = await fetch(`${SERVER_URL}/api/health`);
    if (response.ok) {
      const data = await response.json();
      log('✓ Health check passed', 'green');
      log(`  Response: ${JSON.stringify(data)}`, 'blue');
      return true;
    }
    log('✗ Health check failed', 'red');
    log(`  Status: ${response.status}`, 'blue');
    return false;
  } catch (error) {
    log('✗ Health check failed with error', 'red');
    log(`  Error: ${error}`, 'blue');
    return false;
  }
}

async function testAuthStatus(): Promise<boolean> {
  try {
    const response = await fetch(`${SERVER_URL}/api/feishu/auth-status`, {
      headers: {
        'X-Desktop-Token': DESKTOP_TOKEN,
      },
    });
    if (response.ok) {
      const data = await response.json();
      log('✓ Auth status check passed', 'green');
      log(`  Response: ${JSON.stringify(data)}`, 'blue');
      return true;
    }
    log('✗ Auth status check failed', 'red');
    log(`  Status: ${response.status}`, 'blue');
    return false;
  } catch (error) {
    log('✗ Auth status check failed with error', 'red');
    log(`  Error: ${error}`, 'blue');
    return false;
  }
}

async function testIndexLocal(): Promise<boolean> {
  try {
    const response = await fetch(`${SERVER_URL}/api/sync/index`, {
      method: 'POST',
      headers: {
        'X-Desktop-Token': DESKTOP_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        knowledgeBaseRoot: 'D:/WorkPace/公司知识库', // Adjust path as needed
      }),
    });
    if (response.ok) {
      const data = await response.json();
      log('✓ Local index passed', 'green');
      log(`  Found ${data.indexedCount || 0} documents`, 'blue');
      return true;
    }
    log('✗ Local index failed', 'red');
    log(`  Status: ${response.status}`, 'blue');
    const errorText = await response.text();
    log(`  Error: ${errorText}`, 'blue');
    return false;
  } catch (error) {
    log('✗ Local index failed with error', 'red');
    log(`  Error: ${error}`, 'blue');
    return false;
  }
}

async function testDetectChanges(): Promise<boolean> {
  try {
    const startTime = Date.now();
    const response = await fetch(`${SERVER_URL}/api/detect/changes`, {
      method: 'POST',
      headers: {
        'X-Desktop-Token': DESKTOP_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        rootUrl: REAL_ROOT_URL,
      }),
    });
    const duration = Date.now() - startTime;
    if (response.ok) {
      const data = await response.json();
      log('✓ Change detection passed', 'green');
      log(`  Found ${data.changedDocuments?.length || 0} changed documents`, 'blue');
      log(`  Duration: ${duration}ms (target: < 5000ms)`, duration < 5000 ? 'green' : 'yellow');
      log(`  Total nodes checked: ${data.totalNodes || 0}`, 'blue');
      return true;
    }
    log('✗ Change detection failed', 'red');
    log(`  Status: ${response.status}`, 'blue');
    const errorText = await response.text();
    log(`  Error: ${errorText}`, 'blue');
    return false;
  } catch (error) {
    log('✗ Change detection failed with error', 'red');
    log(`  Error: ${error}`, 'blue');
    return false;
  }
}

async function testSyncSingle(): Promise<boolean> {
  try {
    // First, get changed documents
    const detectResponse = await fetch(`${SERVER_URL}/api/detect/changes`, {
      method: 'POST',
      headers: {
        'X-Desktop-Token': DESKTOP_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        rootUrl: REAL_ROOT_URL,
      }),
    });

    if (!detectResponse.ok) {
      log('✗ Sync test failed - could not get changed documents', 'red');
      return false;
    }

    const detectData = await detectResponse.json();
    const changedDocs = detectData.changedDocuments || [];

    if (changedDocs.length === 0) {
      log('! No changed documents to sync', 'yellow');
      return true; // Not a failure, just nothing to sync
    }

    // Select the first docx document for sync test
    const testDoc = changedDocs.find((doc: any) => doc.objType === 'docx');
    if (!testDoc) {
      log('! No docx documents to sync', 'yellow');
      return true; // Not a failure, just no docx docs
    }

    const startTime = Date.now();
    const syncResponse = await fetch(`${SERVER_URL}/api/sync`, {
      method: 'POST',
      headers: {
        'X-Desktop-Token': DESKTOP_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        documents: [testDoc],
        options: {
          enableLLM: false, // Disable LLM for faster testing
          fullSync: false,
        },
      }),
    });
    const duration = Date.now() - startTime;

    if (syncResponse.ok) {
      const syncData = await syncResponse.json();
      log('✓ Single document sync passed', 'green');
      log(`  Synced: ${syncData.syncedDocuments?.[0]?.title || 'unknown'}`, 'blue');
      log(`  Duration: ${duration}ms (target: < 30000ms)`, duration < 30000 ? 'green' : 'yellow');
      log(`  Size: ${syncData.syncedDocuments?.[0]?.size || 0} bytes`, 'blue');
      log(`  Images: ${syncData.syncedDocuments?.[0]?.imagesCount || 0}`, 'blue');
      return true;
    }
    log('✗ Single document sync failed', 'red');
    log(`  Status: ${syncResponse.status}`, 'blue');
    const errorText = await syncResponse.text();
    log(`  Error: ${errorText}`, 'blue');
    return false;
  } catch (error) {
    log('✗ Single document sync failed with error', 'red');
    log(`  Error: ${error}`, 'blue');
    return false;
  }
}

async function main() {
  log('=== Feishu Sync End-to-End Integration Test ===', 'blue');
  log('', 'reset');

  // Note: This script assumes the server is already running
  log('This script requires the server to be running.', 'yellow');
  log('Please start the server first with: npm run dev', 'yellow');
  log('', 'reset');

  const results = {
    healthCheck: false,
    authStatus: false,
    indexLocal: false,
    detectChanges: false,
    syncSingle: false,
  };

  // Run tests sequentially
  log('Step 1: Health Check', 'blue');
  results.healthCheck = await testHealthCheck();
  await sleep(1000);

  log('Step 2: Auth Status', 'blue');
  results.authStatus = await testAuthStatus();
  await sleep(1000);

  log('Step 3: Index Local', 'blue');
  results.indexLocal = await testIndexLocal();
  await sleep(1000);

  log('Step 4: Detect Changes', 'blue');
  results.detectChanges = await testDetectChanges();
  await sleep(1000);

  log('Step 5: Sync Single Document', 'blue');
  results.syncSingle = await testSyncSingle();
  await sleep(1000);

  // Summary
  log('', 'reset');
  log('=== Test Summary ===', 'blue');
  const allPassed = Object.values(results).every(result => result);
  const passCount = Object.values(results).filter(result => result).length;
  const totalCount = Object.keys(results).length;

  if (allPassed) {
    log(`✓ All tests passed (${passCount}/${totalCount})`, 'green');
  } else {
    log(`✗ Some tests failed (${passCount}/${totalCount})`, 'red');
    log('', 'reset');
    log('Detailed Results:', 'blue');
    for (const [test, passed] of Object.entries(results)) {
      log(`  ${test}: ${passed ? 'PASS' : 'FAIL'}`, passed ? 'green' : 'red');
    }
  }

  process.exit(allPassed ? 0 : 1);
}

main().catch((error) => {
  log('Unexpected error:', 'red');
  log(error.toString(), 'red');
  process.exit(1);
});
