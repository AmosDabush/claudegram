const { exec } = require('child_process');

const prompt = process.argv[2] || 'say hello';
const cwd = process.argv[3] || process.env.HOME;

const escapedPrompt = prompt.replace(/'/g, "'\\''");
const cmd = `claude -p '${escapedPrompt}'`;

console.log('='.repeat(50));
console.log('Testing Claude execution...');
console.log(`CWD: ${cwd}`);
console.log(`Command: ${cmd}`);
console.log('='.repeat(50));

const startTime = Date.now();

const proc = exec(cmd, {
  cwd: cwd,
  env: {
    ...process.env,
    PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}`
  },
  shell: '/bin/bash',
  maxBuffer: 10 * 1024 * 1024,
  timeout: 5 * 60 * 1000
}, (error, stdout, stderr) => {
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(50));
  console.log(`Duration: ${duration}s`);
  console.log(`Stdout length: ${stdout?.length || 0}`);
  console.log(`Stderr length: ${stderr?.length || 0}`);
  
  if (error) {
    console.log(`ERROR: ${error.message}`);
  }
  if (stderr) {
    console.log(`STDERR: ${stderr}`);
  }
  if (stdout) {
    console.log(`\nOUTPUT:\n${stdout}`);
  } else {
    console.log('\nNO OUTPUT');
  }
  console.log('='.repeat(50));
});

console.log(`PID: ${proc.pid}`);
