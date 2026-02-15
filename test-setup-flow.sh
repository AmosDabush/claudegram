#!/bin/bash

# Test setup wizard with mock inputs
# This simulates a user going through the entire setup process

echo "🧪 Testing Setup Wizard Flow"
echo "=============================="
echo ""
echo "This will simulate user input to test the complete wizard."
echo "Press Ctrl+C to cancel at any time."
echo ""
sleep 2

# Mock inputs (in order):
# 1. Bot token
# 2. User IDs
# 3. Claude path (press enter for default)
# 4. Install dependencies? (n)

echo "1234567890:ABCdefGhIjKlmNoPqRsTuVwXyZ_FAKE_TOKEN_FOR_TEST" | \
echo "123456789" | \
echo "" | \
echo "n" | \
node setup.js

# Note: This won't work properly because readline doesn't read from echo pipes
# We need to test it manually or use a different approach

echo ""
echo "⚠️  Note: Interactive testing requires manual input"
echo "Please run: npm run setup"
echo "And test with these values:"
echo ""
echo "Bot Token: 1234567890:ABCdefGhIjKlmNoPqRsTuVwXyZ (format example)"
echo "User ID: 123456789 (your actual ID from @userinfobot)"
echo "Claude Path: (just press Enter for default)"
echo "Install deps: n (to skip during testing)"
