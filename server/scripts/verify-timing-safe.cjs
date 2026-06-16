/**
 * Verification script for timingSafeTokenEqual behavior
 * Tests: equal-length matching, equal-length non-matching, unequal-length, empty strings
 */

const crypto = require('crypto');

function timingSafeTokenEqual(provided, expected) {
  const providedBuffer = Buffer.from(provided, 'utf-8');
  const expectedBuffer = Buffer.from(expected, 'utf-8');

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

// Test cases
const tests = [
  {
    name: 'Equal-length and matching',
    provided: 'correct-token',
    expected: 'correct-token',
    expectedResult: true,
  },
  {
    name: 'Equal-length but not matching',
    provided: 'wrong-token',
    expected: 'right-tokex', // Same length, different chars
    expectedResult: false,
  },
  {
    name: 'Unequal-length (different lengths)',
    provided: 'short',
    expected: 'very-long-token',
    expectedResult: false,
  },
  {
    name: 'Empty strings',
    provided: '',
    expected: '',
    expectedResult: true, // Equal-length (0) and matching
  },
  {
    name: 'One empty string',
    provided: '',
    expected: 'non-empty',
    expectedResult: false, // Unequal-length
  },
];

console.log('timingSafeTokenEqual Verification Results\n');

let passCount = 0;
tests.forEach((test, index) => {
  try {
    const result = timingSafeTokenEqual(test.provided, test.expected);
    const passed = result === test.expectedResult;
    passCount += passed ? 1 : 0;

    console.log(`Test ${index + 1}: ${test.name}`);
    console.log(`  Provided: "${test.provided}" (${test.provided.length} chars)`);
    console.log(`  Expected: "${test.expected}" (${test.expected.length} chars)`);
    console.log(`  Result: ${result}`);
    console.log(`  Expected: ${test.expectedResult}`);
    console.log(`  Status: ${passed ? 'PASS' : 'FAIL'}`);
    console.log('');
  } catch (error) {
    console.error(`Test ${index + 1}: ${test.name} - ERROR: ${error.message}\n`);
  }
});

console.log(`Summary: ${passCount}/${tests.length} tests passed`);
process.exit(passCount === tests.length ? 0 : 1);
