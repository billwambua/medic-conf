#!/usr/bin/env node

const error = require('../src/lib/log').error;
const fs = require('../src/lib/sync-fs');
const info = require('../src/lib/log').info;
const readline = require('readline-sync');
const redactBasicAuth = require('redact-basic-auth');
const supportedActions = require('../src/cli/supported-actions');
const usage = require('../src/cli/usage');
const warn = require('../src/lib/log').warn;

let args = process.argv.slice(2);
const shift = n => args = args.slice(n || 1);

let instanceUrl;

switch(args[0]) {

//> instance URL handling:
  case '--instance':
    instanceUrl = `https://${args[1]}.medicmobile.org`;
    shift(2);
    break;
  case '--local':
    instanceUrl = 'http://admin:pass@localhost:5988';
    shift();
    break;
  case '--url':
    instanceUrl = args[1];
    shift(2);
    break;

//> general option handling:
  case '--help': return usage(0);
  case '--shell-completion':
    return require('../src/cli/shell-completion-setup')(args[1]);
  case '--supported-actions':
    console.log('Supported actions:\n ', supportedActions.join('\n  '));
    return process.exit(0);
  case '--version':
    console.log('beta-' + require('../package.json').version);
    return process.exit(0);
}

const projectName = fs.path.basename(fs.path.resolve('.'));
const couchUrl = instanceUrl && `${instanceUrl}/medic`;

if(instanceUrl) {
  if(instanceUrl.match('/medic$')) warn('Supplied URL ends in "/medic".  This is probably incorrect.');

  const productionUrlMatch = instanceUrl.match(/^http(?:s)?:\/\/(?:[^@]*@)?(.*)\.app\.medicmobile\.org(?:$|\/)/);
  if(productionUrlMatch && productionUrlMatch[1] !== projectName) {
    warn(`Attempting to upload configuration for \x1b[31m${projectName}\x1b[33m `,
        `to production instance: \x1b[31m${redactBasicAuth(instanceUrl)}\x1b[33m`);
    if(!readline.keyInYN()) {
      error('User failed to confirm action.');
      process.exit(1);
    }
  }
}

let actions = args;
let extraArgs;

const argDivider = actions.indexOf('--');
if(argDivider !== -1) {
  extraArgs = actions.slice(argDivider + 1);
  actions = actions.slice(0, argDivider);
}

if(!actions.length) {
  actions = [
    'compile-app-settings',
    'backup-app-settings',
    'upload-app-settings',
    'convert-app-forms',
    'convert-collect-forms',
    'convert-contact-forms',
    'backup-all-forms',
    'delete-all-forms',
    'upload-app-forms',
    'upload-collect-forms',
    'upload-contact-forms',
    'upload-resources',
    'upload-custom-translations',
  ];
}

const unsupported = actions.filter(a => !supportedActions.includes(a));
if(unsupported.length) {
  error(`Unsupported action(s): ${unsupported.join(' ')}`);
  process.exit(1);
}

info(`Processing config in ${projectName} for ${instanceUrl}.`);
info('Actions:\n     -', actions.join('\n     - '));
info('Extra args:', extraArgs);

return actions.reduce((promiseChain, action) =>
    promiseChain
      .then(() => info(`Starting action: ${action}…`))
      .then(() => require(`../src/fn/${action}`)('.', couchUrl, extraArgs))
      .then(() => info(`${action} complete.`)),
    Promise.resolve())
  .then(() => { if(actions.length > 1) info('All actions completed.'); })
  .catch(e => {
    error(e);
    process.exit(1);
  });
