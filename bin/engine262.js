#!/usr/bin/env node

'use strict';

require('@snek/source-map-support/register');
const repl = require('repl');
const fs = require('fs');
const path = require('path');
const util = require('util');
const snekparse = require('./snekparse');
const {
  inspect,
  Agent,
  Realm,
  Completion,
  AbruptCompletion,
  Value,
  Object: APIObject,
  Abstract,
  Throw,
  ToString,
  FEATURES,
} = require('..');

function createRealm() {
  const moduleCache = new Map();
  const realm = new Realm({
    resolveImportedModule(referencingModule, specifier) {
      const resolved = path.resolve(path.dirname(referencingModule.specifier), specifier);
      if (realm.moduleEntry && resolved === realm.moduleEntry.specifier) {
        return realm.moduleEntry;
      }
      if (moduleCache.has(resolved)) {
        return moduleCache.get(resolved);
      }
      if (!fs.existsSync(resolved)) {
        return Throw(realm, 'Error', `Cannot resolve module ${specifier}`);
      }
      const source = fs.readFileSync(resolved, 'utf8');
      const m = realm.createSourceTextModule(resolved, source);
      moduleCache.set(resolved, m);
      return m;
    },
  });

  const print = new Value(realm, (args) => {
    for (const arg of args) {
      const s = ToString(realm, arg);
      if (s instanceof AbruptCompletion) {
        return s;
      }
      process.stdout.write(s);
      process.stdout.write(' ');
    }
    process.stdout.write('\n');
    return Value.undefined;
  }, [], realm);
  Abstract.CreateDataProperty(realm.global, new Value(realm, 'print'), print);

  {
    const console = new APIObject(realm);
    Abstract.CreateDataProperty(realm.global, new Value(realm, 'console'), console);

    const format = (args) => args.map((a, i) => {
      if (i === 0 && Abstract.Type(a) === 'String') {
        return a.stringValue();
      }
      return inspect(a, realm);
    }).join(' ');

    const log = new Value(realm, (args) => {
      process.stdout.write(`${format(args)}\n`);
      return Value.undefined;
    });

    Abstract.CreateDataProperty(console, new Value(realm, 'log'), log);

    const error = new Value(realm, (args) => {
      process.stderr.write(`${format(args)}\n`);
      return Value.undefined;
    });

    Abstract.CreateDataProperty(console, new Value(realm, 'error'), error);

    const debug = new Value(realm, (args) => {
      process.stderr.write(`${util.format(...args)}\n`);
      return Value.undefined;
    });

    Abstract.CreateDataProperty(console, new Value(realm, 'debug'), debug);
  }

  const $ = new APIObject(realm);
  realm.$ = $;

  Abstract.CreateDataProperty($, new Value(realm, 'global'), realm.global);
  Abstract.CreateDataProperty($, new Value(realm, 'createRealm'), new Value(realm, () => {
    const r = createRealm();
    return r.$;
  }));
  Abstract.CreateDataProperty($, new Value(realm, 'evalScript'),
    new Value(realm, ([sourceText]) => realm.evaluateScript(sourceText.stringValue())));

  Abstract.CreateDataProperty(realm.global, new Value(realm, '$'), $);
  Abstract.CreateDataProperty(realm.global, new Value(realm, '$262'), $);

  return realm;
}

const help = `
engine262 v${require('../package.json').version}

Usage:

    engine262 [options]
    engine262 [options] [input file]
    engine262 [input file]

Options:

    -h, --help      Show help (this screen)
    -m, --module    Evaluate contents of input-file as a module.
                    Must be followed by input-file
    --features=...  A comma separated list of features. If no features
                    are provided, the available features are listed.

`;

const argv = snekparse(process.argv.slice(2));

if (argv.h || argv.help) {
  process.stdout.write(help);
  process.exit(0);
} else if (argv.features === true) {
  FEATURES.forEach(({ name, url }) => {
    process.stdout.write(`${name} - ${url}\n`);
  });
  process.exit(0);
}

let features;
if (argv.features === 'all') {
  features = FEATURES.map((f) => f.name);
} else if (argv.features) {
  features = argv.features.split(',');
} else {
  features = [];
}

const agent = new Agent({ features });
agent.enter();

const realm = createRealm();

if (argv.length === 0) {
  repl.start({
    prompt: '> ',
    eval: (cmd, context, filename, callback) => {
      const result = realm.evaluateScript(cmd, { specifier: process.cwd() });
      callback(null, result);
    },
    completer: () => [],
    writer: (o) => {
      if (o instanceof Value || o instanceof Completion) {
        return inspect(o, realm);
      }
      return util.inspect(o);
    },
  });
} else {
  const lastArg = argv[argv.length - 1];
  const source = fs.readFileSync(lastArg, 'utf8');
  let result;
  if (argv.m || argv.module || lastArg.endsWith('.mjs')) {
    result = realm.createSourceTextModule(path.resolve(lastArg), source);
    if (!(result instanceof AbruptCompletion)) {
      const module = result;
      realm.moduleEntry = module;
      result = module.Link();
      if (!(result instanceof AbruptCompletion)) {
        result = module.Evaluate();
      }
      if (!(result instanceof AbruptCompletion)) {
        if (result.PromiseState === 'rejected') {
          result = Throw(realm, result.PromiseResult);
        }
      }
    }
  } else {
    result = realm.evaluateScript(source, { specifier: path.resolve(lastArg) });
  }
  if (result instanceof AbruptCompletion) {
    let inspected;
    if (Abstract.Type(result.Value) === 'Object') {
      const errorToString = realm.realm.Intrinsics['%Error.prototype%'].properties.get(new Value(realm, 'toString')).Value;
      inspected = Abstract.Call(errorToString, result.Value).stringValue();
    } else {
      inspected = inspect(result, realm);
    }
    process.stderr.write(`${inspected}\n`);
    process.exit(1);
  } else {
    process.exit(0);
  }
}
