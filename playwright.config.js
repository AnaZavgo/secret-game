const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests',
  workers: 1,
  timeout: 240000,
  expect: { timeout: 25000 }, // above the game's 15-second poll
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.BASE_URL || 'https://play.vivannikov.com',
    viewport: { width: 390, height: 844 },
    trace: 'retain-on-failure',
  },
});
